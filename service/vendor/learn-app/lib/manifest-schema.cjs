const SCHEMAS = ['1.0.0', '1.1.0', '1.2.0'];
const REQUIRED_TOP = ['schema', 'generated', 'source-of-truth', 'app', 'template', 'catalog', 'features'];
const TOP = [...REQUIRED_TOP, 'mo-sdk', 'paywall', 'theme', 'permissions', 'config', 'remote-config', 'flavors'];
const APP = ['id', 'name', 'package', 'version', 'version-code', 'repo', 'branch'];
const CATALOG_REQUIRED = ['source', 'registry', 'group', 'bom-declared', 'bom-pinned'];
const CATALOG = [...CATALOG_REQUIRED, 'consumer-registry'];
const FEATURE = ['catalog', 'artifact', 'artifacts', 'resolved', 'declared', 'via', 'transitive', 'source', 'module', 'options', 'delta', 'does', 'purpose', 'component'];
const DELTA = ['id', 'at', 'does', 'purpose'];
const APP_ONLY_NEW_REQUIRED = ['does', 'purpose', 'component'];
const MODULE_NAME = /^feature-[a-z0-9]+(-[a-z0-9]+)*$/;
const MO_SDK = ['first-open', 'apero-ads', 'apero-ads-compose', 'learn-ad', 'inappad'];
const CONFIG = {
  paywall: { products: 'list', ui: 'text', 'credit-pools': 'list', plans: 'list', 'close-delay-s': 'text', grants: 'map' },
  theme: { tokens: 'text', 'sdk-bridge': 'text', mode: 'text' },
  permissions: 'list',
  locales: 'list',
  'bundle-splits': { language: 'text', density: 'text', abi: 'text' },
  learn: { 'default-language': 'text', languages: 'list', 'cms-screen-key': 'text', 'chat-gateway': 'text' },
  notifications: 'map',
  ads: { placements: 'map', rewarded: 'list', premium: 'text', 'remote-off': 'text' },
};
const FLAVOR = { api: 'text', cms: 'text', ads: ['test-units', 'live-units'], artifact: ['APK', 'AAB'] };
const HARNESS_ONLY = ['decided_by', 'changes'];
const DEV_PROVIDED = 'dev-provided';
const PROSE = /[àáảãạăằắẳẵặâầấẩẫậèéẻẽẹêềếểễệìíỉĩịòóỏõọôồốổỗộơờớởỡợùúủũụưừứửữựỳýỷỹỵđ]/i;
const PROSE_OK = [
  'app.name',
  'catalog.source',
  /^features\.[^.]+\.does$/,
  /^features\.[^.]+\.purpose$/,
  /^features\.[^.]+\.delta\.\d+\.does$/,
  /^features\.[^.]+\.delta\.\d+\.purpose$/,
];
const proseOk = at => PROSE_OK.some(p => typeof p === 'string' ? p === at : p.test(at));

const isMap = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = v => typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';

function kind(value, expected) {
  if (value === DEV_PROVIDED) return true;
  if (expected === 'list') return Array.isArray(value);
  if (expected === 'map') return isMap(value);
  if (Array.isArray(expected)) return expected.includes(String(value));
  return isText(value);
}

function checkShape(errors, at, value, shape) {
  if (!isMap(value)) return errors.push(`${at} phải là một khối key: value`);
  for (const [key, v] of Object.entries(value)) {
    if (!(key in shape)) errors.push(`${at}.${key} không có trong định dạng`);
    else if (isMap(shape[key])) checkShape(errors, `${at}.${key}`, v, shape[key]);
    else if (!kind(v, shape[key])) errors.push(`${at}.${key} phải là ${Array.isArray(shape[key]) ? shape[key].join(' | ') : shape[key] === 'list' ? 'danh sách [..]' : shape[key] === 'map' ? 'khối key: value' : 'một giá trị'}`);
  }
}

function checkKeys(errors, at, value, allowed, required = []) {
  if (!isMap(value)) return errors.push(`${at} phải là một khối key: value`);
  for (const key of required) if (value[key] === undefined || value[key] === '') errors.push(`${at}.${key} bắt buộc`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) errors.push(`${at}.${key} không có trong định dạng`);
}

