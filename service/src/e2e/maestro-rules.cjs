const path = require('node:path');
const { checkFlow, checkFlows, FlowError } = require('./flow-rules.cjs');

const FREE = ['list_devices', 'cheat_sheet', 'query_docs', 'check_flow_syntax'];
const ON_DEVICE = ['inspect_screen', 'inspect_view_hierarchy', 'take_screenshot', 'run', 'run_flow', 'run_flow_files', 'tap_on', 'input_text', 'back', 'launch_app', 'stop_app'];
const DEVICE_KEYS = ['device_id', 'deviceId', 'device'];
const APP_KEYS = ['app_id', 'appId'];
const FLOW_KEYS = ['yaml', 'flow_yaml', 'flow'];
const FILE_KEYS = ['files', 'flow_files', 'file'];

const list = value => [value].flat().flatMap(item => (typeof item === 'string' ? item.split(',').map(part => part.trim()).filter(Boolean) : [item]));

function judgeMaestro(tool, args, config) {
  if (FREE.includes(tool)) return null;
  if (!ON_DEVICE.includes(tool)) return `tool ${tool} không được phép`;
  const given = args ?? {};
  const devices = DEVICE_KEYS.filter(key => Object.hasOwn(given, key));
  if (devices.length === 0 || devices.some(key => given[key] !== config.serial)) return `chỉ được dùng máy ${config.serial}`;
  if (APP_KEYS.some(key => Object.hasOwn(given, key) && given[key] !== config.package)) return `chỉ được điều khiển ${config.package}`;
  try {
    for (const key of FLOW_KEYS) if (Object.hasOwn(given, key)) checkFlow(String(given[key]), config);
    const files = FILE_KEYS.flatMap(key => (Object.hasOwn(given, key) ? list(given[key]) : []));
    const inside = path.join(config.root, '.maestro') + path.sep;
    if (files.some(file => typeof file !== 'string' || !path.resolve(config.root, file).startsWith(inside))) return 'file flow phải nằm trong .maestro';
    checkFlows(config);
  } catch (error) {
    if (error instanceof FlowError) return error.message;
    throw error;
  }
  return null;
}

module.exports = { judgeMaestro };
