// POST and PATCH bodies must be JSON; anything else is refused with 415.

function requireJson(req, res, next) {
  if (['POST', 'PATCH', 'PUT'].includes(req.method) && !req.is('application/json')) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Send the body as JSON (Content-Type: application/json).' }
    });
  }
  return next();
}

module.exports = requireJson;
