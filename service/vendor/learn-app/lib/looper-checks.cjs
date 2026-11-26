const fs = require('fs');
const path = require('path');
const { digestProblems, screenAssignmentProblems } = require('./ui-screens.cjs');
const { staleDigests } = require('./figma-digest.cjs');
const { kbCategories } = require('./kb-map.cjs');

const SCOUT_SECTIONS = ['## Cấu trúc app', '## Learn SDK đang dùng', '## Design system', '## Code liên quan spec', '## Feature Store liên quan', '## Thư viện TeraKit liên quan', '## Phân tích spec', '## Backend'];

const {
  file, read, mtime, specVersions, questionBlocks, headlessRun, readPlans, nextPlan, hasCycle,
  manifestFeatures, manifestFeatureIds, openPending, readLessons, lessonApplies, rawSpecVersion, olderThanRawSpec, planReviewReport, modeOf,
} = require('./looper-parse.cjs');
const { JUDGED_STEPS, verdictMissing } = require('./verdicts.cjs');
const { overlapProblems } = require('./plan-overlap.cjs');
const { mockPlanProblems } = require('./mock-be-planning.cjs');
const { screensUrl } = require('./mock-be-commands.cjs');
const { statusOf } = require('./plan-schedule.cjs');
const { planMissing, planLine } = require('./plan-progress.cjs');
const { undecidedItems } = require('./questions.cjs');
const { unlabelledAgentAnswers } = require('./agent-answers.cjs');
const { stepProblems } = require('./headless.cjs');
const { smokeMissing, smokeDebtMissing } = require('./smoke-checks.cjs');

const { validateManifest } = require('./manifest-schema.cjs');
const { TRACE, readTrace: readManifestTrace, traceProblems } = require('./manifest-trace.cjs');
const { readSpecSource, validateSpecSource } = require('./spec-source.cjs');

function parsedManifest(text, missing) {
  try { return require('./manifest-yaml.cjs').parseYaml(text); } catch (error) {
    missing.push(`app-manifest.yaml không đọc được: ${error.message}`);
    return null;
  }
}

function manifestFormatProblems(root, parsed) {
  return [
    ...validateManifest(parsed).map(e => `app-manifest.yaml sai định dạng: ${e} (xem app-manifest-schema.md)`),
    ...traceProblems(readManifestTrace(root), Object.keys(parsed.features)),
  ];
}

function specSourceProblems(root) {
  const src = readSpecSource(root);
  if (src === null) return ['chưa có inputs/spec-source.json { "type": "url"|"path"|"pasted", "ref": "<nguồn spec>" } để chạy lại tự đọc lại spec (xem figma-tools.md / SKILL §1)'];
  if (src.broken) return ['inputs/spec-source.json không phải JSON hợp lệ'];
  return validateSpecSource(src).map(e => `inputs/spec-source.json sai định dạng: ${e}`);
}

function figmaSourceProblems(root) {
  const text = read(root, 'inputs/figma-source.json');
  if (text === null) return ['chưa có inputs/figma-source.json { "source": "framelink"|"bridge", "fileKey": "<key>" } (xem figma-tools.md)'];
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const ok = parsed && ['framelink', 'bridge'].includes(parsed.source) && typeof parsed.fileKey === 'string' && /^[A-Za-z0-9]+$/.test(parsed.fileKey);
  return ok ? [] : ['inputs/figma-source.json sai định dạng: cần { "source": "framelink"|"bridge", "fileKey": "<key>" } (fileKey chỉ chữ và số, lấy từ /design/<key>/)'];
}

// From-template mode (inputs/from-template.json present): the orchestrator must have forked the fat template,
// snapshotted its manifest to template-manifest.yaml (what manifest-diff reads), and given a template path.
function fromTemplateProblems(root) {
  const text = read(root, 'inputs/from-template.json');
  let parsed = null;
  try { parsed = JSON.parse(text); } catch {}
  const problems = [];
  if (!parsed || typeof parsed.path !== 'string' || !parsed.path.trim()) {
    problems.push('inputs/from-template.json sai định dạng: cần { "path": "<đường dẫn fat-template>", "ref": "<version|sha>" }');
  }
  if (read(root, 'template-manifest.yaml') === null) {
    problems.push('chưa có .learn-app/template-manifest.yaml (bản sao app-manifest.yaml của fat-template) — fork template rồi chép manifest của nó vào đây');
  }
  return problems;
}

