const fs = require('fs');
const path = require('path');
const { DIR } = require('./learn-app-state.cjs');
const { parseYaml } = require('./manifest-yaml.cjs');
const { DEFAULT_PORT, scenarios } = require('../templates/mock-be/server.cjs');

function mockBeInfo(root) {
  const dir = path.join(root, 'mock-be');
  if (!fs.existsSync(path.join(dir, 'contract.json'))) return undefined;
  return { dir: 'mock-be', port: DEFAULT_PORT, gradleFlag: '-PmockBe', scenarios: scenarios(dir), scenarioEndpoint: '/__scenario' };
}

function writeContext(root) {
  const manifestPath = path.join(root, DIR, 'app-manifest.yaml');
  if (!fs.existsSync(manifestPath)) return null;
  const manifest = parseYaml(fs.readFileSync(manifestPath, 'utf8'));
  const pluginVersion = require('../.claude-plugin/plugin.json').version;
  const context = {
    contractVersion: 1,
    appId: manifest.appId,
    packageName: manifest.packageName || manifest.appId,
    featureIds: (manifest.features || []).map(f => f.id),
    mockBe: mockBeInfo(root),
    writtenAt: new Date().toISOString(),
    writtenBy: `learn-app@${pluginVersion}`,
  };
  const outPath = path.join(root, DIR, 'context.json');
  fs.writeFileSync(outPath, JSON.stringify(context, null, 2) + '\n');
  return context;
}

module.exports = { writeContext };
