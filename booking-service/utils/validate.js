// Server-side input checks (section 6.2, "Input validation").
// The browser checks are only for convenience; these are the ones that count.
// Each helper returns the cleaned value or throws a 400 VALIDATION_ERROR.

const { badRequest } = require('./errors');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function text(body, field, { min = 1, max = 100, required = true } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'string') throw badRequest(`${field} must be text.`);
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(`${field} must be between ${min} and ${max} characters.`);
  }
  return trimmed;
}

function integer(body, field, { min, max, required = true } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  if (!Number.isInteger(value)) throw badRequest(`${field} must be a whole number.`);
  if (value < min || value > max) throw badRequest(`${field} must be between ${min} and ${max}.`);
  return value;
}

function money(body, field, { required = false } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000000) {
    throw badRequest(`${field} must be a number between 0 and 1,000,000.`);
  }
  return Math.round(value * 100) / 100;
}

function oneOf(body, field, allowed, { required = true } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}.`);
  return value;
}

function date(body, field, { required = true } = {}) {
  const value = body[field];
  if (value === undefined || value === null || value === '') {
    if (required) throw badRequest(`${field} is required.`);
    return undefined;
  }
  // Accept ISO dates only, e.g. 2026-11-25 or 2026-11-25T09:00:00Z
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/.test(value)) {
    throw badRequest(`${field} must be an ISO date such as 2026-11-25 or 2026-11-25T09:00:00Z.`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw badRequest(`${field} is not a real date.`);
  return parsed;
}

function dateRange(body, startField, endField, { allowPast = false } = {}) {
  const start = date(body, startField);
  const end = date(body, endField);
  if (end <= start) throw badRequest(`${endField} must be after ${startField}.`);
  if (!allowPast && start < new Date(Date.now() - 24 * 60 * 60 * 1000)) {
    throw badRequest(`${startField} cannot be in the past.`);
  }
  if (end - start > 60 * 24 * 60 * 60 * 1000) throw badRequest('The period cannot be longer than 60 days.');
  return { start, end };
}

// Only accept the fields the client is allowed to set (Lab 3 rule:
// id, status, owner and timestamps are always set by the server).
function pick(body, allowed) {
  const result = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(body, key)) result[key] = body[key];
  }
  return result;
}

module.exports = { UUID_PATTERN, isUuid, text, integer, money, oneOf, date, dateRange, pick };
