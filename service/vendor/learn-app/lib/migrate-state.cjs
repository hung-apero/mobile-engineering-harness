const fs = require('fs');
const path = require('path');
const S = require('./learn-app-state.cjs');
const { specVersions } = require('./looper-parse.cjs');
const { fail, print } = require('./cli-io.cjs');

const STEP_FROM_PHASE = { intake: 'spec', understanding: 'clear', assemble: 'planning', 'ui-review': 'planning', verify: 'planning', done: 'handoff' };
const IGNORED = ['sdk-src/', 'handoff.json', 'tracking/', 'lessons/', 'wt/'];
const RETIRED_VERDICTS = ['update-spec', 'test-cases'];

function migrated(old, root) {
  const step = STEP_FROM_PHASE[old.phase];
  if (!step) throw new Error(`Không biết chuyển phase ${old.phase}`);
  const fresh = S.newState(old.case, old.app);
  const keepGates = step === 'handoff' ? ['g1', 'g3'] : old.gates.g1.status === 'approved' ? ['g1'] : [];
  const versions = specVersions(root);
  const startedAt = new Date().toISOString();
  return {
    ...fresh,
    step,
    gates: Object.fromEntries(['g1', 'g3'].map(g => [g, keepGates.includes(g) ? old.gates[g] : { status: 'pending' }])),
    features: (old.features || []).map(f => ({ decisions: [], gaps: [], files: [], ...f })),
    fixAttempts: old.fixAttempts || {},
    vendored: old.vendored || {},
    ...(old.allowances ? { allowances: old.allowances } : {}),
    baseBranch: old.baseBranch || null,
    rawSpecVersion: versions.length ? versions[0] : 1,
    startedAt,
    runId: `${old.app}-${startedAt.replace(/[-:]/g, '').replace(/\..*$/, '')}`,
    history: [{ at: startedAt, action: 'migrate', from: `schema1:${old.phase}`, to: step }],
  };
}

function dropRetiredVerdicts(root) {
  const dir = path.join(root, S.DIR, 'verdicts');
  const dropped = [];
  for (const key of RETIRED_VERDICTS) {
    const file = path.join(dir, `${key}.json`);
    if (fs.existsSync(file)) {
      fs.unlinkSync(file);
      dropped.push(key);
    }
  }
  return dropped;
}

function migrateV2toV3(root, old) {
  const dropped = dropRetiredVerdicts(root);
  const judgeFails = Object.fromEntries(Object.entries(old.judgeFails || {}).filter(([key]) => !RETIRED_VERDICTS.includes(key)));
  const startedAt = new Date().toISOString();
  return {
    ...old,
    schema: S.SCHEMA,
    judgeFails,
    history: [...(old.history || []), { at: startedAt, action: 'migrate', from: 'schema2', to: 'schema3', dropped }],
  };
}

function ignoreNewPaths(root) {
  const file = path.join(root, S.DIR, '.gitignore');
  const lines = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : [];
  fs.writeFileSync(file, `${[...lines, ...IGNORED.filter(p => !lines.includes(p))].join('\n')}\n`);
}

function migrate(root) {
  const file = path.join(root, S.DIR, 'state.json');
  const old = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (old.schema === S.SCHEMA) fail('.learn-app đã ở bản mới, không cần chuyển');
  if (old.schema === 1) {
    const next = migrated(old, root);
    fs.copyFileSync(file, path.join(root, S.DIR, 'state.schema1.json'));
    ignoreNewPaths(root);
    const v3 = migrateV2toV3(root, next);
    S.writeState(root, v3);
    print({ migrated: true, from: old.phase, step: v3.step, gates: Object.fromEntries(Object.entries(v3.gates).map(([g, v]) => [g, v.status])), backup: '.learn-app/state.schema1.json' });
    return;
  }
  if (old.schema === 2) {
    fs.copyFileSync(file, path.join(root, S.DIR, 'state.schema2.json'));
    const next = migrateV2toV3(root, old);
    S.writeState(root, next);
    const dropped = next.history[next.history.length - 1].dropped || [];
    print({ migrated: true, from: 'schema2', to: 'schema3', dropped, backup: '.learn-app/state.schema2.json' });
    return;
  }
  fail(`Không biết chuyển schema ${old.schema}`);
}

module.exports = { migrate, STEP_FROM_PHASE, migrateV2toV3 };
