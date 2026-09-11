'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { sampleCsv, rowKey } = require('./sample');
const { runPending, isRunActive, requestStop, urlCacheName } = require('./runner');
const { PORT, OUTPUTS_DIR, PROD_DIR, REFS_DIR, CSV_DIR, ROOT, WORKFLOWS_DIR, COMFY_URL } = require('./config');

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT, 'public')));
app.use('/outputs', express.static(OUTPUTS_DIR));
app.use('/prod', express.static(PROD_DIR));

fs.mkdirSync(CSV_DIR, { recursive: true });
const upload = multer({ dest: CSV_DIR, limits: { fileSize: 500 * 1024 * 1024 } });

const runStats = db.prepare(`
  SELECT
    COUNT(*) AS total,
    SUM(status = 'done') AS done,
    SUM(status = 'failed') AS failed,
    SUM(status = 'running') AS running,
    SUM(rating = 'prod') AS rated_prod,
    SUM(rating = 'local') AS rated_local,
    SUM(rating = 'tie') AS rated_tie
  FROM instances WHERE run_id = ?
`);

const withStats = (run) => ({ ...run, ...runStats.get(run.id), active: isRunActive(run.id) });

app.get('/api/runs', (req, res) => {
  const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC').all();
  res.json(runs.map(withStats));
});

app.get('/api/runs/:id', (req, res) => {
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  res.json(withStats(run));
});

app.get('/api/runs/:id/instances', (req, res) => {
  const instances = db
    .prepare('SELECT * FROM instances WHERE run_id = ? ORDER BY id')
    .all(req.params.id);
  res.json(instances);
});

// prompt+refs of every instance ever sampled — used to avoid re-testing the same rows
function usedRowKeys() {
  const rows = db.prepare('SELECT prompt, ref_1, ref_2, ref_3 FROM instances').all();
  return new Set(
    rows.map((r) => rowKey({ prompt: r.prompt, ref1: r.ref_1, ref2: r.ref_2, ref3: r.ref_3 }))
  );
}

