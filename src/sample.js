'use strict';

const fs = require('fs');
const path = require('path');
const { parse } = require('csv-parse');
const db = require('./db');

const nullish = (v) => {
  const s = (v || '').trim();
  return !s || s.toLowerCase() === 'null' ? null : s;
};

// Deterministic PRNG so the same seed always draws the same sample.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function parseCsv(csvPath) {
  return new Promise((resolve, reject) => {
    const textRows = [];
    const refRows = [];
    fs.createReadStream(csvPath)
      .pipe(parse({ columns: true, bom: true, relaxColumnCount: true, skipEmptyLines: true }))
      .on('data', (row) => {
        const prompt = nullish(row.prompt);
        const prodImageUrl = nullish(row.filePath);
        if (!prompt || !prodImageUrl || !/^https?:\/\//.test(prodImageUrl)) return;
        const instance = {
          prompt,
          style: nullish(row.style),
          plan: nullish(row.plan),
          model: nullish(row.model),
          fileCreatedAt: nullish(row['fileCreatedAt (Date Hour)']),
          prodImageUrl,
          ref1: nullish(row.first_ref_image),
          ref2: nullish(row.second_ref_image),
          ref3: nullish(row.third_ref_image),
        };
        (instance.ref1 ? refRows : textRows).push(instance);
      })
      .on('end', () => resolve({ textRows, refRows }))
      .on('error', reject);
  });
}

async function sampleCsv({ csvPath, name, count = 100, seed = 42 }) {
  const { textRows, refRows } = await parseCsv(csvPath);
  const rand = mulberry32(seed);
  const half = Math.floor(count / 2);

  const shuffledText = shuffle(textRows, rand);
  const shuffledRef = shuffle(refRows, rand);
  // 50/50 split; if one bucket is short, fill the gap from the other.
  let pickText = Math.min(half, shuffledText.length);
  let pickRef = Math.min(count - pickText, shuffledRef.length);
  pickText = Math.min(count - pickRef, shuffledText.length);

  const picked = [
    ...shuffledText.slice(0, pickText).map((r) => ({ ...r, kind: 'text' })),
    ...shuffledRef.slice(0, pickRef).map((r) => ({ ...r, kind: 'ref' })),
  ];

  const insertRun = db.prepare(
    'INSERT INTO runs (name, csv_path, sample_seed) VALUES (?, ?, ?)'
  );
  const insertInstance = db.prepare(`
    INSERT INTO instances (
      run_id, kind, prompt, style, plan, model, file_created_at,
      prod_image_url, ref_1, ref_2, ref_3
    ) VALUES (
      @runId, @kind, @prompt, @style, @plan, @model, @fileCreatedAt,
      @prodImageUrl, @ref1, @ref2, @ref3
    )
  `);

  const runId = db.transaction(() => {
    const { lastInsertRowid } = insertRun.run(name, csvPath, seed);
    for (const instance of picked) {
      insertInstance.run({ runId: lastInsertRowid, ...instance });
    }
    return Number(lastInsertRowid);
  })();

  return {
    runId,
    name,
    total: picked.length,
    text: picked.filter((r) => r.kind === 'text').length,
    ref: picked.filter((r) => r.kind === 'ref').length,
    poolText: textRows.length,
    poolRef: refRows.length,
  };
}

module.exports = { sampleCsv };

if (require.main === module) {
  const args = process.argv.slice(2);
  const csvPath = args.find((a) => !a.startsWith('--'));
  const flag = (n, def) => {
    const i = args.indexOf(`--${n}`);
    return i !== -1 ? args[i + 1] : def;
  };
  if (!csvPath) {
    console.error('Usage: node src/sample.js <csv> [--name <name>] [--count 100] [--seed 42]');
    process.exit(1);
  }
  sampleCsv({
    csvPath: path.resolve(csvPath),
    name: flag('name', path.basename(csvPath, path.extname(csvPath))),
    count: Number(flag('count', 100)),
    seed: Number(flag('seed', 42)),
  })
    .then((res) => {
      console.log(
        `Run #${res.runId} "${res.name}": sampled ${res.total} instances ` +
          `(${res.text} text-only, ${res.ref} with refs) ` +
          `from pools of ${res.poolText} text / ${res.poolRef} ref rows`
      );
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
