// Checks the login token on every protected request (section 6.2, "Authentication").
//
// SHARED: Booking and Trip services copy this file unchanged and use the same
// JWT_SECRET, so one login works for all three separately deployed services.

const jwt = require('jsonwebtoken');
const { unauthenticated } = require('../utils/errors');
const { securityLog } = require('./logger');

function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    // Fail closed: never run with a missing or weak secret.
    throw new Error('JWT_SECRET is missing or shorter than 32 characters.');
  }
  return secret;
}

function requireAuth(req, res, next) {
  const header = req.get('Authorization') || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    securityLog(req, 'auth_missing_token', 401);
    return next(unauthenticated());
  }

  try {
    // algorithms is fixed to HS256, so a token signed with "none" or another
    // algorithm is rejected (threat 5 in section 6.4).
    const payload = jwt.verify(token, getSecret(), { algorithms: ['HS256'], issuer: 'fleetdesk' });

    if (!payload.sub || !['Employee', 'FleetAdmin'].includes(payload.role)) {
      throw new Error('Token has no valid user or role');
    }
    req.user = { id: payload.sub, role: payload.role, name: payload.name };
    return next();
  } catch (error) {
    if (error.message && error.message.startsWith('JWT_SECRET')) return next(error);
    securityLog(req, error.name === 'TokenExpiredError' ? 'auth_token_expired' : 'auth_invalid_token', 401);
    return next(unauthenticated(error.name === 'TokenExpiredError'
      ? 'Your session has expired. Please log in again.'
      : 'Invalid login token. Please log in again.'));
  }
}

function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, name: user.name },
    getSecret(),
    { algorithm: 'HS256', expiresIn: '1h', issuer: 'fleetdesk' }
  );
}

module.exports = { requireAuth, signToken };