function checkDelta(errors, featureId, delta) {
  const at = `features.${featureId}.delta`;
  if (!Array.isArray(delta)) return errors.push(`${at} phải là danh sách [..]`);
  const ids = new Set();
  delta.forEach((item, i) => {
    const atI = `${at}.${i}`;
    if (!isMap(item)) return errors.push(`${atI} phải là một khối key: value`);
    for (const key of Object.keys(item)) if (!DELTA.includes(key)) errors.push(`${atI}.${key} không có trong định dạng (chỉ ${DELTA.join(' | ')})`);
    for (const key of DELTA) {
      if (item[key] === undefined || item[key] === '') errors.push(`${atI}.${key} bắt buộc`);
      else if (!isText(item[key])) errors.push(`${atI}.${key} phải là một giá trị`);
    }
    if (item.id !== undefined && item.id !== '') {
      if (ids.has(item.id)) errors.push(`${atI}.id "${item.id}" trùng trong ${at}`);
      ids.add(item.id);
    }
  });
}

function checkModuleName(at, f, errors) {
  if (f.module !== undefined && f.module !== '' && !MODULE_NAME.test(f.module))
    errors.push(`${at}.module phải là tên module feature-<tên>, không phải đường dẫn (bỏ trống để planner quyết)`);
}

function checkFeature(errors, id, f, schema) {
  const at = `features.${id}`;
  if (!isMap(f)) return errors.push(`${at} phải là một khối key: value`);
  for (const key of Object.keys(f)) if (!FEATURE.includes(key) && !HARNESS_ONLY.includes(key)) errors.push(`${at}.${key} không có trong định dạng (lựa chọn của feature ghi trong ${at}.options)`);
  if (f.options !== undefined && (!isMap(f.options) || !Object.values(f.options).every(isText))) errors.push(`${at}.options phải là khối key: value một cấp`);
  if (f.artifacts !== undefined && !isMap(f.artifacts)) errors.push(`${at}.artifacts phải là khối <artifact>: <bản>`);
  if (f.transitive !== undefined && !isMap(f.transitive)) errors.push(`${at}.transitive phải là khối <artifact>: <bản>`);
  const has = key => f[key] !== undefined && f[key] !== '';
  const hasNewAppOnly = APP_ONLY_NEW_REQUIRED.some(has);
  const hasOldAppOnly = f.source === 'app';

  if (hasNewAppOnly) {
    if (schema !== '1.2.0') return errors.push(`${at}: form app-only {does, purpose, component} chỉ hợp lệ ở schema 1.2.0`);
    for (const key of APP_ONLY_NEW_REQUIRED) if (!has(key)) errors.push(`${at}.${key} bắt buộc cho app-only form`);
    if (has('component') && (!Array.isArray(f.component) || !f.component.every(isText))) errors.push(`${at}.component phải là danh sách [..]`);
    const forbidden = ['catalog', 'artifact', 'artifacts', 'resolved', 'declared', 'via', 'transitive', 'source', 'delta'].filter(has);
    if (forbidden.length) errors.push(`${at}: app-only (does/purpose/component) không có ${forbidden.join(', ')}`);
    checkModuleName(at, f, errors);
    return;
  }

  if (hasOldAppOnly) {
    if (schema === '1.2.0') return errors.push(`${at}: ở schema 1.2.0 app-only dùng form {does, purpose, component}, không dùng source: app`);
    if (!has('module')) errors.push(`${at}: app tự viết (source: app) phải có module`);
    else checkModuleName(at, f, errors);
    const extra = ['catalog', 'artifact', 'artifacts', 'resolved', 'declared', 'via', 'transitive'].filter(has);
    if (extra.length) errors.push(`${at}: app tự viết không có ${extra.join(', ')}`);
    return;
  }

  if (has('source')) errors.push(`${at}.source chỉ có giá trị app`);
  if (has('module') && f.catalog !== 'not-in-learn-catalog') errors.push(`${at}.module chỉ đi với source: app hoặc catalog: not-in-learn-catalog`);
  else checkModuleName(at, f, errors);
  if (!has('catalog')) errors.push(`${at}.catalog bắt buộc (bản catalog, hoặc not-in-learn-catalog)`);
  if (has('delta')) {
    if (schema !== '1.2.0') errors.push(`${at}.delta chỉ hợp lệ ở schema 1.2.0`);
    else checkDelta(errors, id, f.delta);
  }
  if (f.declared === 'none') {
    if (!has('via')) errors.push(`${at}: declared: none phải có via (feature kéo nó vào)`);
    if (has('artifact') || has('artifacts')) errors.push(`${at}: declared: none thì không có artifact/artifacts — chỉ via + transitive`);
    return;
  }
  if (has('via')) errors.push(`${at}.via chỉ đi với declared: none`);
  const own = ['artifact', 'artifacts', 'declared'].filter(has);
  if (own.length !== 1) errors.push(`${at} phải có đúng một trong artifact | artifacts | declared (đang có ${own.join(', ') || 'không cái nào'})`);
}

