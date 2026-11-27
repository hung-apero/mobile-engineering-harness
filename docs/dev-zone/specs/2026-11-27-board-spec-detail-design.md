# Board: chi tiết spec đang làm — thiết kế

Brainstorm 2026-11-27. Ký hiệu như `2026-11-25-dev-zone-design.md`: **[C]** người dùng đã chốt · **[Đ]** đề xuất · **[T]** builder tự quyết.

## Vấn đề

Card "Phase đang làm" trên board (`/board/<token>/<KEY>`) chỉ có: số câu hỏi, số tài liệu, spec đã duyệt, `N/M plan xong`,
`Bản cài #n`, nhãn trạng thái. Không biết đang ở bước nào trong pipeline, đang chạy gì bao lâu, chờ ai việc gì, còn vấn đề gì
chặn merge, UI lệch màn nào. Ví dụ spec #3 AAP864 Phase 15: đã code, smoke pass, UI diff 3 vòng (màn chào 35→50), review có 1
chỗ chặn merge (Accuracy Speaking, SDK thiếu API) — board không thấy gì trong số đó.

## Yêu cầu đã chốt

- **[C]** Card gọn + trang chi tiết riêng mỗi spec.
- **[C]** Trang chi tiết có: pipeline + đang chờ ai; vấn đề còn mở / chặn merge; UI diff từng màn; plan, job, chi phí.
- **[C]** Người xem: PO + dev. Chữ chính PO đọc được; job/commit/chi phí/ghi chú worker nằm trong phần "Kỹ thuật" thu gọn.
- **[C]** Vấn đề lấy từ dữ liệu có cấu trúc do worker ghi (`result.json.issues[]`), không đoán từ chữ.

## Phương án đã cân nhắc

| Chủ đề | Phương án | Kết luận |
|---|---|---|
| Vị trí | Card mở rộng tại chỗ (`<details>`) | Bỏ: board dài khi nhiều spec |
| | Card gọn + trang chi tiết | **Chọn [C]** |
| Vấn đề | Service regex "da sua"/"chua sua" trong `review.findings` | Bỏ: dễ sai, không dấu, PO khó đọc |
| | Worker ghi `issues[]`, checker bắt | **Chọn [C]** |

## Thiết kế

### Card (trang dự án + danh sách dự án)
```
[AAP864] Phase 15: SDK custom learning path            [Đang so giao diện]
✓Đọc ✓Hỏi ✓Làm rõ ✓Duyệt ✓Code ✓Chạy thử ●So giao diện ○Kiểm code ○Bản cài ○PO thử ○Gộp
Đang chạy: so giao diện vòng 4 · 12 phút          (hoặc: Đang chờ PO: thử bản cài #3 · từ 10:22 · nhắc 1 lần)
⚠ 1 vấn đề chặn merge · 2 còn mở · 15 câu tạm theo đề xuất
Chi tiết →
```
Các dòng cũ của `productsOf` chuyển vào trang chi tiết.

### Trang chi tiết `/board/<token>/<KEY>/spec/<id>`
Cùng quyền viewer với board project, `reload: 60`, chỉ đọc.

| Phần | Nội dung | Nguồn |
|---|---|---|
| Tóm tắt | Trạng thái, chờ ai việc gì (mở lúc, số lần nhắc), version, bản cài, link quiz/review/thử đang mở | `specs`, `waits`, `data.build` |
| Tiến trình | Bước + giờ; gộp vòng lặp ("So giao diện: 3 vòng 09:55 → 10:22", "Code lại 1 lần sau review") | `decisions` (map mã → bước) |
| Vấn đề | Chặn merge / Còn mở / Đã sửa, kèm người xử lý (PO/dev/SDK); "Tạm theo đề xuất, PO chưa chốt" (id + lựa chọn) | `result.json.issues[]`, `data.questions` + câu PO bỏ trống |
| Giao diện | Bảng màn × vòng (4 vòng gần nhất), đạt/chưa theo ngưỡng, nhận xét vòng cuối | `decisions` S05 `spec-ui-round`, `data.build.notes.ui` |
| Kỹ thuật (`<details>`) | Plan (id, tên, trạng thái), job (loại, bắt đầu, thời lượng, USD, lượt), tổng USD, nhánh/commit, findings nguyên văn | `progress.json`, `jobs.result.costUsd/turns`, `result.json` |

### Hợp đồng worker (harness)
`result.json.issues[]`: `{ title, status: fixed|open, blocksMerge: bool, owner: po|dev|sdk, detail }` — `title` tiếng Việt có
dấu, PO đọc được. `skills/feature/references/headless.md` mô tả; `headless_check.py build` bắt thiếu trường, sai giá trị, có
`review.findings` mà không có `issues`. Spec cũ không có `issues[]` → phần Vấn đề ghi "chưa có", findings nguyên văn ở Kỹ thuật.

### Code [T]
- `service/src/board/spec-detail.cjs`: model chi tiết (đọc DB + 2 file JSON), dùng chung cho card và trang.
- `service/src/web/page-spec-detail.cjs`: HTML. Route mới trong `web/routes.cjs`. Mỗi file < 200 dòng.
- `redact` mọi chữ; không lộ đường dẫn máy, token, secret. Lỗi đọc file → phần đó ghi "không đọc được", trang không vỡ.

## Ngoài phạm vi (bản đầu)
Ảnh board UI diff; lịch sử chi phí theo ngày; nút thao tác (duyệt, retry) — board vẫn chỉ xem.

## Rủi ro
- Map mã quyết định → bước làm tay; mã lạ hiện mã gốc.
- Bảng UI rộng khi nhiều vòng → chỉ 4 vòng gần nhất.
- Vấn đề chỉ đọc được cho PO từ lượt build sau khi đổi hợp đồng; spec #3 hiện tại hiện findings nguyên văn.

## Kiểm tra thành công
- Card spec #3 hiện đúng bước hiện tại, chờ ai/đang chạy gì, số vấn đề; link mở trang chi tiết.
- Trang chi tiết spec #3 đủ 5 phần, không lỗi khi thiếu `result.json`/`progress.json`.
- Token board project khác không mở được spec của project này.
- `headless_check.py build` đỏ khi thiếu `issues[]` hoặc sai giá trị; suite service + test Python xanh.
