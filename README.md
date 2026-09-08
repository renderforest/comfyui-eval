# comfyui-eval

Replays real production AI-image prompts (from a usage CSV) against a local ComfyUI instance and serves an admin site to compare production images with locally generated ones side by side.

## Setup

```sh
npm install
```

Configuration is via environment variables (or a `.env` file), all optional:

| Var | Default | Meaning |
| --- | --- | --- |
| `COMFY_URL` | `http://127.0.0.1:8188` | ComfyUI base URL (same machine) |
| `PORT` | `3000` | Admin site port |
| `JOB_TIMEOUT_MS` | `600000` | Per-generation timeout |

### Workflows (required before generating)

Export your workflows from the ComfyUI GUI in **API format** (enable Dev mode → "Save (API Format)"). Two ways to provide them:

1. **Upload in the admin site** (recommended): "Upload workflow" form in the header, choose kind (`text2img` or `edit`). Uploaded workflows are stored in SQLite, appear in the dropdowns next to **Start generation**, and can be reused for any later run; each run remembers which workflows it was started with.
2. **Files on disk** (fallback, used when a dropdown is set to "— file on disk —"):
   - `workflows/text2img.json` — used for text-only rows
   - `workflows/edit.json` — used for rows with reference images

Insert placeholders where the runner should inject values:

- `%%PROMPT%%` — user prompt
- `%%STYLE%%` — style column (empty string when null)
- `%%SEED%%` — random seed; a string that is exactly `%%SEED%%` becomes a number
- `%%REF_1%%` / `%%REF_2%%` / `%%REF_3%%` — filenames of reference images uploaded to ComfyUI's input dir (wire into `LoadImage` nodes)

See `workflows/*.example.json` for the convention.

## Usage

```sh
# 1. Sample 100 instances (50 text-only / 50 with refs) from a CSV
npm run sample -- /path/to/usage.csv [--name my-run] [--count 100] [--seed 42]

# 2. Generate via ComfyUI (sequential, resumable — reruns only pending/failed)
npm run run            # latest run
npm run run -- 3       # specific run id

# 3. Admin site
npm run serve          # http://localhost:3000
```

Everything is also doable from the admin site: upload a CSV (creates a new run), press **Start generation**, watch progress live, zoom images, and rate each pair (prod better / local better / tie) — tallies show in the header.

Expected CSV columns: `fileCreatedAt (Date Hour), plan, model, style, prompt, filePath, first_ref_image, second_ref_image, third_ref_image` (`null` strings treated as empty). `filePath` is the production result image URL.

State lives in `data/eval.sqlite`; generated images in `data/outputs/`. Sampling is seeded, so the same CSV + seed always picks the same 100 rows.
