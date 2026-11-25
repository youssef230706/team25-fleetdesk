// Rate limiting (threat: bots using up the free quotas).
// On Vercel each function instance keeps its own counter, so these limits are per instance.

const rateLimit = require('express-rate-limit');
const { securityLog } = require('./logger');
const monitor = require('../services/monitor');

function limiter({ windowMs, limit, message, keyGenerator }) {
  return rateLimit({
    windowMs,
    limit,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator,
    skip: () => process.env.NODE_ENV === 'test' && process.env.TEST_RATE_LIMIT !== 'on',
    handler: async (req, res) => {
      securityLog(req, 'rate_limited', 429);
      await monitor.recordSecurity('security.rate_limited', req);
      res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message } });
    }
  });
}

// Whole API: 100 requests per minute per IP (same as the Fleet service).
const apiLimiter = limiter({ windowMs: 60 * 1000, limit: 100, message: 'Too many requests. Please wait a minute.' });

// Trip estimates: 10 per minute per logged-in user, to protect the free OpenRouteService quota.
// Used after requireAuth, so req.user is always set.
const estimateLimiter = limiter({
  windowMs: 60 * 1000,
  limit: 10,
  message: 'Too many trip estimates. Please wait a minute.',
  keyGenerator: (req) => `user:${req.user.id}`
});

module.exports = { apiLimiter, estimateLimiter };
