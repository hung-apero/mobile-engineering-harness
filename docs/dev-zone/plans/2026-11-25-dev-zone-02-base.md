# Dev-zone 02: Nền tối thiểu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Một service chạy 24/7 nhận việc, kiểm rule, mở worker `claude -p`, ping người, và không mất hay làm trùng việc khi khởi động lại.

**Architecture:** Một tiến trình Node trong `service/`, trạng thái ở SQLite, một vòng `tick` quyết định mọi thứ bằng hàm thuần nhận `now`. Worker là tiến trình tách nhóm, ghi `stream-json` ra file, nên sống qua lần khởi động lại của service; service đọc tiếp file theo offset. Bản này chỉ có loại việc `probe` để nghiệm thu; polling Jira và `bug-fix` thuộc plan 03.

**Tech Stack:** Node ≥ 24 CommonJS, `node:sqlite`, `node:test`, gói `yaml`; launchd.

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` (§4, §9 bước 2, §11)

## Global Constraints

- Mọi file mới nằm trong `service/`; không sửa phần plugin ở gốc repo. `service/package.json` riêng.
- Code kebab-case, mỗi file < 200 dòng, không comment. Chuỗi cho người đọc bằng tiếng Việt, định danh tiếng Anh.
- Giờ làm việc: 9–18h, thứ 2–6, Asia/Saigon (UTC+7).
- Suất: 2 agent code giờ làm việc, 3 ngoài giờ, chừa 1 suất cho bug, 1 lượt build, tối đa 2 bug cùng lúc mỗi project. Không ngắt việc đang chạy.
- `LEARN_APP_BUILD_SLOTS=1`, `BUG_FIX_STATE_DIR=$DZ_HOME/bug-fix-state`, `CLAUDE_CONFIG_DIR=$DZ_HOME/claude` cho mọi worker; xoá mọi biến `LEARN_APP_DISCORD_*` và `DISCORD_*` khỏi môi trường worker.
- Worker không chạy `bypassPermissions`; luôn `--strict-mcp-config` và `--setting-sources project`. `DZ_CLAUDE_CONFIG=shared` thì xoá `CLAUDE_CONFIG_DIR` khỏi môi trường worker (dùng khi chưa đăng nhập cấu hình riêng).
- Bí mật chỉ ở `$DZ_HOME/secrets/` (thư mục 700, file 600), không vào DB, log, git.
- Test chạy bằng `npm test` trong `service/`; không chạm mạng, không gọi Claude thật (trừ khi `DZ_LIVE=1`). `DZ_HOME` trong test là thư mục tạm.
- Commit cục bộ theo task trên nhánh `dev-zone`, gộp thành một trước khi đưa người dùng xem. **Không push.**

## Review Focus

1. Service chết sau khi nhận việc nhưng trước khi có pid → việc quay lại hàng đợi đúng một lần, không có hai worker (Task 6).
2. Máy khởi động lại, pid cũ thuộc tiến trình khác → không coi là worker còn sống, không `kill` nhầm (Task 6).
3. Dòng JSON bị cắt giữa hai lần đọc, hoặc dòng rác → không mất sự kiện, không sập (Task 5).
4. Discord lỗi hoặc 429 → ping không bị tính là đã gửi, lần sau gửi lại, không gửi đôi (Task 7).
5. Sửa file rule sai khi service đang chạy → giữ bộ rule tốt gần nhất và báo, không dừng service (Task 2).

## File Structure

| File (trong `service/`) | Trách nhiệm |
|---|---|
| `src/work-hours.cjs` | Giờ làm việc |
| `src/rules.cjs`, `rules/default.yaml` | Nạp, gộp, kiểm rule |
| `src/projects.cjs`, `projects/example.yaml.sample` | Cấu hình project |
| `src/db.cjs` | Mở SQLite, migration |
| `src/jobs.cjs` | Hàng đợi, trạng thái việc |
| `src/slots.cjs` | Tính suất |
| `src/stream-reader.cjs` | Đọc `stream-json` theo offset |
| `src/worker.cjs` | Mở, nhận diện, dừng tiến trình |
| `src/supervisor.cjs` | Kết thúc, treo, khởi động lại |
| `src/pings.cjs`, `src/discord.cjs` | Ping gộp, gửi một chiều |
| `src/decisions.cjs` | Sổ quyết định, thiếu rule, tóm tắt ngày |
| `src/health.cjs` | Đĩa, hạn mức, dừng project |
| `src/tick.cjs`, `bin/dz.cjs` | Vòng chính, CLI |
| `launchd/com.devzone.service.plist.tmpl` | Chạy 24/7 |

---

### Task 1: Khung `service/`, giờ làm việc

**Files:** Create `service/package.json`, `service/src/work-hours.cjs`; Test `service/tests/work-hours.test.cjs`

**Interfaces — Produces:**
- `isWorking(ms: number): boolean`
- `addWorkingMinutes(ms: number, minutes: number): number`
- `workingDayKey(ms: number): string` — `YYYY-MM-DD` theo giờ Saigon

`package.json`: `"engines": {"node": ">=24"}`, dependency `yaml`, script `"test": "node --disable-warning=ExperimentalWarning --require ../tests/helpers/no-discord.cjs --test \"tests/*.test.cjs\""`.

- [ ] **Step 1: Test**

```js
const t = s => Date.parse(`${s}+07:00`);
test('boundaries', () => {
  assert.equal(isWorking(t('2026-11-25T09:00:00')), true);
  assert.equal(isWorking(t('2026-11-25T18:00:00')), false);
  assert.equal(isWorking(t('2026-11-28T10:00:00')), false);
});
test('adds across night and weekend', () => {
  assert.equal(addWorkingMinutes(t('2026-11-25T10:00:00'), 240), t('2026-11-25T14:00:00'));
  assert.equal(addWorkingMinutes(t('2026-11-27T16:00:00'), 240), t('2026-11-30T11:00:00'));
  assert.equal(addWorkingMinutes(t('2026-11-28T10:00:00'), 60), t('2026-11-30T10:00:00'));
});
test('a deadline exactly at closing time stays that day', () => {
  assert.equal(addWorkingMinutes(t('2026-11-25T14:00:00'), 240), t('2026-11-25T18:00:00'));
});
```
- [ ] **Step 2:** `cd service && npm install && npm test` → FAIL thiếu module
- [ ] **Step 3:** Viết ba hàm; chỉ dùng phép cộng 7 giờ và `getUTC*`, không phụ thuộc múi giờ máy
- [ ] **Step 4:** `TZ=America/New_York npm test` → PASS
- [ ] **Step 5:** Commit `feat(service): working-hours clock`

### Task 2: Rule

**Files:** Create `service/src/rules.cjs`, `service/rules/default.yaml`; Test `service/tests/rules.test.cjs`

**Interfaces — Produces:**
- `REGISTRY: Record<string, Record<string, {type:'int'|'number'|'bool', min:number, max:number}>>`
- `loadRules(dir: string, projectKey?: string): {version: string, rules: object, limits: object}` — ném `RuleError` có `file`, `path`
- `createRuleStore(dir): {get(projectKey?): Loaded, lastError(): RuleError|null}` — `get` nạp lại khi nội dung đổi; nạp lỗi thì trả bản tốt gần nhất

`version` = 12 ký tự đầu sha256 của nội dung các file đã gộp. Bộ mã ở bản này, các mã khác thêm ở plan sau cùng code dùng nó:

```yaml
limits: { code_agents_working: 2, code_agents_off: 3, reserved_for_bug: 1, build: 1, bugs_per_project: 2 }
rules:
  P01: { every_working_hours: 4, backup_from_ping: 3, daily_after_ping: 3 }
  P02: { every_working_days: 1 }
  P03: { every_working_days: 1 }
  X01: { stop_new_at: 0.8 }
  X02: { silent_minutes: 30, max_resumes: 1 }
  X05: { min_free_gb: 15 }
  X07: { max_consecutive_failures: 3 }
