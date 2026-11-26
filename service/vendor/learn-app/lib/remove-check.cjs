const fs = require('fs');
const path = require('path');

// A remove plan deletes a template feature the new spec does not want. Its --files are the paths it removed;
// the static gate is that they are actually gone. Dangling references (imports, nav, DI) are caught by the
// build-green guard after merge — compile fails if a reference survives — so this check stays deliberately thin.
function removeCheck(code, files) {
  if (!files || !files.length) return ['plan remove phải khai --files = các file đã xóa'];
  return files
    .filter(f => fs.existsSync(path.join(code, f)))
    .map(f => `${f} vẫn còn — plan remove phải xóa hẳn (file, route nav, đăng ký DI, strings/assets riêng)`);
}

module.exports = { removeCheck };
