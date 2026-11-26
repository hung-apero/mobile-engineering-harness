# Đọc Figma — framelink

MCP `framelink-figma` (cần token Figma, không cần Figma Desktop). `fileKey` lấy từ link: `/design/<key>/` hoặc
`/file/<key>/`. `node-id=1-2` trong link là node `1:2`.

| Việc | Tool |
|---|---|
| đọc node | `mcp__framelink-figma__get_figma_data({ fileKey, nodeId, depth? })` — **luôn có `nodeId`** (không có thì tải cả file, rất lớn); liệt kê frame con dùng `depth: 1` |
| ảnh frame / asset | `mcp__framelink-figma__download_figma_images({ fileKey, nodes: [{ nodeId, fileName }], localPath })` — png; `localPath` tương đối với thư mục mở phiên Claude Code |
| tokens | `globalVars` trong kết quả `get_figma_data` (giá trị, không có tên biến) — đối chiếu tên token trong theme của app |

Tool lỗi (thiếu MCP, mất token, không có quyền file) → báo `NEEDS_CONTEXT`, nêu tool và lỗi. Không đoán nội dung frame.
