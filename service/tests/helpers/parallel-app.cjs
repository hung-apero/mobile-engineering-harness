const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { tempRepo, writeFiles, tempDir } = require('./temp-git.cjs');

const CLI = path.resolve(__dirname, '../../bin/learn-app-state.cjs');

function run(cwd, ...args) {
  const env = {
    ...process.env,
    LEARN_APP_TRACKING: 'off',
    LEARN_APP_LOCK_DIR: process.env.LEARN_APP_LOCK_DIR || tempDir('learn-app-locks-'),
    LEARN_APP_GRADLEW: process.env.LEARN_APP_GRADLEW || createFakeBuildScript(),
    LEARN_APP_PARALLEL: process.env.LEARN_APP_PARALLEL || '2',
  };
  return spawnSync('node', [CLI, ...args], { cwd, encoding: 'utf8', env });
}

function json(cwd, ...args) {
  const result = run(cwd, ...args);
  if (result.status !== 0) {
    throw new Error(`Command failed (${args.join(' ')}): ${(result.stderr || result.stdout).trim().split('\n').slice(0, 4).join(' | ')}`);
  }
  return JSON.parse(result.stdout);
}

function createFakeBuildScript() {
  const dir = tempDir('gradlew-');
  const script = path.join(dir, 'gradlew.cjs');
  const code = `#!/usr/bin/env node
const ok = process.env.FAIL_BUILD !== '1';
process.exit(ok ? 0 : 1);
`;
  writeFiles(dir, { 'gradlew.cjs': code });
  return script;
}

function appRepo() {
  const dir = tempRepo({ 'app/build.gradle.kts': 'plugins {}\n', '.gitignore': '' });
  json(dir, 'init', '--case', 'existing', '--app', 'AAP864');
  return dir;
}

function planMd(id, priority, cases, depends = []) {
  return `---
id: ${id}
priority: ${priority}
depends: [${depends.join(', ')}]
features: [learning-path]
cases: [${cases.join(', ')}]
kb: [ui-base]
---
`;
}

function setupPlansAtCoding(dir) {
  const manifest = 'schema: 1.0.0\nfeatures:\n  - id: learning-path\n    catalog: learning-path\n';

  // Progress through steps to reach coding
  writeFiles(dir, {
    '.learn-app/inputs/spec-v1.md': 'spec',
    '.learn-app/inputs/figma.json': '{}',
    '.learn-app/inputs/figma-source.json': '{"source":"framelink","fileKey":"abc"}',
    '.learn-app/inputs/spec-source.json': '{"type":"pasted"}',
  });
  json(dir, 'next');

  writeFiles(dir, {
    '.learn-app/scout.md': '## Cấu trúc app\n## Learn SDK đang dùng\n## Design system\n## Code liên quan spec\n## Feature Store liên quan\n## Thư viện TeraKit liên quan\n## Phân tích spec\n## Backend\nsdk-sources: lỗi — không có mạng\n',
  });
  json(dir, 'next');

  writeFiles(dir, {
    '.learn-app/questions.md': '## Q1\n- A. Option A\n- B. Option B\n- **Đề xuất: A**\n- **PO trả lời: A**\n',
  });
  json(dir, 'next');
  json(dir, 'next');

  writeFiles(dir, {
    '.learn-app/inputs/spec-v2.md': 'Spec with Q1 referenced',
    '.learn-app/app-manifest.yaml': 'schema: 1.0.0\nfeatures:\n  - id: learning-path\n    catalog: learning-path\n    decided_by: [Q1]\n',
  });
  json(dir, 'approve', 'g1', '--quote', 'ok');

  writeFiles(dir, {
    '.learn-app/lessons/_synced.json': '{}',
    '.learn-app/plans/01-login.md': planMd('01-login', 1, ['TC-A'], []),
    '.learn-app/plans/02-profile.md': planMd('02-profile', 2, ['TC-B'], ['01-login']),
    '.learn-app/plans/03-settings.md': planMd('03-settings', 3, ['TC-A'], []),
  });
  json(dir, 'next');
}

module.exports = { CLI, run, json, createFakeBuildScript, appRepo, planMd, setupPlansAtCoding };
