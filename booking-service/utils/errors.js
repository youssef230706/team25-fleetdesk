// One error type for the whole service. Controllers and services throw it;
// middleware/errorHandler.js turns it into the Lab 3 error shape:
//   { "error": { "code": "...", "message": "..." } }

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new HttpError(400, 'VALIDATION_ERROR', message, details);
const unauthenticated = (message = 'Please log in first.') => new HttpError(401, 'UNAUTHENTICATED', message);
const forbidden = (message = 'You are not allowed to do this.') => new HttpError(403, 'FORBIDDEN', message);
const notFound = (what = 'Record') => new HttpError(404, 'NOT_FOUND', `${what} not found.`);
const conflict = (code, message) => new HttpError(409, code, message);

module.exports = { HttpError, badRequest, unauthenticated, forbidden, notFound, conflict };
