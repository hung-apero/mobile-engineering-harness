---
name: spec-clear
description: Đọc spec của một app Android (kèm Figma và code app nếu có), tìm mọi chỗ mơ hồ, thiếu hoặc lệch giữa spec, Figma và code, rồi viết danh sách câu hỏi cho PO (.spec-clear/questions.md) — mỗi câu có lựa chọn và đề xuất. Dùng khi dev gõ /spec-clear hoặc nói "làm rõ spec", "soi spec", "liệt kê câu hỏi cho PO", "spec này còn thiếu gì", "clear spec". Chỉ sinh câu hỏi; không gộp câu trả lời, không viết code.
argument-hint: <spec.md | dán spec> [figma-url] [app-root]
---

# spec-clear

Chỉ viết dưới `<cwd>/.spec-clear/`. Không sửa code app, không sửa spec gốc. Đầu ra duy nhất là
`.spec-clear/questions.md` — dev mang danh sách này đi hỏi PO.

## 0. Chạy không người (`HARNESS_HEADLESS=1`)

Khi biến này bằng `1` (service gọi qua `feature` đoạn `ask`/`clarify`), các mục dưới đổi như sau; không có biến thì bỏ qua mục này.

- **Work dir** là `<cwd>/.harness-run/` thay cho `.spec-clear/` ở mọi bước và mọi prompt agent. Không ghi gì vào
  `.harness-run/inputs/`.
- **Bước 1 không hỏi.** Đọc `.harness-run/inputs/headless.json`: `Spec` = `.harness-run/<spec>` (không chép sang
  `inputs/spec.md`), Figma = `figma.url` (`null` → không có Figma), `App root` = `<cwd>`, `Case` = `case`. Thiếu hay sai → ghi
  `.harness-run/blocked.json` `{ "segment", "reason", "missing": [...] }` rồi dừng.
- **Bước 2:** danh sách frame ghi `.harness-run/figma.json`, ảnh vào `.harness-run/figma-images/`. Tool Figma lỗi → `blocked.json`,
  không hỏi có chạy tiếp không. Khối inputs ở bước 3 ghi `Spec: <cwd>/.harness-run/<spec>` và
  `Figma: <cwd>/.harness-run/figma.json + figma-images/`, kèm dòng `Ảnh Figma ở figma-images/ thay cho inputs/figma/`.
- **Bước 3–4:** agent trả `NEEDS_CONTEXT` hai lần → `blocked.json`. Agent viết câu hỏi nhận thêm dòng `Headless: yes` và ghi cả
  `.harness-run/triage.json` (xem `references/question-rules.md` §Headless).
- **Bước 5:** không báo dev; chạy `python3 .claude/skills/feature/scripts/headless_check.py <segment> .` (`segment` lấy từ
  `headless.json`), sửa tới khi đạt.
- Không bao giờ: `AskUserQuestion`, mở trang hay file, ghi dòng `**PO chọn` / `**PO trả lời` / `**Agent tự chốt`.

## 1. Inputs

Lấy từ args; thiếu gì thì hỏi **một lần** bằng `AskUserQuestion` (gộp mọi ô thiếu):

- **Spec** (bắt buộc): đường dẫn file, hoặc nội dung dán vào chat → lưu `.spec-clear/inputs/spec.md`
  (file có sẵn thì copy nguyên văn).
- **Figma** (tùy chọn): link `figma.com/design/<fileKey>/...?node-id=1-2`. Không có → bỏ bước digest.
- **App root** (tùy chọn): thư mục project Android. Không có → `Case: new`, scout chỉ phân tích spec.
  Có `settings.gradle(.kts)` → `Case: existing`.

`.spec-clear/` đã có `questions.md` → đây là lần chạy lại: giữ nguyên, bước 4 chỉ append.

## 2. Figma → danh sách frame

Có link Figma: theo `references/figma-tools.md`, lấy danh sách frame cần đọc (node trong link, hoặc các frame con
cấp 1 của page/section đó) → `.spec-clear/inputs/figma.json` (`{ "<frameId>": "<tên frame>" }`) và tải ảnh từng
frame vào `.spec-clear/inputs/figma/<frameId>.png`. Tool Figma không có hoặc lỗi → báo dev, hỏi có chạy tiếp chỉ với
spec không.

## 3. Scout ∥ Figma digest

Gọi **cùng một lượt** (song song) 2 agent `general-purpose`, `model: "sonnet"`. Prompt = toàn bộ nội dung file
reference + khối inputs dưới đây, đường dẫn tuyệt đối:

| Agent | Reference | Ghi |
|---|---|---|
| scout | `references/scout-prompt.md` | `.spec-clear/scout.md` |
| figma digest (chỉ khi có Figma) | `references/figma-digest-prompt.md` + `references/figma-tools.md` | `.spec-clear/figma/<slug>.json` |

```
Work dir: <cwd>/.spec-clear
Spec: <cwd>/.spec-clear/inputs/spec.md
Figma: <cwd>/.spec-clear/inputs/figma.json + inputs/figma/   (hoặc none)
Figma fileKey: <key>   (hoặc none)
App root: <path>   (hoặc none)
Case: existing | new
```

Agent trả `NEEDS_CONTEXT` → đọc lý do, sửa input hoặc hỏi dev, gọi lại agent đó.

## 4. Câu hỏi

Gọi 1 agent `general-purpose`, `model: "opus"`, prompt = nội dung `references/question-rules.md` + khối inputs ở
bước 3 + `Scout: <cwd>/.spec-clear/scout.md` + `UI nodes: <cwd>/.spec-clear/figma/*.json` (hoặc none). Agent ghi
`.spec-clear/questions.md`.

Kiểm trước khi báo: mỗi khối `## Q<n> · … ` có ≥2 lựa chọn `- A.` / `- B.` và một dòng `**Đề xuất:`; id không
trùng. Sai → gọi lại agent với `Feedback:` là chỗ sai.

## 5. Báo dev

- Số câu hỏi, số câu `[chặn]`, số node UI có `unclear`.
- Các câu `[chặn]` (tiêu đề, một dòng mỗi câu).
- Đường dẫn `questions.md`. PO trả lời xong mà spec đổi → dev cập nhật spec rồi chạy lại `/spec-clear`; câu cũ giữ
  nguyên, câu mới append.
