const fs = require('node:fs');
const path = require('node:path');
const { figmaReadConfig } = require('./specs/figma-config.cjs');
const { firstLine } = require('./redact.cjs');

const result = (level, name, detail) => ({ level, name, detail });
const exists = (secretsDir, file) => fs.lstatSync(path.join(secretsDir, file), { throwIfNoEntry: false });

function checkConfluence({ secretsDir }) {
  const [name, file] = ['confluence đọc', 'confluence-read.json'];
  const info = exists(secretsDir, file);
  if (!info) return result('CẢNH BÁO', name, `chưa có ${file}`);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) return result('THIẾU', name, `${file} phải là file thường có quyền 600`);
  try {
    const server = JSON.parse(fs.readFileSync(path.join(secretsDir, file), 'utf8'))?.mcpServers?.confluence;
    return server?.command ? result('ĐẠT', name, file) : result('THIẾU', name, `${file}: thiếu mcpServers.confluence.command`);
  } catch {
    return result('THIẾU', name, `${file} không phải JSON`);
  }
}

function checkFigma({ dzHome, secretsDir }) {
  const [name, file] = ['figma đọc', 'figma-read.json'];
  if (!exists(secretsDir, file)) return result('CẢNH BÁO', name, `chưa có ${file}, spec có Figma sẽ dừng ở cần bổ sung`);
  try {
    figmaReadConfig(dzHome);
    return result('ĐẠT', name, file);
  } catch (error) {
    return result('THIẾU', name, firstLine(error));
  }
}

function checkWeb({ baseEnv }) {
  const port = baseEnv.DZ_WEB_PORT || '8787';
  const host = baseEnv.DZ_WEB_HOST || '127.0.0.1';
  const name = 'trang web';
  if (!/^\d{1,5}$/.test(port) || Number(port) > 65535) return result('THIẾU', name, 'DZ_WEB_PORT phải là số từ 0 tới 65535');
  return host === '127.0.0.1' ? result('ĐẠT', name, `${host}:${port}, chỉ mở được trên máy này`) : result('CẢNH BÁO', name, `${host}:${port}, link không mã hoá trong mạng nội bộ`);
}

module.exports = { checkConfluence, checkFigma, checkWeb };
