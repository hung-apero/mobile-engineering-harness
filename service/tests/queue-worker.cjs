const { openDb } = require('../src/db.cjs');
const jobs = require('../src/jobs.cjs');

const [mode, file, startAt] = process.argv.slice(2);
while (Date.now() < Number(startAt)) {}
const db = openDb(file);
if (mode === 'claim') {
  const limits = { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2 };
  const job = jobs.claimNext(db, { projects: new Set(['a', 'b']), limits, now: Date.parse('2026-11-25T20:00:00+07:00') });
  process.stdout.write(JSON.stringify(job ? job.id : null));
} else {
  process.stdout.write('ok');
}