function backendProbeProblems(root, scoutText) {
  const line = /^- CMS dev:.*$/m.exec(scoutText);
  if (!line || /^- CMS dev: không dùng\s*$/.test(line[0])) return [];
  const cms = /^- CMS dev: (https?:\/\/[^\s`]+) · bundle: ([^\s`]+)\s*$/.exec(line[0]);
  if (!cms) return [`scout.md dòng "${line[0]}" sai định dạng — cần "- CMS dev: <url> · bundle: <applicationId>" hoặc "- CMS dev: không dùng"`];
  const run = `mock-be.cjs probe --bundle ${cms[2]} --cms ${cms[1]}`;
  const text = read(root, 'backend-probe.json');
  if (text === null) return [`chưa thử CMS thật (chạy ${run})`];
  let probe = null;
  try { probe = JSON.parse(text); } catch {}
  if (!probe || !['has-content', 'empty', 'unreachable'].includes(probe.cms)) return [`backend-probe.json sai định dạng — chạy lại ${run}`];
  if (probe.bundle !== cms[2] || probe.url !== screensUrl(cms[1])) return [`backend-probe.json là của ${probe.bundle} · ${probe.url}, không khớp scout.md — chạy lại ${run}`];
  if (probe.cms !== 'unreachable') return [];
  if (probe.httpStatus >= 400 && probe.httpStatus < 500) return [`CMS dev từ chối bundle ${cms[2]} (HTTP ${probe.httpStatus}) — nhờ dev kiểm bundle đã đăng ký / credential CMS, rồi chạy lại ${run}; không chuyển sang dữ liệu mẫu vì lỗi này${probe.httpStatus === 404 ? '; kiểm trước: url trong scout.md phải là baseUrl app truyền cho CmsConfig, kể cả đoạn nối thêm như /api/' : ''}`];
  return [`không gọi được CMS dev ${probe.url} (${probe.error || `HTTP ${probe.httpStatus}`}) — kiểm mạng/VPN rồi chạy lại ${run}; không chuyển sang dữ liệu mẫu vì lỗi mạng`];
}

