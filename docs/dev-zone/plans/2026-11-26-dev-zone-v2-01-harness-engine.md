# Dev-zone v2 01: Harness làm engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Service dev-zone chạy luồng spec (ask → quiz → clarify → duyệt) bằng skill của harness trong cùng repo fork, nhận spec từ
Discord và trả lời trong thread, mọi thứ khác chạy khô. Phần B chuyển nốt đoạn build và xoá mọi thứ của learn-app.

**Architecture:** Repo `~/Desktop/src/dev-zone` (fork harness, nhánh `dev-zone`). Service giữ máy trạng thái trong SQLite; mỗi
đoạn là một `claude -p` dùng skill harness đã ghim (`$DZ_HOME/harness` = clone của fork ở `harnessCommit`), trao đổi qua
`.harness-run/` trong bản clone. `headless_check.py` của harness là bộ kiểm chung, worker và service cùng chạy.

**Tech Stack:** Node ≥ 21 (`node:test`, `node:sqlite`) cho service; Python ≥ 3.9 stdlib + `unittest` cho script harness; markdown cho
skill.

**Spec:** `docs/dev-zone/specs/2026-11-26-harness-engine-design.md` (đọc cùng `docs/dev-zone/specs/2026-11-25-dev-zone-design.md`)

## Global Constraints

- Mọi ràng buộc của plan dev-zone 02–07 còn hiệu lực: file mới trong `service/` < 200 dòng, không comment trong code, TDD, test
  không chạm mạng, không chạy adb thật.
- Test service chỉ chạy bằng `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG npm test`. Một file:
  `cd service && env -u DZ_HOME -u DZ_CLAUDE_CONFIG node --disable-warning=ExperimentalWarning --require ./tests/helpers/no-discord.cjs --test tests/<file>`.
- Test harness: `cd skills/<skill>/scripts && python3 -m unittest -v`.
- Commit conventional, tiếng Anh, không nhắc AI; chỉ commit local. Không push, PR, Jira ghi, Firebase, launchctl, `live: true`.
- Không đụng `~/.dev-zone` (bản cũ đang chạy) và `~/.claude/` (trừ đọc `~/.claude/skills/spec-clear`). Secret không vào DB, log,
  git, chat.
- Tối đa 2 subagent cùng lúc (máy 16GB).
- Hợp đồng `.harness-run/` đúng bảng §3 của spec: tên file, schema, `HARNESS_HEADLESS=1`, đoạn `ask|clarify|build`.

## Review Focus

1. Worker sửa `.harness-run/inputs/` (tự viết `approval.json`, đổi spec) → service coi là `tampered`, gác spec, không mở cổng (Task 6).
2. Worker thoát mà không có đầu ra, hoặc `blocked.json` cũ của đoạn trước còn nằm đó → xoá trước khi chạy; thiếu đầu ra thì chạy
   lại đoạn (X02), quá 2 lần thì gác (Task 6).
3. `triage.json` ghi `auto` cho câu về tiền/quảng cáo/Premium/phần thưởng → bộ kiểm từ chối, và quiz vẫn hỏi PO (Task 2, Task 6).
4. Thiếu overlay của project, hoặc harness ở commit ghim chưa có `headless_check.py` → spec `needs-input` cho dev, không lặp chạy
   lại, không crash (Task 5, Task 9).
5. `live: false` + `discord: true` → Discord gửi thật nhưng Jira, GitHub, Firebase, Confluence vẫn chỉ `would:` (Task 8).

---

## Phần A — tới bài thử Discord

### Task 1: Dựng service trong fork

**Files:**
- Create: `service/**` (từ `dev-zone-agent` commit `8edd66e`, `git archive HEAD service`), `service/tests/helpers/*` (từ
  `dev-zone-agent/tests/helpers/`), `service/vendor/learn-app/**` (closure require của `bin/learn-app-state.cjs` và các file `lib/`
  service đang import, giữ đường dẫn tương đối gốc), `service/src/text-hash.cjs`
- Modify: `service/package.json` (test script `--require ./tests/helpers/no-discord.cjs`), mọi `require('../../../lib/…')` /
  `require('../../lib/…')` trong `service/src` và `service/tests`, `service/src/specs/prompts.cjs` (`PLUGIN_ROOT` → `service/vendor/learn-app`),
  `.gitignore` (`service/node_modules/`)
- Test: `service/tests/no-outside-imports.test.cjs`

