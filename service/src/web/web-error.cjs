const { firstLine } = require('../redact.cjs');

const MESSAGES = {
  NOT_FOUND: 'Link này không đúng hoặc đã hết hạn. Hãy mở link mới nhất bạn được gửi.',
  STATE: 'Phần này đã được gửi hoặc đang được xử lý, nên không sửa được nữa. Hãy tải lại trang.',
  STALE: 'Nội dung vừa có bản mới hơn bản bạn đang xem. Hãy tải lại trang rồi xem lại.',
  LIMITED: 'Có quá nhiều lần mở link sai. Hãy thử lại sau ít phút.',
  OPERATOR: 'Trang này chỉ dành cho người vận hành. Hãy mở bằng link có mã trên máy chạy dịch vụ.',
  REFUSED: 'Yêu cầu không đến từ trang này nên bị từ chối.',
  METHOD: 'Cách gọi này không được hỗ trợ.',
  MISSING_PAGE: 'Không có trang này.',
  TOO_LARGE: 'Nội dung quá dài. Hãy rút gọn hoặc gửi bằng link.',
  TYPE: 'Nội dung gửi lên không đúng kiểu.',
  INTERNAL: 'Có lỗi ở phía máy chủ. Hãy thử lại sau ít phút.',
};

const FACADE_STATUS = { NOT_FOUND: 404, STATE: 409, INVALID: 400, STALE: 409 };

class WebError extends Error {
  constructor(status, code, message = MESSAGES[code], extra = {}) {
    super(message);
    this.name = 'WebError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const invalid = message => new WebError(400, 'INVALID', message);
const closed = () => new WebError(409, 'STATE');
const stale = () => new WebError(409, 'STALE');

function toWebError(error) {
  if (error instanceof WebError) return error;
  const status = Object.hasOwn(FACADE_STATUS, error?.code ?? '') ? FACADE_STATUS[error.code] : 500;
  if (status === 500) return new WebError(500, 'INTERNAL');
  return new WebError(status, error.code, error.code === 'INVALID' ? firstLine(error) : MESSAGES[error.code]);
}

module.exports = { WebError, toWebError, invalid, closed, stale };
