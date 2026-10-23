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

// Looker export keeps every ref in a JSON array column (`refMediaJson`, literal
// "null" when empty) plus the first one in `refImage`; usage exports have
// first/second/third_ref_image. Extra refs beyond the 3 workflow slots are dropped.
function refsOf(row) {
  const json = nullish(row.refMediaJson);
  if (json) {
    try {
      const urls = JSON.parse(json);
      if (Array.isArray(urls)) return urls.map(nullish).filter(Boolean).slice(0, 3);
    } catch {
      // malformed JSON — fall through to the single-ref column
    }
  }
  if (row.refImage !== undefined) return [nullish(row.refImage)].filter(Boolean);
  return [row.first_ref_image, row.second_ref_image, row.third_ref_image].map(nullish).filter(Boolean);
}

function parseCsv(csvPath) {
  return new Promise((resolve, reject) => {
    const textRows = [];
    const refRows = [];
    fs.createReadStream(csvPath)
      .pipe(parse({ columns: true, bom: true, relaxColumnCount: true, skipEmptyLines: true }))
      .on('data', (row) => {
        const prompt = nullish(row.prompt);
        // `filePath_` / `createdAt` are the Looker export's names for the same fields
        const prodImageUrl = nullish(row.filePath) || nullish(row.filePath_);
        if (!prompt || !prodImageUrl || !/^https?:\/\//.test(prodImageUrl)) return;
        const [ref1 = null, ref2 = null, ref3 = null] = refsOf(row);
        const instance = {
          prompt,
          style: nullish(row.style),
          stylePrompt: nullish(row.stylePrompt),
          plan: nullish(row.plan),
          model: nullish(row.model),
          fileCreatedAt: nullish(row['fileCreatedAt (Date Hour)']) || nullish(row.createdAt),
          prodImageUrl,
          ref1,
          ref2,
          ref3,
        };
        (instance.ref1 ? refRows : textRows).push(instance);
      })
      .on('end', () => resolve({ textRows, refRows }))
      .on('error', reject);
  });
}

const rowKey = (r) =>
  [r.prompt, r.ref1 || '', r.ref2 || '', r.ref3 || ''].join('|');

async function sampleCsv({ csvPath, name, count = 100, seed, excludeKeys = null, textPercent = 50 }) {
  if (seed == null) seed = Math.floor(Math.random() * 2 ** 31);
  let { textRows, refRows } = await parseCsv(csvPath);
  if (excludeKeys && excludeKeys.size) {
    textRows = textRows.filter((r) => !excludeKeys.has(rowKey(r)));
    refRows = refRows.filter((r) => !excludeKeys.has(rowKey(r)));
  }
  const rand = mulberry32(seed);
  const pct = Math.min(100, Math.max(0, Number(textPercent)));
  const wantText = Math.round((count * pct) / 100);

  const shuffledText = shuffle(textRows, rand);
  const shuffledRef = shuffle(refRows, rand);
  // requested split; if one bucket is short, fill the gap from the other.
  let pickText = Math.min(wantText, shuffledText.length);
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
      run_id, kind, prompt, style, style_prompt, plan, model, file_created_at,
      prod_image_url, ref_1, ref_2, ref_3
    ) VALUES (
      @runId, @kind, @prompt, @style, @stylePrompt, @plan, @model, @fileCreatedAt,
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
    seed,
    total: picked.length,
    text: picked.filter((r) => r.kind === 'text').length,
    ref: picked.filter((r) => r.kind === 'ref').length,
    poolText: textRows.length,
    poolRef: refRows.length,
  };
}

module.exports = { sampleCsv, rowKey };

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
  const seedFlag = flag('seed', null);
  sampleCsv({
    csvPath: path.resolve(csvPath),
    name: flag('name', path.basename(csvPath, path.extname(csvPath))),
    count: Number(flag('count', 100)),
    seed: seedFlag == null ? undefined : Number(seedFlag),
    textPercent: Number(flag('text-percent', 50)),
  })
    .then((res) => {
      console.log(
        `Run #${res.runId} "${res.name}" (seed ${res.seed}): sampled ${res.total} instances ` +
          `(${res.text} text-only, ${res.ref} with refs) ` +
          `from pools of ${res.poolText} text / ${res.poolRef} ref rows`
      );
    })
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
