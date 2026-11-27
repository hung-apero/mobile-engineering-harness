const fs = require('node:fs');
const path = require('node:path');

const SERVER = 'framelink-figma';
const FIGMA_TOOLS = ['get_figma_data', 'download_figma_images'].map(name => `mcp__${SERVER}__${name}`);

function figmaReadConfig(dzHome) {
  const file = path.join(dzHome, 'secrets', 'figma-read.json');
  const bad = reason => {
    throw new Error(`secrets/figma-read.json: ${reason}`);
  };
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  if (!stat) bad('không có file');
  if (!stat.isFile()) bad('phải là file thường, không phải symlink');
  if ((stat.mode & 0o777) !== 0o600) bad('quyền phải là 600');
  let servers;
  try {
    servers = JSON.parse(fs.readFileSync(file, 'utf8'))?.mcpServers;
  } catch {
    bad('không đọc được JSON');
  }
  if (Object.keys(servers ?? {}).join() !== SERVER) bad(`chỉ được có đúng một server ${SERVER}`);
  return file;
}

module.exports = { figmaReadConfig, FIGMA_TOOLS };