```

- [ ] **Step 1: Test** — tên và kỳ vọng:
  - `default file loads with the values above`
  - `project file overrides one number and keeps the rest` (`rules/ABC1.yaml` đặt `P01.every_working_hours: 2` → 2, `backup_from_ping` vẫn 3)
  - `unknown rule code, unknown field, wrong type and out-of-range each throw RuleError naming the path` (ví dụ `rules.P01.every_working_hours`)
  - `project file may not set limits` → RuleError `limits` (suất là của cả máy)
  - `version changes when content changes and not when mtime changes`
  - `broken edit keeps the last good rules and reports lastError; a fix clears it`
  - `broken file at first load throws`
- [ ] **Step 2:** FAIL → **Step 3:** cài đặt → **Step 4:** `npm test` PASS → **Step 5:** Commit `feat(service): rule registry and store`

### Task 3: Cấu hình project

**Files:** Create `service/src/projects.cjs`, `service/projects/example.yaml.sample`; Test `service/tests/projects.test.cjs`

**Interfaces — Produces:** `loadProjects(dir): {projects: Map<string, Project>, errors: {file, message}[]}`

`Project`: `key` (`/^[A-Z][A-Z0-9]+$/`, trùng tên file), `repo` (`owner/name`), `base`, `checkout` (đường dẫn tuyệt đối **nằm trong `$DZ_HOME/workspaces/`**), `flavor`, `package`, `jiraStatus: {waiting: string[], inProgress, resolved, reopened}`, `people: {po, poBackup?, qa, devOnCall}` (Discord user id, chuỗi 17–20 chữ số), `specUrl`, `figmaUrl`, `excludedDevices: string[]`, `enabled: bool`.

- [ ] **Step 1: Test:**
  - `valid file loads`; `missing field reports the field and skips only that project`
  - `one broken file does not stop the others` (một project lỗi không làm dừng project khác)
  - `checkout outside DZ_HOME/workspaces is rejected, including via .. and symlink`
  - `numeric YAML discord id is rejected` (số 18 chữ số bị YAML làm tròn; phải để trong nháy)
  - `.sample files are ignored`; `enabled: false loads but is not schedulable`
- [ ] **Step 2–4:** FAIL → cài đặt → PASS
- [ ] **Step 5:** Commit `feat(service): per-project config`

### Task 4: DB, hàng đợi, suất

**Files:** Create `service/src/db.cjs`, `service/src/jobs.cjs`, `service/src/slots.cjs`; Test `service/tests/jobs.test.cjs`, `service/tests/slots.test.cjs`

**Interfaces — Produces:**
- `openDb(file): DatabaseSync` — WAL, `foreign_keys`, migration theo `user_version`, file mode 600
- `enqueue(db, {project, kind:'probe'|'bug'|'feature', key, priority:0|1|2, slots, payload}, now): {id, created: boolean}` — `(project, kind, key)` chỉ có một việc chưa kết thúc
- `claimNext(db, {projects: Set<string>, limits, now}): Job|null` — một transaction `BEGIN IMMEDIATE`; đặt `state='starting'`, `slots_granted`
- `markRunning(db, id, {pid, pidStart, sessionId, logFile}, now)`, `finish(db, id, 'done'|'failed', result, now)`, `park(db, id, reason, now)`, `retry(db, id, now)`, `requeue(db, id, now)`
- `capacity(nowMs, limits): number`
- `grant({job, running, limits, now}): number` — 0 nghĩa là chưa được chạy

`claimNext` sinh `session_id` (UUID) nếu việc chưa có và ghi `attempt`; `requeue(db, id, now, {keepSession: boolean})`: giữ session thì lần mở sau dùng `--resume`; `retry` luôn bắt đầu session mới và đặt lại số lần resume.

`db.cjs` xuất `MIGRATIONS: string[]`; task sau thêm bảng bằng cách **nối thêm** một phần tử, không sửa phần tử cũ.

Trạng thái: `queued → starting → running → done | failed | parked`; `parked → queued` chỉ bằng `retry`. Thứ tự nhận: priority tăng dần (0 = Highest), rồi project được phục vụ lâu nhất trước đây, rồi id.

`grant` = `min(job.slots, trống)`; `trống = capacity − tổng slots_granted đang chạy`; việc không phải `bug` phải để lại `reserved_for_bug`; việc `bug` còn bị chặn bởi `bugs_per_project − slots bug đang chạy của project`.

- [ ] **Step 1: Test `slots`:**
  - `2 in working hours, 3 outside`
  - `feature may not take the reserved slot: hours, nothing running, slots 3 → 1`
  - `bug may take both: hours, nothing running, slots 3 → 2`
  - `bugs_per_project caps at 2 outside hours`
  - `over capacity when the clock turns 9:00 grants 0 and never negative` (đang chạy 3)
- [ ] **Step 2: Test `jobs`:**
  - `same key twice while open → created false, same id; after done → new id`
  - `Highest is claimed before an older normal job; a running job is never interrupted`
  - `two projects alternate`
  - `a job that cannot be granted does not block a smaller or bug job behind it`
  - `two connections claiming at once get different jobs` (hai `DatabaseSync` cùng file)
  - `illegal transitions throw` (`done → running`)
  - `reopening an existing db keeps data; a newer user_version throws`
- [ ] **Step 3–5:** FAIL → cài đặt → `npm test` PASS
- [ ] **Step 6:** Commit `feat(service): queue and slots`

### Task 5: Worker và đọc luồng

**Files:** Create `service/src/stream-reader.cjs`, `service/src/worker.cjs`; Test `service/tests/stream-reader.test.cjs`, `service/tests/worker.test.cjs`, `service/tests/fixtures/fake-claude.cjs`

**Interfaces — Produces:**
- `readEvents(file, offset): {events: object[], offset: number, bad: number}` — offset chỉ tiến tới hết dòng trọn vẹn cuối cùng
- `summarize(events): {result: object|null, quota: {utilization, resetsAt, status}|null, denials: object[]}` — `result` là sự kiện `result` **cuối cùng**
- `workerArgs({prompt, sessionId, resume, allowedTools, disallowedTools, mcpConfig, pluginDirs}): string[]`
- `workerEnv(base: object, dzHome): object`
- `startWorker({bin='claude', args, env, cwd, logFile}): {pid, pidStart}` — `detached`, stdin đóng, stdout/stderr ghi thẳng file bằng fd
- `processStart(pid): string|null` — từ `LC_ALL=C ps -o lstart= -p <pid>`
- `isSameProcess(pid, pidStart): boolean`
- `findWorkerBySession(sessionId): {pid, pidStart}|null` — tìm trong `ps -axo pid=,command=` tiến trình có tham số đúng session id, bỏ qua chính nó
- `stopWorker(pid, pidStart, graceMs): Promise<boolean>` — SIGTERM cả nhóm, hết hạn thì SIGKILL; `isSameProcess` sai thì không gửi tín hiệu nào

`fake-claude.cjs` chạy theo biến `FAKE_CLAUDE_SCRIPT` (danh sách bước in/ngủ/thoát/ghi env).

- [ ] **Step 1: Test `stream-reader`:**
  - `a line split across two reads is delivered once`; `a Vietnamese character split across two reads is intact` (offset theo byte)
  - `garbage line counts as bad and the next event is still read`
  - `several result events → the last one` (leader tỉnh lại nhiều lần)
  - `quota from rate_limit_event`, đúng hình đã chụp: `{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1796018400,"unifiedWindows":{"seven_day":{"utilization":0.08,"resetsAt":1796018400,"status":"allowed"}}}}` → `{utilization:0.08,resetsAt:1796018400,status:'allowed'}`
  - `missing file → no events, offset 0`
- [ ] **Step 2: Test `worker`:**
  - `args always contain -p, --output-format stream-json, --verbose, --strict-mcp-config, --setting-sources project; never bypassPermissions or dangerously-skip-permissions`
  - `prompt comes last after --` (prompt bắt đầu bằng `-` vẫn là dữ liệu)
  - `resume uses --resume and not --session-id`
  - `env: LEARN_APP_DISCORD_WEBHOOK and DISCORD_TOKEN removed; CLAUDE_CONFIG_DIR, BUG_FIX_STATE_DIR, LEARN_APP_BUILD_SLOTS=1 set; PATH and ANDROID_HOME kept`
  - `DZ_CLAUDE_CONFIG=shared removes CLAUDE_CONFIG_DIR instead of setting it`
  - `the worker survives the parent exiting and keeps writing its log` (tiến trình cha phụ khởi động rồi thoát)
  - `findWorkerBySession finds a live worker by its session id and returns null after it exits`
  - `stopWorker kills a grandchild too`
  - `stopWorker with a wrong pidStart sends no signal and returns false`
- [ ] **Step 3–5:** FAIL → cài đặt → PASS
- [ ] **Step 6:** Commit `feat(service): detached claude workers`

### Task 6: Giám sát và khởi động lại

**Files:** Create `service/src/supervisor.cjs`; Test `service/tests/supervisor.test.cjs`

**Interfaces:**
- Consumes: Task 4 `jobs`, Task 5 `readEvents/summarize/isSameProcess/stopWorker/startWorker`
- Produces: `supervise(db, {rulesFor: (project) => Loaded, deps, now, boot: boolean}): Promise<Action[]>` — `deps` gồm các hàm worker để test thay được. Gọi mỗi tick **và** ngay khi khởi động; không có đường phục hồi riêng

| Thấy | Làm | Mã |
|---|---|---|
| `starting`, chưa có pid, `findWorkerBySession` thấy tiến trình | nhận lại bằng `markRunning` | X04 |
| `starting`, chưa có pid, không thấy tiến trình, quá 60 giây hoặc service vừa khởi động | `requeue` | X04 |
| `running`, đúng tiến trình, log có thêm | cập nhật `offset`, `last_event_at`, quota | |
| `running`, đúng tiến trình, im ≥ `X02.silent_minutes` | dừng, resume nếu còn lượt, hết lượt thì `park` | X02 |
| Tiến trình mất, `result` cuối không lỗi | `finish done` | |
| Tiến trình mất, quota `rejected` | `requeue` giữ session, không trừ lượt | X01 |
| Tiến trình mất, có `permission_denials` và lỗi | `park`, kèm danh sách lệnh bị chặn | X03 |
| Tiến trình mất, chưa có `result` hoặc lỗi khác | resume nếu còn lượt, hết lượt thì `finish failed` | X02 |

Session id do service sinh và ghi DB **trước** khi spawn, để resume được cả khi chết ngay sau spawn.

- [ ] **Step 1: Test** — mỗi dòng bảng một test, cộng:
  - `crash between claim and spawn: job is claimed again exactly once`
  - `crash between spawn and markRunning: the live worker is adopted, no second one`
  - `reboot: pid alive but different start time → treated as dead, no signal sent`
  - `service restarted while the worker runs: reattaches by offset, no second worker, events not double-counted`
  - `worker finished while the service was down → done`
  - `silent limit counts from the last event, not from start`
  - `two resumes are never issued when supervise runs twice in a row`
- [ ] **Step 2–4:** FAIL → cài đặt → PASS
- [ ] **Step 5:** Commit `feat(service): supervise and recover workers`

### Task 7: Ping người, Discord một chiều

**Files:** Create `service/src/discord.cjs`, `service/src/pings.cjs`; Modify `service/src/db.cjs` (migration: `waits`); Test `service/tests/pings.test.cjs`, `service/tests/discord.test.cjs`

**Interfaces — Produces:**
- `sendDiscord({webhookFile, content, mentions: string[], fetchImpl}): Promise<{ok, messageId?, retryAt?}>` — `?wait=true`, cắt 1900 ký tự, `allowed_mentions.users = mentions`, `parse: []`; lỗi trả về không chứa URL webhook
- `openWait(db, {project, role:'po'|'qa'|'dev', subject, link?}, now): id`, `resolveWait(db, id, now)`
- `duePings(db, {project, rules, now}): {role, mentions, content, waitIds}[]`
- `recordPing(db, waitIds, now)`

Nhịp: PO lần đầu sau `P01.every_working_hours`; từ lần `backup_from_ping` thêm `poBackup`; sau lần `daily_after_ping` mỗi ngày làm việc một lần. QA theo P02; dev theo P03. Chỉ ping trong giờ làm việc. Một tin mỗi người mỗi nhịp, liệt kê mọi việc đang chờ của họ.

- [ ] **Step 1: Test:**
  - `opened 10:00 → due 14:00 same day, not 13:59`
  - `opened Friday 16:00 → due Monday 11:00`
  - `third ping mentions PO and backup; no backup configured → PO only`
  - `after the third, next is the next working day, not 4 hours`
  - `two waits for one PO → one message listing both, when the first is due`
  - `resolved wait is never pinged`
  - `send failure or 429 leaves ping_count unchanged and is retried, not before retryAt; success is not resent on the next tick`
  - `subject containing @everyone or <@123> pings nobody extra` (`allowed_mentions`)
  - `an error message never contains the webhook URL`; `webhook file with mode wider than 600 is refused`
- [ ] **Step 2–4:** FAIL → cài đặt → PASS
- [ ] **Step 5:** Commit `feat(service): grouped pings`

### Task 8: Sổ quyết định, tóm tắt ngày, sức khoẻ

**Files:** Create `service/src/decisions.cjs`, `service/src/health.cjs`; Modify `service/src/db.cjs` (migration: `decisions`, `missing_rules`, `sent_reports`, `project_state`); Test `service/tests/decisions.test.cjs`, `service/tests/health.test.cjs`

**Interfaces — Produces:**
- `record(db, {project, jobId?, code, ruleVersion, evidence, action}, now)`; `missingRule(db, {project, situation, proposal}, now)` (X08)
- `digest(db, {project, now}): string|null` — gửi một lần mỗi ngày làm việc, 17:30; không có gì thì `null`
- `weeklyMissing(db, {now}): string|null` — thứ 6 17:30
- `intake({quota, freeGb, rules, now}): {open: boolean, code?: 'X01'|'X05', until?: number}`
- `setProjectState(db, project, {paused?: boolean, resumedAt?: number})`
- `projectBlocked(db, project, rules): boolean` — X07: số lần `failed` liên tiếp gần nhất ≥ ngưỡng, tính từ lần `resume-project` cuối

- [ ] **Step 1: Test:**
  - `utilization 0.8 closes intake, 0.79 opens; passed resetsAt opens again`
  - `unknown quota keeps intake open`
  - `free 14 GB closes, 15 opens`
  - `three failures in a row block only that project; a success in between resets; resume-project clears`
  - `digest lists finished, parked with reason and code, waiting people; sent once per day even after a restart`
  - `the same missing situation twice → one row with a count`
- [ ] **Step 2–4:** FAIL → cài đặt → PASS
- [ ] **Step 5:** Commit `feat(service): decisions, digest, health`

### Task 9: Vòng `tick` và CLI

**Files:** Create `service/src/tick.cjs`, `service/src/handlers/probe.cjs` (`prepare(job, ctx): {prompt, cwd, allowedTools, disallowedTools, mcpConfig, model}`; `probe` chạy ở `$DZ_HOME/probe`, model `haiku`, không tool), `service/bin/dz.cjs`; Test `service/tests/tick.test.cjs`, `service/tests/cli.test.cjs`

**Interfaces:**
- Consumes: mọi task trước
- Produces: `tick(ctx, now): Promise<void>`; thứ tự: nạp rule/project → `supervise` → `intake` → nhận và mở việc tới khi hết suất → ping → tóm tắt. Lỗi ở một project được ghi và không chặn project khác
- Webhook của project ở `$DZ_HOME/secrets/<KEY>.discord-webhook`; không có file thì bỏ qua gửi, ghi một dòng log mỗi ngày
- CLI: `dz run | status | probe <KEY> | retry <job> | pause <KEY> | resume <KEY> | doctor`. `dz run` giữ khoá độc quyền (`$DZ_HOME/service.lock`, kèm pid + giờ khởi động tiến trình); SIGTERM thì thoát sạch và **để worker chạy tiếp**

`doctor` kiểm: Node ≥ 24, `claude --version` ≥ 2.1.332, `claude auth status` của `$DZ_HOME/claude`, `gh auth status`, `adb devices`, đĩa trống, quyền file bí mật, `pmset -g` (ngủ, `autorestart`), rule và project hợp lệ. Không sửa gì.

- [ ] **Step 1: Test:**
  - `a tick fills free slots and stops when none is left`
  - `intake closed: running jobs are still supervised, nothing new starts`
  - `a throwing project does not stop another project's job from starting`
  - `invalid project config: its queued jobs stay queued, others run`
  - `second dz run exits 1 naming the running pid; a stale lock is taken over`
  - `SIGTERM leaves the worker alive; the next dz run reattaches`
  - `dz probe ABC1 twice while open prints the same job id`
  - `status and doctor never print a secret` (đặt webhook giả rồi tìm trong output)
