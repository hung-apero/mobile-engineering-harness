const { SANDBOX_EXEC } = require('./sandbox.cjs');

const PROBE = ['-p', '(version 1)(allow default)', '/usr/bin/true'];
const GH_ITEM = ['find-generic-password', '-s', 'gh:github.com'];
const result = (level, name, detail) => ({ level, name, detail });

function checkSandbox({ exec, baseEnv }) {
  const name = 'sandbox';
  if (baseEnv.DZ_SANDBOX === 'off') return result('CẢNH BÁO', name, 'đang tắt (DZ_SANDBOX=off), worker đọc được secrets và DB');
  const out = exec(SANDBOX_EXEC, PROBE, baseEnv);
  return out.ok ? result('ĐẠT', name, SANDBOX_EXEC) : result('THIẾU', name, `${SANDBOX_EXEC} không chạy được, project live không mở việc`);
}

function checkKeychain({ exec, baseEnv }) {
  const name = 'keychain';
  const out = exec('/usr/bin/security', GH_ITEM, baseEnv);
  return out.ok
    ? result('CẢNH BÁO', name, 'token gh nằm trong keychain, worker Claude đọc được; chạy gh auth login --insecure-storage để token về ~/.config/gh (sandbox chặn đọc)')
    : result('ĐẠT', name, 'không có token gh');
}

module.exports = { checkSandbox, checkKeychain };
