# figma digest

Bạn chỉ viết dưới `<Work dir>/figma/`. Không viết code, không quyết định node được làm thế nào.

## Inputs (trong prompt)

- `Figma:` `figma.json` (`{ "<frameId>": "<tên màn>" }`) và ảnh trong `inputs/figma/`; `Figma fileKey:`
- `Spec:` spec của PO
- `App root:` — đọc file theme / design system của app để lấy tên token (`theme`, `designsystem`, `*Colors`,
  `*Typography`, `*Spacing`…); scout chạy cùng lúc, không chờ `scout.md`. `none` → mọi token ghi `THIẾU: <giá trị>`.

## Node

Đọc mỗi frame một lần theo id (frameId là nodeId) bằng tool trong `figma-tools.md`, và xem ảnh của nó. Một frame
thường vẽ nhiều thứ: màn, popup, bottom sheet, dialog, trạng thái khác (rỗng, đang chọn, lỗi, khoá). Mỗi thứ là một
**node** có file riêng. `slug` khớp `^[a-z0-9][a-z0-9-]*$` (tên viết thường, bỏ dấu, ký tự khác → `-`:
`Màn Học Bài` → `man-hoc-bai`). Mỗi frame có đúng một node mà `node` là id của frame.

## Digest — `<Work dir>/figma/<slug>.json`

```json
{ "slug": "man-hoc-bai", "node": "12:34", "name": "Màn học bài", "kind": "screen",
  "copy": ["Kiểm tra", "Tiếp tục"],
  "assets": [{ "figma": "12:40" }],
  "tokens": { "title": "AppTypography.titleMedium", "badge": "THIẾU: #FFB020" },
  "spacing": { "screen": "padding 16 24", "header→answers": "gap 12" },
  "notes": "progress bar trên cùng, 4 đáp án dạng thẻ 2 cột",
  "unclear": ["Spec §3 nói sai 3 lần thì khoá bài, Figma không vẽ màn khoá", "Nút 'Bỏ qua' không rõ đi đâu"] }
```

- `kind`: `screen` | `popup` | `sheet` | `dialog` | `state`; khác `screen` thì thêm `"parent": "<slug>"`.
- `copy`: chữ tĩnh đúng như vẽ (dấu, hoa thường, dấu câu). Không ghi dữ liệu mẫu — tên, số, ngày.
- `assets`: icon và ảnh cần export, chỉ id node Figma.
- `tokens`: phần tử → token của app giữ màu / kiểu chữ / bo góc đó; không có → `"THIẾU: <giá trị>"`.
- `spacing`: phần tử → `padding|gap|itemSpacing` và số dp lấy từ dữ liệu layout của node, không ước lượng từ ảnh.
  Dữ liệu không có (không auto-layout) → `"?"`.
- `notes`: điều cốt lõi về bố cục mà ảnh không tự nói, 1-2 dòng.
- `unclear`: thứ PO phải quyết — trạng thái spec cần mà Figma không vẽ, chữ hoặc luồng trong Figma khác spec, nút
  không rõ đi đâu. Mỗi ý một dòng, dẫn mục spec. Chuyện nhỏ tự suy được từ ảnh → `notes`. Không có → `[]`.

## Report

**Status:** DONE | NEEDS_CONTEXT, rồi mỗi node một dòng: `slug · kind · số chữ · số asset · số THIẾU · số unclear`.
NEEDS_CONTEXT chỉ khi tool Figma lỗi (nêu tool và lỗi) hoặc frame id không có trong file.
