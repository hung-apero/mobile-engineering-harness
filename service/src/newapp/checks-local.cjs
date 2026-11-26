const fs = require('node:fs');
const path = require('node:path');
const f = require('./formats.cjs');
const { readSecret, parseProperties } = require('./secret-files.cjs');

const ok = detail => ({ state: 'ok', detail });
const missing = detail => ({ state: 'missing', detail });
const wrong = detail => ({ state: 'wrong', detail });

function format(value, pattern, hint) {
  if (value === undefined || value === null || value === '') return missing('dev chưa cung cấp');
  return typeof value === 'string' && pattern.test(value) ? ok(value) : wrong(`sai định dạng, cần ${hint}`);
}

function googleServices({ app, dir }) {
  const secret = readSecret(dir, 'googleServices');
  if (secret.state !== 'ok') return secret.state === 'missing' ? missing('chưa có file google-services.json') : wrong(secret.detail);
  let json;
  try {
    json = JSON.parse(fs.readFileSync(secret.file, 'utf8'));
  } catch {
    return wrong('google-services.json không phải JSON hợp lệ');
  }
  const packages = (json.client ?? []).map(c => c?.client_info?.android_client_info?.package_name).filter(Boolean);
  if (!packages.length) return wrong('google-services.json không có package_name nào');
  if (!packages.includes(app.applicationId)) return wrong(`package_name ${packages.join(', ')} không khớp applicationId ${app.applicationId ?? '(chưa có)'}`);
  const projectId = json.project_info?.project_id;
  if (app.firebaseProjectId && projectId !== app.firebaseProjectId) return wrong(`project_id ${projectId} không khớp firebaseProjectId ${app.firebaseProjectId}`);
  return ok(`package ${app.applicationId} khớp`);
}

function signing({ app, dir, deps }) {
  if (app.signing === 'dev-only') return ok('chỉ dùng bản dev');
  const props = readSecret(dir, 'signing');
  if (props.state !== 'ok') return props.state === 'missing' ? missing('chưa có signing.properties') : wrong(props.detail);
  const values = parseProperties(fs.readFileSync(props.file, 'utf8'));
  const absent = ['storePassword', 'keyAlias', 'keyPassword'].filter(name => !values[name]);
  if (absent.length) return wrong(`signing.properties thiếu ${absent.join(', ')}`);
  const keystore = readSecret(dir, values.storeFile && !path.isAbsolute(values.storeFile) && !values.storeFile.includes('..') ? values.storeFile : 'keystore');
  if (keystore.state === 'missing') return missing('chưa có keystore');
  if (keystore.state !== 'ok') return wrong(keystore.detail);
  try {
    deps.keytool({ keystore: keystore.file, password: values.storePassword, alias: values.keyAlias, keyPassword: values.keyPassword });
  } catch {
    return wrong('keytool không dùng được keystore (sai storePassword, keyAlias, keyPassword hoặc file hỏng)');
  }
  return ok('keystore mở được');
}

const OPTIONAL_PATTERN = { ads: /^(?:ad|ads|admob)\./, license: /^apero\.licenseKey$/, api: /^chat\.api/ };
const TEMP_NOTE = 'dùng tạm theo started-info.md, thay trước khi lên store';

function optional(name) {
  return ({ app, dir }) => {
    const mode = app.optional?.[name];
    if (mode === 'temporary') return ok(TEMP_NOTE);
    if (mode !== 'provided') return missing('chưa cung cấp, cũng chưa chọn dùng tạm');
    const secret = readSecret(dir, 'product');
    if (secret.state !== 'ok') return secret.state === 'missing' ? missing('chưa có product-secrets.properties') : wrong(secret.detail);
    const values = parseProperties(fs.readFileSync(secret.file, 'utf8'));
    return Object.entries(values).some(([k, v]) => OPTIONAL_PATTERN[name].test(k) && v) ? ok('đã có trong product-secrets.properties') : missing('product-secrets.properties chưa có khoá này');
  };
}

const people = ({ app }) => {
  const missingRoles = ['po', 'qa', 'devOnCall'].filter(role => !app.discord?.[role]);
  if (missingRoles.length) return missing(`thiếu ${missingRoles.join(', ')}`);
  const bad = ['po', 'qa', 'devOnCall'].filter(role => !f.DISCORD_ID.test(String(app.discord[role])));
  return bad.length ? wrong(`sai định dạng ${bad.join(', ')}`) : ok('đủ po, qa, devOnCall');
};

module.exports = {
  'app-key': ({ app }) => format(app.key, f.KEY, '[A-Z][A-Z0-9]+'),
  'app-package': ({ app }) => format(app.package, f.PACKAGE, 'chữ thường, số, gạch dưới'),
  'app-application-id': ({ app }) => format(app.applicationId, f.APPLICATION_ID, 'từ 3 đoạn chữ thường'),
  'app-name': ({ app }) => (app.name === undefined ? missing('dev chưa cung cấp') : f.isName(app.name) ? ok(app.name) : wrong('tên rỗng, quá 60 ký tự hoặc có ký tự điều khiển')),
  'firebase-tester-group': ({ app }) => format(app.testerGroup, f.TESTER_GROUP, 'chữ, số, gạch'),
  'discord-channel': ({ app }) => format(app.discord?.channelId === undefined ? undefined : String(app.discord.channelId), f.DISCORD_ID, '17-20 chữ số'),
  'discord-people': people,
  'google-services': googleServices,
  signing,
  'optional-ads': optional('ads'),
  'optional-license': optional('license'),
  'optional-api': optional('api'),
};
