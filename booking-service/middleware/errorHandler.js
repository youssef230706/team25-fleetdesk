// Central error handler (Lab 4). Known errors keep their status and message;
// anything unexpected becomes a generic 500 so stack traces and secrets never
// reach the browser (threat 7 in section 6.4).

const { HttpError } = require('../utils/errors');
const monitor = require('../services/monitor');

// Error responses that are worth counting for monitoring and alerts (Booking addition).
function securityEventFor(err) {
  if (err.status === 401) return 'security.unauthenticated';
  if (err.status === 403) return 'security.forbidden';
  if (err.status === 503 && err.code === 'FLEET_SERVICE_UNAVAILABLE') return 'fleet.unavailable';
  return null;
}

function notFoundRoute(req, res) {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `No route for ${req.method} ${req.path}` } });
}

// Express recognises an error handler by its 4 parameters.
// eslint-disable-next-line no-unused-vars
async function errorHandler(err, req, res, next) {
  // Body problems raised by express.json()
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'BODY_TOO_LARGE', message: 'The request body is too large.' } });
  }

  if (err instanceof HttpError) {
    const eventType = securityEventFor(err);
    if (eventType) await monitor.recordSecurity(eventType, req, { code: err.code });
    const body = { error: { code: err.code, message: err.message } };
    if (err.details) body.error.details = err.details;
    return res.status(err.status).json(body);
  }

  // Postgres exclusion violation: the database refused a second approved booking that overlaps
  // (constraint no_double_approved_booking in db/schema.sql).
  if (err.code === '23P01') {
    return res.status(409).json({ error: { code: 'VEHICLE_UNAVAILABLE', message: 'This car is already booked for part of that time.' } });
  }

  // Postgres unique violation (for example a duplicate plate number that slipped past the check)
  if (err.code === '23505') {
    return res.status(409).json({ error: { code: 'DUPLICATE', message: 'A record with this value already exists.' } });
  }

  // Unknown error: log the details on the server only.
  console.error(JSON.stringify({
    time: new Date().toISOString(),
    type: 'error',
    requestId: req.requestId,
    path: req.originalUrl.split('?')[0],
    message: err.message
  }));
  return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again later.' } });
}

module.exports = { notFoundRoute, errorHandler };