**Interfaces:**
- Produces: `hashText(text: string): string` trong `service/src/text-hash.cjs` (chép nguyên từ `lib/spec-source.cjs`), dùng ở
  `spec-commands.cjs`, `specs/clone.cjs`, `specs/phase-read.cjs`.
- Produces: `VENDOR_USERS` (danh sách file được phép require `vendor/learn-app`) trong test — Phần B làm rỗng.

- [ ] **Step 1:** Chạy test ở `dev-zone-agent/service`, ghi số test đạt làm mốc. Expected: toàn bộ đạt.
- [ ] **Step 2: Test hỏng trước** — `no-outside-imports.test.cjs`: quét mọi `require('…')` tương đối trong `src/`, `bin/`, `tests/`,
  `channels/`; `assert` đường dẫn đã resolve nằm trong `service/`; file require `vendor/learn-app` phải thuộc `VENDOR_USERS`
  (đoạn build cũ: `specs/{build-kit,phase-build,prompts,wire}.cjs` và 12 file `tests/specs-build-*`, `specs-flow*`, `specs-recovery`).
- [ ] **Step 3:** Chép file, `cp -R` `node_modules` từ bản cũ (không cần mạng), sửa require, tạo `text-hash.cjs`.
- [ ] **Step 4:** Chạy toàn bộ test. Expected: số test đạt bằng mốc + test mới.
- [ ] **Step 5: Commit** `chore(service): import dev-zone service from dev-zone-agent 8edd66e`

### Task 2: Hợp đồng headless và bộ kiểm

**Files:**
- Create: `skills/feature/references/headless.md`, `skills/feature/scripts/headless_check.py`,
  `skills/feature/scripts/test_headless_check.py`, `skills/feature/scripts/fixtures/spec-clear-questions.md`
- Modify: `skills/feature/SKILL.md` (một dòng đầu bảng: `HARNESS_HEADLESS=1` → đọc `references/headless.md` trước, chỗ khác theo nó)

**Interfaces:**
- Produces CLI: `python3 headless_check.py <ask|clarify|build> <repo>` → stdout một dòng JSON
  `{"ok": bool, "problems": [str], "blocked": {...}|null}`; exit 0 khi `ok`, 2 khi có problems, 1 khi sai tham số. `blocked.json`
  hợp lệ → `ok: true`, `blocked` có nội dung (dừng hợp lệ).
- Produces: `check(segment: str, root: pathlib.Path) -> dict`, `parse_questions(md: str) -> list[dict]` (cùng regex với
  `service/src/specs/questions.cjs`), `ASK_ONLY` = `money, ads, premium, reward, delete-data, drop-requirement, sample-data,
  library-gap, conflict`, `AUTO_OK` = `evidence, easy-change` (khớp `service/src/specs/triage.cjs`).

`headless.md` ghi: đầu vào `headless.json`; bảng ba đoạn và điểm dừng (spec §3); đoạn `ask` gọi `spec-clear`; `clarify` gọi
`business-prepare-feature` (reconcile + validate, đầu ra `clarified/spec-v<N>.md`, `brief/`), có câu mới thì `spec-clear` chế độ
thêm câu; `build` gọi `coding-orchestrator` (đọc `brief/`, ép `single`/`team`, ghi `progress.json`, `result.json`); bỏ PM,
Designer, Release Gate; danh sách việc cấm (spec §3); mọi chỗ cần người → `blocked.json` rồi thoát; chạy `headless_check.py`
trước khi thoát.

- [ ] **Step 1: Test hỏng trước** (`test_headless_check.py`, fixture dựng trong thư mục tạm):
  - `test_ask_ok`: `questions.md` = fixture + `triage.json` đủ id → `ok`.
  - `test_ask_missing_triage` → problem chứa `triage.json`.
  - `test_question_needs_two_options_and_one_proposal`, `test_duplicate_id`.
  - `test_auto_on_ask_only_category_rejected`: câu `Q2` category `money`, `decision: auto` → problem chứa `Q2` và `money`.
  - `test_auto_needs_source_and_valid_label`.
  - `test_no_questions_line_ok`: `questions.md` chỉ có `Không có câu hỏi` → `ok`.
  - `test_blocked_is_valid_stop`: `blocked.json` `{segment, reason, missing}` → `ok`, `blocked.reason` đúng; thiếu `reason` → problem.
  - `test_clarify_needs_clarified_spec`: không có `clarified/spec-v2.md` và không có câu chưa trả lời → problem.
  - `test_build_result_commit_must_exist` (git tạm): commit giả → problem; commit thật → `ok`.
  - `test_progress_status_enum`: status ngoài `pending|coding|done|blocked` → problem.
