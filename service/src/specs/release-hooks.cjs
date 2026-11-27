const fs = require('node:fs');
const path = require('node:path');
const store = require('./store.cjs');
const files = require('./repo-files.cjs');
const { pathsFor } = require('../bugs/git.cjs');
const { isBuilding } = require('./build-kit.cjs');
const { fresh } = require('./segment.cjs');

const fileOf = ({ dzHome, project, id }) => path.join(pathsFor({ dzHome, project }).root, 'specs', `${id}-approved.md`);

function featuresPending(db, project, { version }) {
  return store.listSpecs(db, { project: project.key }).some(spec => isBuilding(spec) && spec.data.build?.version === version);
}

function keepApproved(run) {
  const latest = files.latestSpec(run.spec.data.repo);
  if (latest?.sha !== run.spec.approvedSha) return;
  const file = fileOf({ dzHome: run.ctx.dzHome, project: run.project, id: run.spec.id });
  const temp = `${file}.${process.pid}.tmp`;
  fs.rmSync(temp, { force: true });
  fs.writeFileSync(temp, latest.markdown, { mode: 0o600, flag: 'wx' });
  fs.renameSync(temp, file);
}

function approvedSpec(ctx, project) {
  const states = project.live === true ? ['done'] : ['done', 'landed-dry'];
  const last = store.listSpecs(ctx.db, { project: project.key, states }).at(-1);
  if (!last) return null;
  const file = fileOf({ dzHome: ctx.dzHome, project, id: last.id });
  return fs.lstatSync(file, { throwIfNoEntry: false })?.isFile() ? file : null;
}

function reopenLandedDry(db, project, version, now) {
  for (const spec of store.listSpecs(db, { project, states: ['landed-dry'] })) {
    const { build } = spec.data;
    if (build?.version !== version) continue;
    const { approved, ...trial } = build.trial;
    const data = { ...spec.data, ...fresh(spec, 'trial'), doneAt: null, build: { ...build, trial, landing: null, landingTries: 0 } };
    db.prepare("UPDATE specs SET state = 'po-trial', data = ?, updated_at = ? WHERE id = ? AND state = 'landed-dry'").run(JSON.stringify(data), now, spec.id);
  }
}

module.exports = { featuresPending, keepApproved, approvedSpec, reopenLandedDry };
