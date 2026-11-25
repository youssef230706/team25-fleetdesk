// Structured logs (section 6.2, "Logging and monitoring").
// One JSON line per request, plus extra lines for security events.
// Vercel Logs shows everything written with console.log / console.warn.
//
// Never logged: passwords, tokens, the Authorization header, DATABASE_URL, request bodies.

const crypto = require('crypto');

function requestLogger(req, res, next) {
  const started = Date.now();
  req.requestId = crypto.randomUUID();
  res.setHeader('X-Request-Id', req.requestId);

  res.on('finish', () => {
    if (process.env.NODE_ENV === 'test') return;
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      type: 'request',
      requestId: req.requestId,
      method: req.method,
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      userId: req.user ? req.user.id : null,
      durationMs: Date.now() - started
    }));
  });
  next();
}

// Security events: failed logins, lockouts, 401/403, rate limits, admin decisions.
function securityLog(req, event, status, extra = {}) {
  if (process.env.NODE_ENV === 'test') return;
  console.warn(JSON.stringify({
    time: new Date().toISOString(),
    type: 'security',
    event,
    status,
    requestId: req.requestId,
    method: req.method,
    path: req.originalUrl.split('?')[0],
    userId: req.user ? req.user.id : null,
    ip: req.ip,
    ...extra
  }));
}

module.exports = { requestLogger, securityLog };