- [ ] **Step 2:** Chạy, Expected: FAIL (chưa có module).
- [ ] **Step 3:** Viết `headless_check.py` và `headless.md`, sửa `SKILL.md`.
- [ ] **Step 4:** Chạy, Expected: PASS. Chạy lại test của `bug-fix`, `bug` (không đổi).
- [ ] **Step 5: Commit** `feat(feature): headless contract and checker for service-driven runs`

### Task 3: `spec-clear` cho đoạn ask

**Files:**
- Create: `skills/spec-clear/{SKILL.md,README.md,references/*.md}` (chép từ `~/.claude/skills/spec-clear`, bỏ `.DS_Store`)
- Modify: `skills/spec-clear/SKILL.md` (mục "Chạy không người"), `skills/spec-clear/references/question-rules.md` (ghi `triage.json`),
  `skills/feature/scripts/test_headless_check.py`

Khi `HARNESS_HEADLESS=1`: không `AskUserQuestion`; Spec/Figma/App root/Case lấy từ `.harness-run/inputs/headless.json` (App root =
gốc repo, Case từ `case`); Work dir = `.harness-run/`; Figma lỗi hoặc agent `NEEDS_CONTEXT` → `blocked.json`; agent viết câu
hỏi ghi thêm `triage.json` mỗi câu chưa trả lời một mục (`decision`, `category` thuộc `ASK_ONLY ∪ {unclear, evidence,
easy-change}`, `label`/`source` khi `auto`, `reason`). Các chỗ `unclear` trước đây "tự quyết không hỏi" nay phải thành câu hỏi
có triage `auto` kèm nguồn, để PO thấy. Không chạy headless thì giữ nguyên hành vi cũ.

- [ ] **Step 1: Test hỏng trước** `test_spec_clear_backend_example_passes`: khối mẫu "Backend" của `question-rules.md` + triage
  `ask` → `ok`; `test_spec_clear_backend_auto_c_rejected`: cùng khối, triage `auto` label `C` category `sample-data` → problem.
- [ ] **Step 2:** Chạy, Expected: FAIL ở test thứ hai nếu `sample-data` chưa bị chặn, hoặc fixture chưa có.
- [ ] **Step 3:** Chép skill, viết mục headless, cập nhật `question-rules.md`, thêm fixture.
- [ ] **Step 4:** Chạy, Expected: PASS.
- [ ] **Step 5: Commit** `feat(spec-clear): import spec-clear as temporary ask step with headless mode`

### Task 4: `bug-fix` chạy không người

**Files:**
- Modify: `skills/bug-fix/SKILL.md` (mục "Chạy không người"), `skills/bug-fix/references/mode-batch.md`,
  `skills/bug-fix/references/classify-and-plan.md`, `skills/bug-fix/references/intake-and-context.md`

Khi `HARNESS_HEADLESS=1`: không `AskUserQuestion`; remote, base, thiết bị, username, batch id lấy từ brief; duyệt plan = `--yes`;
`needs-confirm`/`spec-gap`/câu cho PO ghi vào kết quả ticket (`question`), không hỏi; không `gh`, không Jira ghi, không push ra
ngoài `origin`. Đối chiếu từng luật trong `service/src/bugs/prompts-bug.cjs` để không mâu thuẫn; prompt của service giữ nguyên
đợt này.

- [ ] **Step 1:** Liệt kê mọi chỗ "hỏi user" trong `skills/bug-fix/**` (8 chỗ đo 2026-11-26), viết luật headless cho từng chỗ.
- [ ] **Step 2:** `cd skills/bug-fix/scripts && python3 -m unittest -v`, Expected: PASS (96 test, không đổi).
- [ ] **Step 3: Commit** `feat(bug-fix): headless rules for service-driven batches`

### Task 5: Bản clone spec nạp harness và overlay

**Files:**
- Modify: `service/src/specs/clone.cjs`, `service/src/bugs/workspace.cjs`, `service/src/specs/phase-read.cjs`
- Test: `service/tests/specs-clone.test.cjs`, `service/tests/workspace-overlay.test.cjs` (mới)

**Interfaces:**
- Produces: `linkOverlay({ dzHome, project, repo }): void` (`workspace.cjs`): `$DZ_HOME/projects/<KEY>.overlay.yaml` (file thường,
  không symlink) → `<repo>/.harness-overlay/overlay.yaml`; `<repo>/.harness-overlay/upstream` symlink → `$DZ_HOME/harness`.
  Thiếu → `GitError` code `OVERLAY`, message nêu đường dẫn.
