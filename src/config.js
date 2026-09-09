'use strict';

require('dotenv').config();

const path = require('path');

const ROOT = path.join(__dirname, '..');

module.exports = {
  ROOT,
  COMFY_URL: process.env.COMFY_URL || 'http://127.0.0.1:8188',
  PORT: Number(process.env.PORT) || 3000,
  JOB_TIMEOUT_MS: Number(process.env.JOB_TIMEOUT_MS) || 600000,
  DATA_DIR: path.join(ROOT, 'data'),
  DB_PATH: path.join(ROOT, 'data', 'eval.sqlite'),
  OUTPUTS_DIR: path.join(ROOT, 'data', 'outputs'),
  REFS_DIR: path.join(ROOT, 'data', 'refs'),
  PROD_DIR: path.join(ROOT, 'data', 'prod'),
  CSV_DIR: path.join(ROOT, 'data', 'csv'),
  WORKFLOWS_DIR: path.join(ROOT, 'workflows'),
};
