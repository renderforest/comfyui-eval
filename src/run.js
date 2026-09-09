'use strict';

const db = require('./db');
const { runPending } = require('./runner');

const runId =
  Number(process.argv[2]) ||
  (db.prepare('SELECT id FROM runs ORDER BY id DESC LIMIT 1').get() || {}).id;

if (!runId) {
  console.error('No runs found. Create one first: npm run sample -- <csv>');
  process.exit(1);
}

runPending({
  runId,
  onProgress: ({ instanceId, status }) => console.log(`instance ${instanceId}: ${status}`),
})
  .then(({ processed, done, failed, reused }) => {
    console.log(`Run ${runId} finished: ${processed} processed, ${done} done (${reused} reused), ${failed} failed`);
    process.exit(failed ? 2 : 0);
  })
  .catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