- Produces: `AGENTS` = `bug-fixer, bug-reviewer, bug-scout, ui-board-judge, architect, coder, qa, reviewer`; `linkHarness` được export.
- Produces: `prepareSpecClone(...)` ghi `.harness-run/inputs/spec-v1.md` (không còn `spec-source.json`, `figma-url.json`,
  `no-design`), gọi `linkHarness` + `linkOverlay`, exclude `.claude/`, `.harness-run/`, `.harness-overlay/`; trả `{ repo }`.
  Spec nguồn đổi khi đã có `.harness-run/clarified/` → lỗi `CHANGED` như cũ.
- `phase-read`: lỗi `OVERLAY`/`HARNESS` → `needInput` role `dev`, lý do một dòng.

- [ ] **Step 1: Test hỏng trước:** `clone writes spec under .harness-run/inputs`, `clone links feature and spec-clear skills`,
  `clone copies overlay and links upstream`, `missing overlay throws OVERLAY`, `exclude lists claude, harness-run, harness-overlay`,
  `read phase turns OVERLAY into dev needs-input`.
- [ ] **Step 2:** Chạy, Expected: FAIL.
- [ ] **Step 3:** Sửa ba file.
- [ ] **Step 4:** Chạy toàn bộ test, Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): spec clones load the pinned harness and project overlay`

### Task 6: Đoạn ask/clarify và duyệt qua hợp đồng

**Files:**
- Modify: `service/src/specs/{repo-files,segment,verify,phase-review,answer-ledger,prompts,wire}.cjs`,
  `service/src/handlers/spec.cjs`, `service/src/worker-env.cjs`
- Test: `service/tests/specs-flow-fixtures.cjs` (viết lại phần ask/clarify: worker giả ghi `questions.md`, `triage.json`,
  `clarified/spec-v<N>.md`, `blocked.json`; `check` giả), `service/tests/specs-flow.test.cjs`, `specs-questions.test.cjs`,
  `specs-recovery.test.cjs`, `service/tests/specs-contract.test.cjs` (mới)

**Interfaces:**
- `repo-files`: `DIR = '.harness-run'`; `latestSpec(repo)` = bản cao nhất của `clarified/spec-v<N>.md`, không có thì
  `inputs/spec-v1.md` (giữ nguyên shape trả về hiện tại); thêm `inputsSha(repo): string` (sha256 trên đường dẫn + nội dung mọi file
  trong `inputs/`, sắp theo đường dẫn).
- `segment.launch(run, …)`: xoá `blocked.json`, ghi `headless.json` (giữ trường hiện có), lưu `data.segment.inputsSha`.
- `wire.createSpecs(ctx)` thêm `check(project, repo, segment): Promise<{ ok, problems, blocked }>`: chạy
  `python3 <dzHome>/harness/skills/feature/scripts/headless_check.py <segment> <repo>`, không qua shell, timeout 60 s, env của
  `stateEnv`; exit 0/2 → parse JSON, khác → throw. `runState` giữ cho đoạn build cũ (Phần B bỏ).
- `verify.inspect(run)` trả cùng các `type` hiện có, theo thứ tự: `inputsSha` khác → `tampered`; `blocked.json` (trường
  `segment` thay `step`) → `blocked`; `check` có problems → `short`; đoạn `ask` → `questions`; đoạn `clarify` → `questions` khi có
  câu PO chưa thấy hoặc câu `[chặn]` chưa trả lời, `short` khi `latestSpec.version <= reviewFloor`, còn lại `clarified`. Bỏ
  `atGate`, `GATES`, mọi chỗ đọc `state.json`.
- `phase-review.recordGate(run, repo, approving)`: ghi `inputs/approval.json` `{ sha, by, at }`, trả `null`; bỏ `runState`, `gateOf`.
- `answer-ledger.seen`: dùng `parseQuestions(md).filter(q => q.answered)` thay `questionBlocks`.
- `prompts.specPrompt(job)` với `segment` `ask|clarify`:
  `Chạy không người (HARNESS_HEADLESS=1), đoạn <segment>. Gọi skill feature, làm đúng skills/feature/references/headless.md tới chỗ dừng của đoạn. Đầu vào: .harness-run/inputs/headless.json. Trước khi thoát chạy: python3 .claude/skills/feature/scripts/headless_check.py <segment> . — sửa tới khi đạt hoặc ghi blocked.json. Không hỏi ai.`
  `build|smoke`: giữ prompt cũ (không chạy được ở v2, Task 9 chặn).
- `handlers/spec.prepare` với `ask|clarify`: không `pluginDirs`, env `HARNESS_HEADLESS: '1'`, bỏ `LEARN_APP_HEADLESS`,
  `LEARN_APP_TRACKING`; giữ `disallowedTools` (có `AskUserQuestion`), Figma tool khi có Figma.

- [ ] **Step 1: Test hỏng trước** (`specs-contract.test.cjs`):
  - `ask worker env has HARNESS_HEADLESS and no LEARN_APP vars and no plugin dir`
  - `ask prompt names feature skill, segment and checker`
  - `inspect marks tampered when inputs change after launch` (worker giả ghi `inputs/approval.json`) → spec `parked`
  - `stale blocked.json is removed before launch`
  - `missing outputs reruns segment then parks after two tries`
  - `checker problems keep segment short`
  - `approve writes approval.json with sha and by, spec moves to approved`
  - `auto triage on reward question still asks PO` (qua `mergeTriage`)
  - `spec-clear fixture questions render on quiz` (fixture của Task 2 chép sang `service/tests/fixtures/`)
- [ ] **Step 2:** Chạy, Expected: FAIL.
- [ ] **Step 3:** Sửa các file, viết lại fixture flow phần ask/clarify.
- [ ] **Step 4:** Chạy toàn bộ test, Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): drive ask and clarify through the harness headless contract`

