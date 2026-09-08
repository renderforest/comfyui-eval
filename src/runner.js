'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { ComfyClient, instantiateWorkflow } = require('./comfy');
const { COMFY_URL, JOB_TIMEOUT_MS, OUTPUTS_DIR, REFS_DIR, WORKFLOWS_DIR } = require('./config');

const activeRuns = new Set();

// strips helper keys like "_comment"; keeps only node entries
const onlyNodes = (template) =>
  Object.fromEntries(
    Object.entries(template).filter(([, v]) => v && typeof v === 'object' && v.class_type)
  );

// Uploaded workflow (by id) wins; falls back to workflows/<kind>.json on disk.
function loadWorkflow({ kind, workflowId }) {
  if (workflowId) {
    const row = db.prepare('SELECT json FROM workflows WHERE id = ?').get(workflowId);
    if (!row) throw new Error(`Workflow #${workflowId} not found in the library`);
    return onlyNodes(JSON.parse(row.json));
  }
  const name = kind === 'ref' ? 'edit' : 'text2img';
  const file = path.join(WORKFLOWS_DIR, `${name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(
      `No workflow selected for "${name}" and ${file} does not exist. ` +
        `Upload one in the admin site, or export your ComfyUI workflow in API format ` +
        `with %%PROMPT%% / %%STYLE%% / %%SEED%% / %%REF_1%%.. placeholders and save it there.`
    );
  }
  return onlyNodes(JSON.parse(fs.readFileSync(file, 'utf8')));
}

async function downloadRef({ url, instanceId, index }) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ref ${url}: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const filename = `ref_${instanceId}_${index}${ext}`;
  fs.mkdirSync(REFS_DIR, { recursive: true });
  fs.writeFileSync(path.join(REFS_DIR, filename), buffer);
  return { buffer, filename };
}

async function generateInstance({ client, instance, workflows }) {
  const seed = crypto.randomInt(0, 2 ** 31);
  const values = {
    PROMPT: instance.prompt,
    STYLE: instance.style || '',
    SEED: seed,
  };

  for (const [index, url] of [instance.ref_1, instance.ref_2, instance.ref_3].entries()) {
    if (!url) continue;
    const { buffer, filename } = await downloadRef({ url, instanceId: instance.id, index: index + 1 });
    values[`REF_${index + 1}`] = await client.uploadImage({ buffer, filename });
  }

  const template = instance.kind === 'ref' ? workflows.edit : workflows.text2img;
  const workflow = instantiateWorkflow({ template, values });

  const promptId = await client.queuePrompt(workflow);
  db.prepare('UPDATE instances SET comfy_prompt_id = ?, seed = ? WHERE id = ?').run(
    promptId,
    seed,
    instance.id
  );

  await client.waitForCompletion(promptId);
  const { buffer, filename } = await client.fetchOutputImage(promptId);

  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  const outName = `${instance.id}_${filename}`;
  fs.writeFileSync(path.join(OUTPUTS_DIR, outName), buffer);
  return outName;
}

async function runPending({ runId, onProgress = () => {} }) {
  if (activeRuns.has(runId)) throw new Error(`Run ${runId} is already in progress`);
  activeRuns.add(runId);
  try {
    const runRow = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!runRow) throw new Error(`Run ${runId} not found`);

    const kinds = db
      .prepare("SELECT DISTINCT kind FROM instances WHERE run_id = ? AND status != 'done'")
      .all(runId)
      .map((r) => r.kind);
    const workflows = {
      text2img: kinds.includes('text')
        ? loadWorkflow({ kind: 'text', workflowId: runRow.text_workflow_id })
        : null,
      edit: kinds.includes('ref')
        ? loadWorkflow({ kind: 'ref', workflowId: runRow.edit_workflow_id })
        : null,
    };

    const pending = db
      .prepare("SELECT * FROM instances WHERE run_id = ? AND status IN ('pending', 'failed') ORDER BY id")
      .all(runId);

    const client = new ComfyClient({ baseUrl: COMFY_URL, timeoutMs: JOB_TIMEOUT_MS });
    await client.connect();

    const setStatus = db.prepare(
      'UPDATE instances SET status = ?, error = ?, output_path = ?, duration_ms = ? WHERE id = ?'
    );

    let done = 0;
    let failed = 0;
    try {
      for (const instance of pending) {
        setStatus.run('running', null, instance.output_path, instance.duration_ms, instance.id);
        onProgress({ instanceId: instance.id, status: 'running' });
        const startedAt = Date.now();
        // one retry per instance — transient Comfy hiccups are common
        let lastError = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await client.connect();
            const outName = await generateInstance({ client, instance, workflows });
            setStatus.run('done', null, outName, Date.now() - startedAt, instance.id);
            done++;
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
          }
        }
        if (lastError) {
          setStatus.run('failed', String(lastError.message || lastError), null, Date.now() - startedAt, instance.id);
          failed++;
        }
        onProgress({ instanceId: instance.id, status: lastError ? 'failed' : 'done' });
      }
    } finally {
      client.close();
    }
    return { runId, processed: pending.length, done, failed };
  } finally {
    activeRuns.delete(runId);
  }
}

const isRunActive = (runId) => activeRuns.has(runId);

module.exports = { runPending, isRunActive };
