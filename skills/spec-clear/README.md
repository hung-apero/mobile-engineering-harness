# spec-clear

Skill Claude Code: đọc spec một app Android (+ Figma, + code app nếu có) và viết danh sách câu hỏi cho PO —
mỗi câu có lựa chọn và đề xuất. Bản trong harness dùng tạm cho đoạn `ask` khi service chạy không người (`HARNESS_HEADLESS=1`, xem SKILL.md §0), sẽ thay bằng `create-qa`.

## Cài

```bash
cp -r skills/spec-clear ~/.claude/skills/spec-clear
```

Có Figma thì cần MCP `framelink-figma` (token Figma):

```bash
claude mcp add framelink-figma -- npx -y figma-developer-mcp --figma-api-key=<token> --stdio
```

## Dùng

```
/spec-clear docs/spec.md https://www.figma.com/design/<key>/...?node-id=1-2 ./MyApp
```

Chỉ spec là bắt buộc; có thể dán spec thẳng vào chat. Kết quả ở `.spec-clear/` trong thư mục đang mở:

| File | Nội dung |
|---|---|
| `inputs/spec.md`, `inputs/figma.json`, `inputs/figma/*.png` | đầu vào |
| `scout.md` | app đang có gì, phân tích spec, chỗ mơ hồ, nguồn dữ liệu |
| `figma/<slug>.json` | digest mỗi node Figma (chữ, asset, token, chỗ chưa rõ) |
| `questions.md` | **câu hỏi cho PO** |

Spec đổi → cập nhật spec rồi chạy lại: câu cũ giữ nguyên, câu mới thêm vào cuối.