### Task 7: `dz spec cancel`

**Files:**
- Create: `service/src/specs/cancel.cjs`
- Modify: `service/src/spec-commands.cjs` (`SUBS.cancel`), `service/src/rules.cjs` (`REGISTRY.OP01 = {}`),
  `service/src/web/page-home.cjs` (`SPECS.cancelled = 'Đã huỷ'`), `service/README.md` (bảng lệnh)
- Test: `service/tests/specs-cancel.test.cjs`

**Interfaces:**
- Produces: `cancelSpec(ctx, id: number, now: number): { id, from, state: 'cancelled' }`: đóng mọi wait của spec, gác job `spec`/
  `uidiff` còn mở của spec theo cách `bugs/park-request.cjs` dừng worker, `move` sang `cancelled`, `decide` mã `OP01`
  `spec-cancelled`. Đã `cancelled` → trả kết quả, không ghi thêm. `cancelled` không có trong `PHASES` nên máy trạng thái bỏ qua.

- [ ] **Step 1: Test hỏng trước:** `cancel from quiz closes waits and stops pings`, `cancel parks open job`, `cancel twice is idempotent`,
  `machine ignores cancelled spec`, `unknown id is an expected error`.
- [ ] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): dz spec cancel`

### Task 8: Công tắc `discord`

**Files:**
- Create: `service/src/discord-live.cjs`
- Modify: `service/src/projects.cjs` (`TOP_FIELDS` + `discord`), `service/src/mcp/actions.cjs:44`, `service/src/notify.cjs:67-87`,
  `service/channels/access.cjs` (`liveChannels`), `service/projects/example.yaml.sample`, `service/README.md`
- Test: `service/tests/discord-live.test.cjs`

**Interfaces:**
- Produces: `discordLive(project): boolean` = `project.live === true || project.discord === true`. `discord` tuỳ chọn, mặc định
  `false`, có mà không phải boolean → lỗi cấu hình.
- Mọi chỗ gửi Discord dùng `discordLive`; mọi chỗ khác (Jira, git push, gh, Firebase, Confluence, `recordWould`) giữ `live`.

- [ ] **Step 1: Test hỏng trước:** `discord field parses and defaults false`, `non boolean discord is rejected`,
  `bot replies for real when discord true and live false`, `pings use webhook when discord true`,
  `desk reply channels include discord projects`, `jira and git effects stay would when only discord is true`.
- [ ] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): per-project discord switch independent of live`

### Task 9: Vận hành v2 song song

**Files:**
- Modify: `service/src/doctor.cjs`, `service/src/spec-build-commands.cjs`, `service/README.md` (mục "Chạy v2 song song")
- Test: `service/tests/doctor-v2.test.cjs`, `service/tests/spec-build-commands.test.cjs`

**Interfaces:**
- `doctor` thêm: overlay của từng project bật (`$DZ_HOME/projects/<KEY>.overlay.yaml`); `python3` ≥ 3.9; harness ở commit ghim có
  `skills/feature/scripts/headless_check.py` và `skills/spec-clear/SKILL.md`.