- [ ] **Step 2–4:** FAIL → cài đặt → PASS
- [ ] **Step 5:** Commit `feat(service): tick loop and dz cli`

### Task 10: Chạy 24/7 và nghiệm thu

**Files:** Create `service/launchd/com.devzone.service.plist.tmpl`, `service/README.md`; Modify `service/bin/dz.cjs` (thêm `install`, `uninstall`); Test `service/tests/install.test.cjs`, `service/tests/live.test.cjs`

Plist: `RunAtLoad`, `KeepAlive`, `ThrottleInterval` 30, chạy `/usr/bin/caffeinate -i <node> bin/dz.cjs run`, đường dẫn tuyệt đối của `node`, `claude`, `adb`, `JAVA_HOME`, `ANDROID_HOME` lấy lúc cài (launchd không có PATH của shell). `dz install` chỉ ghi plist và in lệnh `launchctl`; **người dùng chạy lệnh đó**.

- [ ] **Step 1: Test `install`:** plist sinh ra qua `plutil -lint`; không chứa bí mật; `$HOME` đã thay; `uninstall` chỉ xoá đúng file đó
- [ ] **Step 2:** FAIL → cài đặt → PASS, cả bộ `npm test` PASS, và `npm test` ở gốc repo vẫn 337/337
- [ ] **Step 3: Live (`DZ_LIVE=1`, model haiku):** `probe` chạy `claude -p` thật một agent nền 60 giây; `kill` service ở giây 20, bật lại → việc `done`, đúng một worker, quota có số
- [ ] **Step 4: Nghiệm thu trên máy (người dùng đồng ý trước):** nạp launchd; `dz probe` 3 việc; khởi động lại máy giữa chừng; sau khi đăng nhập lại: `dz status` thấy cả 3 `done` hoặc đã chạy tiếp, không việc nào chạy đôi
- [ ] **Step 5:** README: cài, gỡ, đặt bí mật, đọc log, sửa rule. Commit `feat(service): launchd install and acceptance`

## Sau plan này

Plan 03 (vòng bug AAP864) cần: kết quả S2, S3 của plan 01, và giá trị các rule B/F/Q/R đã chốt.