function checkProse(errors, at, value) {
  if (isMap(value)) return Object.entries(value).forEach(([k, v]) => checkProse(errors, at ? `${at}.${k}` : k, v));
  if (Array.isArray(value)) return value.forEach((v, i) => checkProse(errors, `${at}.${i}`, v));
  if (typeof value === 'string' && PROSE.test(value) && !proseOk(at)) errors.push(`${at} là câu mô tả ("${value.slice(0, 40)}") — ghi giá trị thật, dev-provided cho bí mật, hoặc bỏ key`);
}

function validateManifest(manifest) {
  const errors = [];
  if (!isMap(manifest)) return ['app-manifest.yaml không phải một khối key: value'];
  for (const key of REQUIRED_TOP) if (manifest[key] === undefined || manifest[key] === '') errors.push(`${key} bắt buộc`);
  for (const key of Object.keys(manifest)) {
    if (HARNESS_ONLY.includes(key)) errors.push(`${key} chuyển sang .learn-app/manifest-trace.yaml`);
    else if (!TOP.includes(key)) errors.push(`${key} không có trong định dạng`);
  }
  if (manifest['source-of-truth'] !== undefined && String(manifest['source-of-truth']) !== 'true') errors.push('source-of-truth phải là true');
  if (manifest.schema !== undefined && !SCHEMAS.includes(String(manifest.schema))) errors.push(`schema phải là ${SCHEMAS.join(' | ')}`);
  if (manifest.template !== undefined && String(manifest.template) !== 'learn') errors.push('template phải là learn');
  if (manifest.generated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(String(manifest.generated))) errors.push('generated phải là YYYY-MM-DD');
  if (manifest.app !== undefined) checkKeys(errors, 'app', manifest.app, APP, APP);
  if (manifest.catalog !== undefined) checkKeys(errors, 'catalog', manifest.catalog, CATALOG, CATALOG_REQUIRED);
  const schema = manifest.schema !== undefined ? String(manifest.schema) : '1.1.0';
  if (manifest.features !== undefined) {
    if (!isMap(manifest.features)) errors.push('features phải là khối <tên feature>: {...}, không phải danh sách');
    else {
      for (const [id, f] of Object.entries(manifest.features)) {
        checkFeature(errors, id, f, schema);
        if (isMap(f)) HARNESS_ONLY.filter(key => f[key] !== undefined).forEach(key => errors.push(`features.${id}.${key} chuyển sang .learn-app/manifest-trace.yaml`));
      }
      for (const id of MO_SDK) if (id in manifest.features) errors.push(`features.${id} thuộc mo-sdk, không phải features`);
    }
  }
  if (manifest['mo-sdk'] !== undefined) checkShape(errors, 'mo-sdk', manifest['mo-sdk'], Object.fromEntries(MO_SDK.map(k => [k, 'text'])));
  for (const key of ['paywall', 'theme', 'permissions']) if (manifest[key] !== undefined && !isText(manifest[key])) errors.push(`${key} là tóm tắt một từ; chi tiết ghi ở config.${key}`);
  if (manifest.config !== undefined) checkShape(errors, 'config', manifest.config, CONFIG);
  if (manifest['remote-config'] !== undefined) {
    const rc = manifest['remote-config'];
    if (!isMap(rc)) errors.push('remote-config phải là khối key: value');
    else for (const [key, v] of Object.entries(rc)) {
      if (key === 'namespace') { if (!isText(v)) errors.push('remote-config.namespace phải là một giá trị'); }
      else if (key === 'fetch') { if (!['on-start', 'none'].includes(String(v))) errors.push('remote-config.fetch phải là on-start | none'); }
      else if (!Array.isArray(v)) errors.push(`remote-config.${key} phải là danh sách key [..] (nhóm theo mảng: subscription, streak, ads…)`);
    }
  }
  if (manifest.flavors !== undefined) {
    if (!isMap(manifest.flavors)) errors.push('flavors phải là khối <tên flavor Gradle>: {...}');
    else for (const [name, f] of Object.entries(manifest.flavors)) checkShape(errors, `flavors.${name}`, f, FLAVOR);
  }
  const { changes, ...described } = manifest;
  checkProse(errors, '', described);
  return errors;
}

module.exports = { validateManifest };
