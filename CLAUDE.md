# comfyui-eval

Internal QA tool: replays real production AI-image prompts (sampled from a usage CSV export) against a local/test ComfyUI instance and serves an admin site to compare the production image with the locally generated one side by side, with A/B ratings. Purpose: evaluate candidate image models/workflows against what production shipped.

## Architecture (plain Node.js, no framework beyond Express)

- `src/sample.js` — streams a usage CSV, splits rows into text-only vs with-reference-images, seeded-randomly samples a bulk (default 100, 50/50 split) into SQLite. Each bulk = one row in `runs`.
- `src/runner.js` — sequential generation loop. Per instance: reuse check → download/cache refs → upload refs to ComfyUI → instantiate workflow template → prune empty-ref nodes → queue → wait → save output. Resumable: re-running a run only processes `pending`/`failed` instances.
- `src/comfy.js` — ComfyUI client (HTTP + websocket, with `/history` polling fallback), `instantiateWorkflow` (placeholder substitution), `pruneEmptyRefNodes`.
- `src/server.js` — Express admin API + static UI (`public/index.html`, vanilla JS single page).
- `src/db.js` — better-sqlite3, schema + additive `ALTER TABLE` migrations. DB at `data/eval.sqlite`.

## Key concepts

- **Workflows are user-provided ComfyUI API-format JSON** stored in the `workflows` DB table (uploaded via UI) or as `workflows/text2img.json` / `workflows/edit.json` on disk (fallback). GUI-format exports (`{nodes, links}`) do NOT work — only API format (`{"<id>": {class_type, inputs}}`).
- **Placeholders** substituted per instance: `%%PROMPT%%`, `%%STYLE%%`, `%%STYLE_SUFFIX%%` (`", <style>"` or empty), `%%SEED%%` (a string that is exactly `%%SEED%%` becomes a number), `%%REF_1%%`–`%%REF_3%%` (filenames after upload to ComfyUI's input dir). Substitution is object-level (`instantiateWorkflow`), so JSON escaping is automatic.
- **Two workflow kinds**: `text2img` (rows without ref images) and `edit` (rows with refs). Uploads are validated: an edit workflow must contain `%%REF_1%%`, a text2img must not.
- **Empty-ref pruning**: rows with fewer refs than the workflow has slots work because `pruneEmptyRefNodes` removes LoadImage nodes whose ref is empty and cascades using `/object_info` required/optional specs.
- **Reuse cache**: before generating, the runner looks up `gen_key` = sha1(kind|prompt|style|refs|workflow-content-hash); an existing done image is reused (`reused=1`) instead of regenerated. Prod images cached in `data/prod/`, refs in `data/refs/` (keyed by URL sha1), outputs in `data/outputs/`.
- **Bulk resampling**: `POST /api/runs/:id/resample` samples a new bulk from the same CSV, by default excluding every prompt+refs row ever sampled (any run). New bulks get a random seed (stored, reproducible).

## Deployments (two independent copies — separate DBs, results don't sync)

- **Local dev**: this repo, `COMFY_URL=http://127.0.0.1:18011 npm run serve` (18011 = SSH tunnel to gen22's ComfyUI: `ssh -i ~/.ssh/ai -o IdentitiesOnly=yes -p 22001 -f -N -L 18011:localhost:8011 node@69.197.165.120`).
- **Worker (primary in practice)**: gen22 box, `/workspace/comfyui-eval`, started with `COMFY_URL=http://127.0.0.1:8011 PORT=3000`, admin page public at http://69.197.165.120:3000 (no auth!). Deploy by tar-over-ssh of `src public` (no rsync on the box), then kill/restart `node src/server.js` there.
- ComfyUI on gen22 binds 127.0.0.1 only; GUI instance is port 8011 (8188 is the ai-image-worker's instance, often down).

## Gotchas

- Restart the server after pulling code — it's a plain `node src/server.js`, nothing watches files.
- `data/` and real workflow JSONs are gitignored; only `workflows/*.example.json` are committed.
- The usage CSV has multi-line quoted prompts (`wc -l` wildly overcounts rows) and literal `"null"` strings for empty fields.
- Pixaroma custom nodes serialize their UI state as JSON-in-a-string hidden inputs (`SeedState`, `PromptState`, …) — never inject placeholders inside those; wire values directly into consumer nodes instead (see git history: GUI→API conversion).
- KSampler is one job at a time by design (single GPU); don't add concurrency.
