// Role check (section 6.2, "Authorization").
// The role comes only from the verified token (req.user), never from the request body.
// Hiding admin buttons in the browser is only for convenience; this is the real check.

const { forbidden } = require('../utils/errors');
const { securityLog } = require('./logger');

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      securityLog(req, 'forbidden_role', 403);
      return next(forbidden('Only a Fleet Admin can do this.'));
    }
    return next();
  };
}

module.exports = requireRole;
