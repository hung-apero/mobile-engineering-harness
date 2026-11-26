class FacadeError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = 'FacadeError';
    this.code = code;
  }
}

const notFound = () => new FacadeError('NOT_FOUND', 'không có spec này');
const wrongState = () => new FacadeError('STATE', 'spec không ở bước này');
const invalid = message => new FacadeError('INVALID', message);
const stale = () => new FacadeError('STALE', 'nội dung đã đổi');

module.exports = { FacadeError, notFound, wrongState, invalid, stale };
