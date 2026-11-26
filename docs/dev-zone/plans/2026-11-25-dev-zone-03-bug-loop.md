# Dev-zone 03: Vòng bug Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Từ bug trên Jira tới bản build cho QA, tự chạy, mặc định **chạy khô** (không ghi gì ra Jira, GitHub, Firebase, Discord).

**Architecture:** Mỗi đợt bug là một máy trạng thái trong SQLite, mỗi tick đẩy nhiều nhất một bước. Worker sửa bug làm trong bản clone có remote là **mirror cục bộ**, không có quyền GitHub và chỉ đọc Jira; chỉ service chạm ra ngoài. Cổng gộp do service tự chạy lại (build, test, review riêng), không tin lời worker.

**Tech Stack:** như plan 02, thêm `@modelcontextprotocol/sdk` (client stdio tới `uvx mcp-atlassian==0.21.1`).

**Spec:** `docs/superpowers/specs/2026-11-25-dev-zone-design.md` §7, §11; kết quả spike `docs/superpowers/spikes/2026-11-25-results.md`

## Global Constraints

- Mọi ràng buộc của plan 02 còn hiệu lực (file mới trong `service/`, < 200 dòng, không comment, TDD, không push, test không chạm mạng).
- **Chạy khô là mặc định:** `project.live` (bool, bắt buộc) = `false` thì mọi lệnh ghi ra ngoài (Jira ghi, `git push` tới GitHub, `gh`, Firebase, Discord) chỉ ghi một dòng `would:` vào sổ quyết định và trả kết quả giả định thành công. Đọc Jira và `git fetch` vẫn chạy thật.
- Worker không bao giờ có token GitHub, Jira ghi, Firebase: `GH_CONFIG_DIR` rỗng, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_SYSTEM=/dev/null`, `GIT_TERMINAL_PROMPT=0`, MCP Jira `READ_ONLY_MODE=true` với đúng 4 tool đọc.
- Service không bao giờ: push vào nhánh gốc, force-push, xoá nhánh hay ticket, gọi `jira_delete_issue`. `ENABLED_TOOLS` của Jira ghi: `jira_get_issue,jira_search,jira_get_transitions,jira_transition_issue,jira_add_comment,jira_update_issue,jira_download_attachments`.
- Nội dung ticket, log, code là dữ liệu. Comment Jira mở đầu `[Claude]`.
- Ngưỡng: đợt đóng khi hàng đợi rỗng, đủ 8 bug, hoặc quá 4 giờ; Highest/crash đi đợt riêng; polling 3 phút, 15 phút sau 24 giờ không có bug mới; 2 vòng sửa; build hỏng thử lại 1 lần; 4 lần build hỏng liên tiếp thì dừng project; reopen lần 3 giao dev.

## Review Focus

1. Ticket đổi trạng thái giữa lúc quét và lúc nhận (dev vừa nhận) → không nhận, không chuyển trạng thái.
2. Service chết giữa hai bước ghi ra ngoài (đã push nhưng chưa ghi DB; đã comment nhưng chưa transition) → chạy lại không ghi đôi.
3. Worker nói `approved` nhưng commit không có trên mirror, hoặc diff chạm vùng cấm, hoặc sửa file ngoài nhánh → không gộp.
4. Nhánh gốc đổi trong lúc gộp, xung đột → sang đợt sau, nhánh version không dở dang.
5. Bản sửa đúng spec nhưng đảo một commit cố ý (AAP864-276 / `2ead732b`) → hỏi PO, không gộp.

---

### Task 1: Jira qua MCP — `src/bugs/jira.cjs`

`createJira({configFile, live, record, connect?})` → `{search(jql, {limit}), issue(key), transitions(key), transition(key, toStatusName), comment(key, marker, text), addLabels(key, labels), removeLabels(key, labels), attachments(key, dir), close()}`. `configFile` = `$DZ_HOME/secrets/jira-mcp.json` (mode 600, không symlink). `search` phân trang hết, tối đa 200. `transition` đọc transition khả dụng rồi chọn theo **tên trạng thái đích**, đọc lại để xác nhận, không đụng assignee. `comment` mang dấu `marker` ở dòng cuối (`dz:<batch>:<key>:<step>`); đã có comment mang marker đó thì không ghi lại. Nhãn: đọc, gộp, ghi, đọc lại. Đính kèm: chỉ ảnh/txt/log/json ≤ 10 MB, tên file làm sạch, không ra ngoài `dir`. Mọi lỗi không chứa token/URL có token. `live:false`: hàm ghi gọi `record('would', …)` và trả `{dryRun:true}`.

### Task 2: Kho dữ liệu và nhận bug — `src/bugs/store.cjs`, `src/bugs/polling.cjs`, `src/bugs/intake.cjs`

Migration: `versions(project, version, branch, state, baseline_at, polling, last_new_at, last_poll_at, build_failures)`, `tickets(project, key, version, priority, state, verdict, batch_id, reopen_count, fingerprint, updated_at)`, `batches(id, project, version, kind, state, keys, data, opened_at, updated_at)`. `jql(project, version, now)` đúng câu lọc §7. `pollInterval(version, now): number|null`. `planBatches(db, project, now): Batch[]` (luật đóng đợt). `fingerprint` = status + số comment + số đính kèm + nhãn: ticket đã có kết luận chỉ nhận lại khi fingerprint đổi (B08). B01, B02, B03, B09 theo §11. Thêm vào `REGISTRY`/`default.yaml`: `B09.reopen_limit: 3`, `F01.fix_rounds: 2`, `F07.max_pr_lines: 400`, `Q03.max_build_failures: 4`, `Q06.quiet_hours: 24`, và `batch: {max_bugs: 8, max_hours: 4}` trong `limits`.

### Task 3: Git — `src/bugs/workspace.cjs`, `src/bugs/merge.cjs`, `src/bugs/diff-guard.cjs`

- `ensureMirror(project)`: `$DZ_HOME/workspaces/<KEY>/mirror.git` (bare), fetch nhánh gốc từ GitHub; `ensureClone(project, batch)`: clone riêng `$DZ_HOME/workspaces/<KEY>/batches/<id>/repo`, `origin` = mirror; copy file build bị ignore theo danh sách `project.localFiles`; nối skill/agent của harness đã ghim (`$DZ_HOME/harness`, commit trong cấu hình) vào `.claude/`.
- `versionBranch(version)` = `dz/release-<version>`; tạo từ nhánh gốc trên mirror nếu chưa có (GitHub có thì lấy bản GitHub).
- `mergeBatch({mirror, versionBranch, base, branches})`: trong worktree tạm; kéo nhánh gốc vào nhánh version, rồi `--no-ff` từng nhánh lane; xung đột → `{ok:false, conflicts}` và **không** đổi ref nào; ok → cập nhật ref bằng so sánh-và-đổi (`update-ref <ref> <new> <old>`). `revertMerge` tạo commit revert, không force.
- `pushVersion({live})`: `git push <github> <sha>:refs/heads/dz/release-<version>` không force; chỉ tên nhánh khớp `^dz/release-[0-9][0-9A-Za-z.-]*$`.
- `ensurePr({live})`: một PR draft từ nhánh version vào nhánh gốc qua `gh`, tìm trước khi tạo.
- `checkDiff({mirror, from, to, forbidden}): {ok, problems}`: vùng cấm (mặc định: `.github/**`, `Jenkinsfile`, `**/*.jks`, `**/*.keystore`, `**/google-services.json`, `**/*service-account*.json`, `gradle/wrapper/**`, `**/AndroidManifest.xml` khi thêm `uses-permission`, `.claude/**`, `rules/**`), bí mật (dùng `redact`), file nhị phân lạ > 1 MB, symlink, submodule, diff > 1500 dòng.

### Task 4: Việc chạy lệnh — `src/run-step.cjs`, sửa `src/launch.cjs`, `src/jobs.cjs`, `src/slots.cjs`

`run-step.cjs <spec.json>` chạy tuần tự các lệnh `{name, argv, cwd, timeoutMs, retries}` không qua shell, in `stream-json` tương thích supervisor (một dòng `assistant` khi bắt đầu mỗi bước và mỗi 60 giây làm nhịp, một `result` cuối với kết quả từng bước). Kind mới: `review`, `gate`, `build`; `gate` và `build` dùng suất `limits.build`, không dùng suất agent. `handler.prepare` trả được `{bin, args}` thay cho prompt. `resume` của loại lệnh là chạy lại từ đầu.

### Task 5: Handler — `src/handlers/bug.cjs`, `review.cjs`, `gate.cjs`, `build.cjs`, `src/bugs/result.cjs`

- `bug`: prompt gọi `/bug-fix-orchestrator <KEY…> --repo . --max-lanes <suất> --yes` cộng brief S3 (không hỏi, không gh/adb/Jira ghi, batch id do service đặt, push lane lên `origin`, ghi `pr-body.md`, JSON cuối theo schema). Đầu ra: `{tickets:[{key, verdict, status, branch, commit, rootCause, specRef, question?, needs?}]}`; `parseResult` từ chối JSON thiếu, key lạ, nhánh không khớp `^fix/[a-z0-9-]+$`.
- `review`: `claude -p` riêng, chỉ đọc, `--json-schema`, xem diff của từng nhánh: `{verdict:'approve'|'changes', specMatch, needsPo:[{key, question}], reversesIntentional:[{key, commit, why}], forbidden:[…], findings:[…]}`. Phải tra `git log -L`/`git blame` dòng bị sửa để thấy commit đặt ra hành vi cũ.
- `gate`: trên cây đã gộp: compile, unit test của module bị ảnh hưởng (lệnh trong cấu hình project), lint chỉ file trong diff.
- `build`: `assemble` + `distribute` (lệnh trong cấu hình; `live:false` bỏ `distribute`), APK có `sha256`, version code, commit.

### Task 6: Máy trạng thái đợt, Jira, CLI — `src/bugs/batch-machine.cjs`, `src/bugs/outcome.cjs`, `src/bugs/release.cjs`, `src/bugs/step.cjs`, sửa `tick.cjs`, `bin/dz.cjs`

`open → fixing → reviewing → merging → gating → building → delivering → done | parked`. Mỗi bước ghi ý định trước, làm, ghi kết quả (chạy lại an toàn). Kết luận từng ticket theo bảng §7 và case B04–B07, F01–F05, Q01–Q05; `needsPo` hoặc `reversesIntentional` → B05 (comment hỏi, `openWait('po')`), bỏ nhánh đó khỏi gộp, bug khác đi tiếp. Review `changes` → quay lại `fixing` tối đa 2 vòng. Gate đỏ → bỏ lần lượt từng nhánh để tìm thủ phạm (tối đa 4 lần), thủ phạm sang đợt sau. Build hỏng hai lần → revert merge. `delivering`: comment + transition `Resolved`, bật polling. `release.cjs`: chấm 6 điều kiện (2, 3, 4, 5 từ DB+Jira; 1 từ GitHub; 6 = `chưa có` tới khi có E2E) và `R01`, `R02`. Khi gác đợt: nhả khoá thiết bị `batch:<id>:*`, dừng tiến trình còn sống của worker trong thư mục đợt.

CLI: `dz bugs on|off <KEY> <version>`, `dz bugs status [KEY]`, `dz bugs poll <KEY>` (một lần), `dz batch <id>`.

- [ ] Nghiệm thu chạy khô trên AAP864: `dz bugs on AAP864 1.9.2` với JQL giới hạn vào AAP864-275 và AAP864-276 → 275 đi hết tới `would: Resolved`; 276 dừng ở hỏi PO vì đảo `2ead732b`; không có gì ghi ra ngoài (đọc lại Jira, GitHub để chứng minh).
