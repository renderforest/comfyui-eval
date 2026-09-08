'use strict';

const crypto = require('crypto');
const WebSocket = require('ws');

class ComfyClient {
  constructor({ baseUrl, timeoutMs = 600000 }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}/ws`;
    this.timeoutMs = timeoutMs;
    this.clientId = crypto.randomUUID();
    this.ws = null;
    this.listeners = new Set();
  }

  async connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.wsUrl}?clientId=${this.clientId}`);
      ws.on('open', () => {
        this.ws = ws;
        resolve();
      });
      ws.on('error', reject);
      ws.on('message', (raw) => {
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return; // binary preview frames
        }
        for (const listener of this.listeners) listener(msg);
      });
      ws.on('close', () => {
        this.ws = null;
      });
    });
  }

  close() {
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  async getObjectInfo() {
    if (!this._objectInfo) {
      const res = await fetch(`${this.baseUrl}/object_info`);
      if (!res.ok) throw new Error(`GET /object_info failed: ${res.status}`);
      this._objectInfo = await res.json();
    }
    return this._objectInfo;
  }

  async uploadImage({ buffer, filename }) {
    const form = new FormData();
    form.append('image', new Blob([buffer]), filename);
    form.append('overwrite', 'true');
    const res = await fetch(`${this.baseUrl}/upload/image`, { method: 'POST', body: form });
    if (!res.ok) throw new Error(`upload/image failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    return json.subfolder ? `${json.subfolder}/${json.name}` : json.name;
  }

  async queuePrompt(workflow) {
    const res = await fetch(`${this.baseUrl}/prompt`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: workflow, client_id: this.clientId }),
    });
    if (!res.ok) throw new Error(`POST /prompt failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    if (!json.prompt_id) throw new Error(`POST /prompt returned no prompt_id: ${JSON.stringify(json)}`);
    return json.prompt_id;
  }

  async getHistory(promptId) {
    const res = await fetch(`${this.baseUrl}/history/${promptId}`);
    if (!res.ok) throw new Error(`GET /history failed: ${res.status}`);
    const json = await res.json();
    return json[promptId] || null;
  }

  // Resolves when the prompt finishes: websocket events are the fast path,
  // /history polling the fallback in case the socket drops mid-job.
  waitForCompletion(promptId) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, arg) => {
        if (settled) return;
        settled = true;
        this.listeners.delete(onMessage);
        clearInterval(pollTimer);
        clearTimeout(killTimer);
        fn(arg);
      };

      const onMessage = (msg) => {
        const data = msg.data || {};
        if (data.prompt_id !== promptId) return;
        if (msg.type === 'execution_error') {
          finish(reject, new Error(`ComfyUI execution error: ${data.exception_message || JSON.stringify(data)}`));
        } else if (
          msg.type === 'execution_success' ||
          (msg.type === 'executing' && data.node === null)
        ) {
          finish(resolve);
        }
      };
      this.listeners.add(onMessage);

      const pollTimer = setInterval(async () => {
        try {
          const history = await this.getHistory(promptId);
          if (!history) return;
          const status = history.status || {};
          if (status.status_str === 'error') {
            finish(reject, new Error('ComfyUI execution error (from history)'));
          } else if (status.completed || Object.keys(history.outputs || {}).length) {
            finish(resolve);
          }
        } catch {
          // ComfyUI briefly unreachable; keep polling
        }
      }, 3000);

      const killTimer = setTimeout(
        () => finish(reject, new Error(`Timed out after ${this.timeoutMs}ms waiting for ${promptId}`)),
        this.timeoutMs
      );
    });
  }

  async fetchOutputImage(promptId) {
    const history = await this.getHistory(promptId);
    if (!history) throw new Error(`No history for prompt ${promptId}`);
    for (const nodeOutput of Object.values(history.outputs || {})) {
      const image = (nodeOutput.images || []).find((i) => i.type === 'output') || (nodeOutput.images || [])[0];
      if (!image) continue;
      const params = new URLSearchParams({
        filename: image.filename,
        subfolder: image.subfolder || '',
        type: image.type || 'output',
      });
      const res = await fetch(`${this.baseUrl}/view?${params}`);
      if (!res.ok) throw new Error(`GET /view failed: ${res.status}`);
      return { buffer: Buffer.from(await res.arrayBuffer()), filename: image.filename };
    }
    throw new Error(`Prompt ${promptId} finished but produced no images`);
  }
}

// Replaces %%PLACEHOLDER%% tokens inside a workflow template.
// A string that is exactly one placeholder keeps the raw value's type
// (so "%%SEED%%" becomes a number); otherwise substitution is textual.
function instantiateWorkflow({ template, values }) {
  const walk = (v) => {
    if (typeof v === 'string') {
      const exact = v.match(/^%%([A-Z0-9_]+)%%$/);
      if (exact && exact[1] in values) return values[exact[1]];
      return v.replace(/%%([A-Z0-9_]+)%%/g, (m, key) =>
        key in values ? String(values[key] ?? '') : m
      );
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    }
    return v;
  };
  return walk(template);
}

// Removes LoadImage-style nodes whose image resolved to an empty string
// (a row with fewer refs than the workflow has slots), then cascades:
// downstream references to removed nodes are dropped when the input is
// optional, or remove the referencing node too when it is required.
function pruneEmptyRefNodes({ workflow, objectInfo }) {
  const removed = new Set(
    Object.entries(workflow)
      .filter(([, n]) => /LoadImage/i.test(n.class_type) && n.inputs.image === '')
      .map(([id]) => id)
  );
  if (!removed.size) return workflow;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, node] of Object.entries(workflow)) {
      if (removed.has(id)) continue;
      for (const [name, value] of Object.entries(node.inputs)) {
        if (!Array.isArray(value) || value.length !== 2 || !removed.has(String(value[0]))) continue;
        const spec = (objectInfo[node.class_type] || {}).input || {};
        if (spec.required && name in spec.required) {
          removed.add(id);
          changed = true;
          break;
        }
        delete node.inputs[name];
      }
    }
  }
  return Object.fromEntries(Object.entries(workflow).filter(([id]) => !removed.has(id)));
}

module.exports = { ComfyClient, instantiateWorkflow, pruneEmptyRefNodes };