const CHECKS = {
  spec(root, state) {
    const missing = [];
    if (!specVersions(root).length) missing.push('chưa lưu spec vào inputs/spec-v1.md');
    else missing.push(...specSourceProblems(root));
    const figma = read(root, 'inputs/figma.json');
    if (!figma && !fs.existsSync(file(root, 'inputs/no-design'))) missing.push('chưa có inputs/figma.json (không có design thì tạo file inputs/no-design)');
    if (figma) missing.push(...figmaSourceProblems(root));
    if (!state.app) missing.push('chưa có mã app');
    if (modeOf(root) === 'from-template') missing.push(...fromTemplateProblems(root));
    return missing;
  },

  scout(root, state) {
    const text = read(root, 'scout.md');
    if (text === null) return ['chưa có scout.md'];
    const missing = SCOUT_SECTIONS.filter(section => !text.includes(section)).map(section => `scout.md thiếu mục "${section}"`);
    if (olderThanRawSpec(root, state, 'scout.md')) missing.push('scout.md cũ hơn spec mới — đọc lại app theo spec mới');
    const sourcesDir = file(root, 'sdk-src');
    const fetched = fs.existsSync(sourcesDir) && fs.readdirSync(sourcesDir).some(v => fs.existsSync(path.join(sourcesDir, v, '.complete')));
    if (!fetched && !/^sdk-sources: lỗi — .+/m.test(text)) missing.push('chưa lấy mã nguồn SDK (chạy sdk-sources.cjs, lỗi thì ghi "sdk-sources: lỗi — <lý do>" vào scout.md)');
    missing.push(...backendProbeProblems(root, text));
    missing.push(...digestProblems(root, { full: false }));
    missing.push(...staleDigests(root).map(s => `figma/${s}.json cũ hơn Figma mới — đọc lại node rồi regen digest (builtFrom mới)`));
    return missing;
  },

  ask(root, state) {
    const text = read(root, 'questions.md');
    if (text === null) return ['chưa có questions.md'];
    if (olderThanRawSpec(root, state, 'questions.md')) return ['questions.md cũ hơn spec mới — soạn lại câu hỏi theo spec mới (giữ câu cũ còn đúng)'];
    const blocks = questionBlocks(text);
    if (!blocks.length && !/Không có câu hỏi/.test(text)) return ['questions.md không có câu hỏi nào dạng "## Q1 · …" (không có câu hỏi thì ghi "Không có câu hỏi")'];
    const missing = [];
    for (const b of blocks) {
      if (b.options < 2) missing.push(`${b.id} cần ít nhất 2 lựa chọn dạng "- A. …"`);
      if (!b.recommended) missing.push(`${b.id} thiếu dòng "**Đề xuất"`);
    }
    return missing;
  },

  clear(root) {
    const text = read(root, 'questions.md') || '';
    return questionBlocks(text, { agent: headlessRun(root) }).filter(b => b.blocking && !b.answered).map(b => `${b.id} [chặn] chưa có câu trả lời của PO`);
  },

  'update-spec'(root, state) {
    const missing = [];
    const versions = specVersions(root);
    const latest = versions[versions.length - 1];
    const raw = rawSpecVersion(state);
    const questions = read(root, 'questions.md');
    const asked = questions ? questionBlocks(questions).map(b => b.id) : [];
    const selfChange = (state.selfSpecChanges || []).slice(-1)[0];
    if (selfChange && !fs.existsSync(file(root, `inputs/${selfChange.to}`))) missing.push(`trợ lý đã quay lại đổi spec nhưng chưa có inputs/${selfChange.to} (spec-clear Mode: update với Self notes:)`);
    if (!latest || latest <= raw) missing.push(`chưa có spec đã làm rõ (inputs/spec-v${raw + 1}.md trở lên)`);
    else {
      const spec = read(root, `inputs/spec-v${latest}.md`);
      const unmentioned = asked.filter(id => !new RegExp(`\\b${id}\\b`).test(spec));
      if (unmentioned.length) missing.push(`spec-v${latest} chưa nhắc tới câu trả lời ${unmentioned.join(', ')}`);
      const unlabelled = unlabelledAgentAnswers(questions, spec);
      if (unlabelled.length) missing.push(`spec-v${latest} chưa ghi nhãn "Agent tự chốt" cho ${unlabelled.join(', ')}`);
      if (questions && mtime(root, `inputs/spec-v${latest}.md`) < mtime(root, 'questions.md')) missing.push(`spec-v${latest} cũ hơn câu trả lời mới nhất trong questions.md`);
    }
    const manifest = read(root, 'app-manifest.yaml');
    if (manifest === null) missing.push('chưa có app-manifest.yaml');
    else {
      const pending = openPending(manifest);
      if (pending.length) missing.push(`app-manifest.yaml còn chờ câu trả lời: ${pending.join(', ')}`);
      if (questions && mtime(root, 'app-manifest.yaml') < mtime(root, 'questions.md')) missing.push('app-manifest.yaml cũ hơn câu trả lời mới nhất trong questions.md');
      if (!manifestFeatureIds(manifest).length) missing.push('app-manifest.yaml không có feature nào');
      const parsed = parsedManifest(manifest, missing);
      if (parsed && parsed.features && !Array.isArray(parsed.features)) {
        missing.push(...manifestFormatProblems(root, parsed));
        if (questions && fs.existsSync(file(root, TRACE)) && mtime(root, TRACE) < mtime(root, 'questions.md')) missing.push(`${TRACE} cũ hơn câu trả lời mới nhất trong questions.md`);
      } else {
        const undecided = manifestFeatures(manifest).filter(f => f.decided_by === undefined).map(f => f.id);
        if (undecided.length) missing.push(`app-manifest.yaml thiếu decided_by ở: ${undecided.join(', ')} (ghi [] nếu không câu trả lời nào quyết định)`);
        const blank = manifestFeatures(manifest).filter(f => Array.isArray(f.decided_by) && f.decided_by.blockList && !f.decided_by.length).map(f => f.id);
        if (blank.length) missing.push(`app-manifest.yaml có decided_by trống ở: ${blank.join(', ')} (ghi [] nếu không câu trả lời nào quyết định)`);
        const changes = parsed ? [].concat(parsed.changes || []) : [];
        changes.filter(c => !c || typeof c !== 'object' || !c.by || !String(c.by).length || (Array.isArray(c.by) && !c.by.length)).forEach(c => missing.push(`app-manifest.yaml changes: "${(c && c.change) || JSON.stringify(c)}" chưa ghi by (mục spec § / câu Q nào yêu cầu)`));
      }
    }
    return missing;
  },

  planning(root) {
    const plans = readPlans(root);
    if (!plans.length) return ['chưa có plan nào trong plans/'];
    const missing = [];
    const ids = plans.map(p => p.id);
    const categories = kbCategories();
    for (const p of plans) {
      if (!p.id) missing.push(`${p.file} thiếu id trong frontmatter`);
      else if (!/^[a-z0-9][a-z0-9-]*$/.test(p.id)) missing.push(`${p.id}: id plan chỉ gồm chữ thường, số và dấu gạch ngang`);
      if (!Number.isFinite(p.priority)) missing.push(`${p.file} thiếu priority (số)`);
      for (const dep of p.depends) if (!ids.includes(dep)) missing.push(`${p.id} phụ thuộc plan không có: ${dep}`);
      if (!p.kb) missing.push(`${p.id || p.file} thiếu kb: (chọn category trong knowledge/coding/kb-map.json)`);
      else for (const c of p.kb.filter(c => !categories.includes(c))) missing.push(`${p.id || p.file} kb có category không có: ${c}`);
    }
    if (fs.existsSync(file(root, 'app-manifest.yaml'))) {
      const newestPlan = Math.max(...plans.map(p => mtime(root, `plans/${p.file}`)));
      if (newestPlan < mtime(root, 'app-manifest.yaml')) missing.push('các plan cũ hơn app-manifest.yaml — chia lại plan theo manifest mới');
    }
    if (new Set(ids).size !== ids.length) missing.push('có hai plan trùng id');
    if (hasCycle(plans)) missing.push('các plan phụ thuộc vòng tròn');
    if (!plans.some(p => !p.depends.length)) missing.push('không có plan nào làm được trước (plan nào cũng phụ thuộc plan khác)');
    const planned = new Set(plans.flatMap(p => p.features));
    const unplannedFeatures = manifestFeatureIds(read(root, 'app-manifest.yaml') || '').filter(id => !planned.has(id));
    if (unplannedFeatures.length) missing.push(`feature chưa thuộc plan nào: ${unplannedFeatures.join(', ')}`);
    const lessons = readLessons(root);
    const assigned = new Set(plans.flatMap(p => p.lessons));
    const unknown = [...assigned].filter(id => !lessons.some(l => l.id === id));
    if (unknown.length) missing.push(`plan gắn bài học không có (hoặc đã tắt): ${unknown.join(', ')}`);
    const unassigned = lessons.filter(l => lessonApplies(l, read(root, 'app-manifest.yaml') || '') && !assigned.has(l.id)).map(l => l.id);
    if (unassigned.length) missing.push(`bài học chưa gắn vào plan nào: ${unassigned.join(', ')} (feature của app, hoặc _general → plan phần nối)`);
    if (!fs.existsSync(file(root, 'lessons/_synced.json'))) missing.push('chưa lấy bài học từ bug cũ (state lessons-sync; không lấy được thì state lessons-sync --skip "<lý do>")');
    missing.push(...digestProblems(root, { full: false }), ...screenAssignmentProblems(root, plans), ...overlapProblems(plans, root), ...mockPlanProblems(root, plans));
    return missing;
  },

  coding(root, state) {
    const plans = readPlans(root);
    if (!plans.length) return ['chưa có plan nào trong plans/'];
    const lines = plans.filter(p => statusOf(state, p.id) !== 'merged').map(p => planLine(root, state, p, plans));
    const undecided = undecidedItems(state).map(u => `quyết định ${u.feature}/${u.decision} chưa chọn — tự chọn: decide --feature ${u.feature} --decision ${u.decision} --choice "${u.pick}" ${u.auto ? '--auto' : '--provisional --why "<lý do>"'}`);
    return [...lines, ...undecided];
  },

  smoke: smokeMissing,

  handoff(root, state) {
    const missing = [];
    const plans = readPlans(root);
    const unmerged = plans.filter(p => statusOf(state, p.id) !== 'merged').map(p => p.id);
    if (unmerged.length) missing.push(`còn plan chưa gộp: ${unmerged.join(', ')}`);
    missing.push(...smokeDebtMissing(root));
    return missing;
  },
};

function checkStep(root, state, step) {
  const missing = [...CHECKS[step](root, state), ...stepProblems(root, state, step)];
  if (missing.length || !JUDGED_STEPS.includes(step)) return missing;
  return verdictMissing(root, step, state);
}

module.exports = { checkStep, planMissing, readPlans, nextPlan, questionBlocks, planReviewReport, specVersions, SCOUT_SECTIONS };