- `dz spec build` → `ExpectedError('đoạn build chưa có ở v2')` cho tới Phần B.
- README: `DZ_HOME=~/.dev-zone-v2`, `DZ_WEB_PORT=8788`; `$DZ_HOME/harness` = `git clone ~/Desktop/src/dev-zone` rồi `checkout
  <harnessCommit>`; chạy `dz run` (không `dz install`, không launchd); bàn điều phối của bản cũ phải tắt.

- [ ] **Step 1: Test hỏng trước:** `doctor reports missing overlay`, `doctor reports pinned harness without headless checker`,
  `spec build is refused on v2`.
- [ ] **Step 2:** Chạy, Expected: FAIL. **Step 3:** Viết. **Step 4:** Chạy toàn bộ, Expected: PASS.
- [ ] **Step 5: Commit** `feat(service): doctor and guards for running v2 next to v1`

### Task 10: Bài thử Phase 15 qua Discord (cần người dùng)

- [ ] **Step 1 (builder):** Tạo `~/.dev-zone-v2/{projects,secrets}` (700), clone fork vào `~/.dev-zone-v2/harness` ở commit cuối của
  Task 9, chép `~/.dev-zone/projects/AAP864.yaml` sang và đặt `harnessCommit` = commit đó, `live: false`, `discord: true`.
- [ ] **Step 2 (người dùng):** overlay không cần làm tay (repo AAP864 đã có, app khác service tự tạo); đăng nhập Claude cho `~/.dev-zone-v2/claude`; chép secret cần (Confluence đọc,
  Jira đọc, Figma, Discord) vào `~/.dev-zone-v2/secrets/` (600); bot Discord + `channel`/`people`/`roles` theo `dz desk setup`.
- [ ] **Step 3:** `DZ_HOME=~/.dev-zone-v2 node service/bin/dz.cjs doctor`, Expected: không còn dòng THIẾU (trừ phần build/E2E).
- [ ] **Step 4 (người dùng, sau go):** `dz run` và `dz desk start` của v2; gửi link Confluence 332470208 + Figma vào kênh thử.
- [ ] **Step 5: Nghiệm thu** — thread nhận link quiz; quiz có câu "Change path" và các ô spec trống; câu tiền/phần thưởng là `ask`;
  trả lời quiz → `clarify` → trang review → duyệt → `dz spec show` là `approved`; `.harness-run/inputs/` không do worker sửa;
  Confluence, Jira, GitHub đọc lại không đổi. Ghi kết quả vào `docs/dev-zone/spikes/2026-11-26-v2-trial.md`.
- [ ] **Step 6: Commit** `docs(dev-zone): v2 phase 15 trial results`

---

## Phần B — đoạn build và xoá learn-app (chi tiết hoá sau bài thử)

Mỗi task theo khuôn Phần A (test hỏng trước, chạy toàn bộ, commit). Đầu vào/đầu ra theo spec §3–§5.

### Task 11: Đoạn build qua hợp đồng
Prompt và handler `build` gọi `/feature` headless; đọc `progress.json`/`result.json` thay `state.json`, `readPlans`, `stepIndex`
(`phase-build`, `build-kit`). Test: build giả ghi `result.json` → spec sang bước kế; `result.json` trỏ commit không có → `short`.

### Task 12: Sửa lại qua `rework-<N>.md`
Bỏ `back`, `reopen`, `decide`, `sendBack`, `planOfFiles`, `planOfFeature` (`change`, `provisional`, `phase-code-review`,
`phase-landing`, `phase-trial`, `rework`): mọi yêu cầu sửa ghi `inputs/rework-<N>.md` rồi chạy lại `build`.

### Task 13: Chạy thử máy và giao hàng
Smoke = cài bản + mở app một lần bằng `run-step` (như bug loop), bỏ `smoke/report.md`, `debts.md`; `candidate` bỏ
`state handoff`: service tự lấy nhánh/commit từ `result.json`, nội dung PR từ `brief/`. `approve g3` → ghi quyết định ở DB.

### Task 14: Xoá learn-app
Xoá `service/vendor/learn-app/`, `PLUGIN_ROOT`, `STATE_CLI`, `runState`, `LEARN_APP_*` trong `worker-env`; viết lại 12 file test
build theo fixture hợp đồng; `VENDOR_USERS` rỗng; `grep -ri "learn-app\|LEARN_APP\|\.learn-app" service/src service/tests`
không còn kết quả; bỏ chặn `dz spec build` của Task 9.