app.post('/api/upload', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No csv file provided' });
    const named = path.join(CSV_DIR, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, named);
    const result = await sampleCsv({
      csvPath: named,
      name: req.body.name || req.file.originalname.replace(/\.csv$/i, ''),
      count: Number(req.body.count) || 100,
      seed: req.body.seed ? Number(req.body.seed) : undefined,
      textPercent: req.body.textPercent ? Number(req.body.textPercent) : 50,
      excludeKeys: req.body.excludeExisting === 'true' ? usedRowKeys() : null,
    });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// new bulk from an existing run's CSV
app.post('/api/runs/:id/resample', async (req, res) => {
  try {
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    if (!fs.existsSync(run.csv_path)) {
      return res.status(400).json({ error: `Source CSV no longer exists: ${run.csv_path}` });
    }
    const { count, seed, excludeExisting = true, textPercent } = req.body || {};
    const bulkNo = db.prepare('SELECT COUNT(*) AS c FROM runs WHERE csv_path = ?').get(run.csv_path).c + 1;
    const result = await sampleCsv({
      csvPath: run.csv_path,
      name: req.body.name || `${run.name} · bulk ${bulkNo}`,
      count: Number(count) || 100,
      seed: seed ? Number(seed) : undefined,
      textPercent: textPercent ? Number(textPercent) : 50,
      excludeKeys: excludeExisting ? usedRowKeys() : null,
    });
    // carry the workflow selection over to the new bulk
    db.prepare('UPDATE runs SET text_workflow_id = ?, edit_workflow_id = ? WHERE id = ?').run(
      run.text_workflow_id,
      run.edit_workflow_id,
      result.runId
    );
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---- workflow library ----

const uploadWorkflow = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

app.get('/api/workflows', (req, res) => {
  res.json(db.prepare('SELECT id, name, kind, created_at FROM workflows ORDER BY id DESC').all());
});

app.post('/api/workflows', uploadWorkflow.single('workflow'), (req, res) => {
  try {
    const { kind } = req.body || {};
    if (!['text2img', 'edit'].includes(kind)) {
      return res.status(400).json({ error: 'kind must be text2img|edit' });
    }
    const raw = req.file ? req.file.buffer.toString('utf8') : JSON.stringify(req.body.json);
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'Not valid JSON' });
    }
    const nodes = Object.values(parsed).filter((v) => v && typeof v === 'object' && v.class_type);
    if (!nodes.length) {
      return res.status(400).json({
        error: 'No ComfyUI nodes found — export the workflow in API format (Dev mode → "Save (API Format)")',
      });
    }
    // Placeholder workflows are validated for kind mix-ups; raw API exports
    // (no %%…%% at all) are accepted and auto-injected at run time.
    const usesPlaceholders = raw.includes('%%');
    const hasLoadImage = nodes.some((n) => /LoadImage/i.test(n.class_type));
    if (usesPlaceholders) {
      const hasRef = raw.includes('%%REF_1%%');
      if (kind === 'edit' && !hasRef) {
        return res.status(400).json({
          error:
            'This file has no %%REF_1%% placeholder — it looks like a text → image workflow. ' +
            'Use the Upload button on the "Text → image" row instead.',
        });
      }
      if (kind === 'text2img' && hasRef) {
        return res.status(400).json({
          error:
            'This file contains %%REF_1%% — it looks like an image → image (edit) workflow. ' +
            'Use the Upload button on the "Image → image" row instead.',
        });
      }
    } else if (kind === 'edit' && !hasLoadImage) {
      return res.status(400).json({
        error: 'An image → image workflow needs at least one LoadImage node for the reference image.',
      });
    }
    const warnings = [];
    if (!usesPlaceholders) {
      warnings.push('no placeholders — prompt/seed/refs will be auto-detected and injected at run time');
    }
    const name =
      req.body.name || (req.file ? req.file.originalname.replace(/\.json$/i, '') : `workflow-${Date.now()}`);
    const { lastInsertRowid } = db
      .prepare('INSERT INTO workflows (name, kind, json) VALUES (?, ?, ?)')
      .run(name, kind, raw);
    res.json({ id: Number(lastInsertRowid), name, kind, warnings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/workflows/:id', (req, res) => {
  db.prepare('UPDATE runs SET text_workflow_id = NULL WHERE text_workflow_id = ?').run(req.params.id);
  db.prepare('UPDATE runs SET edit_workflow_id = NULL WHERE edit_workflow_id = ?').run(req.params.id);
  const result = db.prepare('DELETE FROM workflows WHERE id = ?').run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Workflow not found' });
  res.json({ ok: true });
});

// ---- runs ----

app.post('/api/runs/:id/start', (req, res) => {
  const runId = Number(req.params.id);
  if (isRunActive(runId)) return res.status(409).json({ error: 'Run already in progress' });
  const run = db.prepare('SELECT id FROM runs WHERE id = ?').get(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });

  const { textWorkflowId, editWorkflowId } = req.body || {};
  db.prepare('UPDATE runs SET text_workflow_id = ?, edit_workflow_id = ? WHERE id = ?').run(
    textWorkflowId || null,
    editWorkflowId || null,
    runId
  );

  const kinds = db
    .prepare("SELECT DISTINCT kind FROM instances WHERE run_id = ? AND status != 'done'")
    .all(runId)
    .map((r) => r.kind);
  const workflowExists = (id) => id && db.prepare('SELECT id FROM workflows WHERE id = ?').get(id);
  const missing = [
    kinds.includes('text') &&
      !workflowExists(textWorkflowId) &&
      !fs.existsSync(path.join(WORKFLOWS_DIR, 'text2img.json')) &&
      'text2img',
    kinds.includes('ref') &&
      !workflowExists(editWorkflowId) &&
      !fs.existsSync(path.join(WORKFLOWS_DIR, 'edit.json')) &&
      'edit',
  ].filter(Boolean);
  if (missing.length) {
    return res.status(400).json({
      error: `No ${missing.join(' and ')} workflow — upload one above (API format with %%PROMPT%%/%%SEED%%/%%REF_1%% placeholders) or drop it into workflows/`,
    });
  }
  // fire-and-forget; UI polls for progress
  runPending({ runId }).catch((err) => console.error(`Run ${runId} failed: ${err.message}`));
  res.json({ started: true, runId });
});

// delete a run and every file no other run still references
app.delete('/api/runs/:id', (req, res) => {
  const runId = Number(req.params.id);
  if (isRunActive(runId)) return res.status(409).json({ error: 'Stop the run before deleting it' });
  const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
  if (!run) return res.status(404).json({ error: 'Run not found' });
  const instances = db.prepare('SELECT * FROM instances WHERE run_id = ?').all(runId);

  db.transaction(() => {
    db.prepare('DELETE FROM instances WHERE run_id = ?').run(runId);
    db.prepare('DELETE FROM runs WHERE id = ?').run(runId);
  })();

  let files = 0;
  let bytes = 0;
  const tryUnlink = (dir, name) => {
    const p = path.join(dir, name);
    try {
      const size = fs.statSync(p).size;
      fs.unlinkSync(p);
      files++;
      bytes += size;
    } catch {
      // already gone
    }
  };
  const outputUsed = db.prepare('SELECT 1 FROM instances WHERE output_path = ? LIMIT 1');
  const prodUsed = db.prepare('SELECT 1 FROM instances WHERE prod_image_path = ? LIMIT 1');
  const refUsed = db.prepare('SELECT 1 FROM instances WHERE ref_1 = ? OR ref_2 = ? OR ref_3 = ? LIMIT 1');
  for (const i of instances) {
    if (i.output_path && !outputUsed.get(i.output_path)) tryUnlink(OUTPUTS_DIR, i.output_path);
    if (i.prod_image_path && !prodUsed.get(i.prod_image_path)) tryUnlink(PROD_DIR, i.prod_image_path);
    for (const url of [i.ref_1, i.ref_2, i.ref_3]) {
      if (url && !refUsed.get(url, url, url)) tryUnlink(REFS_DIR, urlCacheName(url));
    }
  }
  // uploaded CSV: remove when this was the last run sampled from it
  if (
    run.csv_path &&
    run.csv_path.startsWith(CSV_DIR) &&
    !db.prepare('SELECT 1 FROM runs WHERE csv_path = ? LIMIT 1').get(run.csv_path)
  ) {
    tryUnlink(path.dirname(run.csv_path), path.basename(run.csv_path));
  }
  res.json({ deleted: runId, files, mbFreed: Math.round((bytes / 1024 / 1024) * 10) / 10 });
});

app.post('/api/runs/:id/stop', async (req, res) => {
  const runId = Number(req.params.id);
  if (!requestStop(runId)) return res.status(409).json({ error: 'Run is not in progress' });
  // abort the job currently executing on ComfyUI; the loop stops after it
  try {
    await fetch(`${COMFY_URL}/interrupt`, { method: 'POST' });
  } catch {
    // ComfyUI unreachable — the loop still stops before the next instance
  }
  res.json({ stopping: true, runId });
});

app.post('/api/instances/:id/rating', (req, res) => {
  const { rating } = req.body || {};
  if (!['prod', 'local', 'tie', null].includes(rating)) {
    return res.status(400).json({ error: 'rating must be prod|local|tie|null' });
  }
  const result = db.prepare('UPDATE instances SET rating = ? WHERE id = ?').run(rating, req.params.id);
  if (!result.changes) return res.status(404).json({ error: 'Instance not found' });
  res.json({ ok: true });
});

app.listen(PORT, () => console.log(`comfyui-eval admin: http://localhost:${PORT}`));
