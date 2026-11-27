const { firstLine } = require('../redact.cjs');

class DeskError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeskError';
    this.code = code;
  }
}

const FACADE_MESSAGES = {
  NOT_FOUND: 'Không tìm thấy spec này nữa.',
  STATE: 'Spec đã sang bước khác nên không ghi được.',
  STALE: 'Spec vừa có bản mới hơn. Hãy xem lại bản mới rồi trả lời vào tin của bản đó.',
};

const isDefinite = error => error instanceof DeskError || Object.hasOwn(FACADE_MESSAGES, error?.code ?? '') || error?.code === 'INVALID';

function toPublic(error) {
  if (error instanceof DeskError || error?.name === 'BotError') return { code: error.code, message: error.message, ...(error.retryAt && { retryAt: error.retryAt }) };
  if (error?.code === 'INVALID') return { code: 'INVALID', message: firstLine(error) };
  if (Object.hasOwn(FACADE_MESSAGES, error?.code ?? '')) return { code: error.code, message: FACADE_MESSAGES[error.code] };
  return { code: 'INTERNAL', message: 'Service gặp lỗi khi xử lý. Hãy báo dev trực.' };
}

module.exports = { DeskError, isDefinite, toPublic };
