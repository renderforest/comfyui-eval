'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { sampleCsv } = require('./sample');
const { runPending, isRunActive } = require('./runner');
const { PORT, OUTPUTS_DIR, PROD_DIR, CSV_DIR, ROOT, WORKFLOWS_DIR } = require('./config');

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

app.post('/api/upload', upload.single('csv'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No csv file provided' });
    const named = path.join(CSV_DIR, `${Date.now()}_${req.file.originalname}`);
    fs.renameSync(req.file.path, named);
    const result = await sampleCsv({
      csvPath: named,
      name: req.body.name || req.file.originalname.replace(/\.csv$/i, ''),
      count: Number(req.body.count) || 100,
      seed: Number(req.body.seed) || 42,
    });
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
    const warnings = [];
    if (!raw.includes('%%PROMPT%%')) warnings.push('no %%PROMPT%% placeholder found');
    if (kind === 'edit' && !raw.includes('%%REF_1%%')) warnings.push('no %%REF_1%% placeholder found');
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
