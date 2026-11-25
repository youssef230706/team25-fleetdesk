// Talks to Kareem's Fleet & Maintenance service (a separately deployed API).
// Contract (docs/fleet-api.md):
//   GET {FLEET_API_URL}/api/vehicles?status=Available            -> the cars (employee or admin view)
//   GET {FLEET_API_URL}/api/vehicles/{id}                        -> one car, 404 if unknown
//   GET {FLEET_API_URL}/api/vehicles/{id}/availability?from=&to= -> { available, reason }
// We always forward the user's own token, so Fleet applies its own role rules.
//
// Fail closed: if Fleet cannot be reached, we do NOT create or approve a booking,
// because we could not prove the car is free (retired, in maintenance...).

const { HttpError, badRequest } = require('../utils/errors');

const unavailable = () => new HttpError(503, 'FLEET_SERVICE_UNAVAILABLE',
  'Could not check the car with the Fleet service right now. Please try again later.');

function baseUrl() {
  const url = process.env.FLEET_API_URL;
  if (url) return url;
  if (process.env.NODE_ENV === 'production') throw unavailable();
  return 'http://localhost:3001';   // local development: Kareem's API on its usual port
}

async function get(path, authorizationHeader, query) {
  const url = new URL(path, baseUrl());
  Object.entries(query || {}).forEach(([key, value]) => url.searchParams.set(key, value));
  let response;
  try {
    response = await fetch(url, {
      headers: { Authorization: authorizationHeader, Accept: 'application/json' },
      signal: AbortSignal.timeout(5000)
    });
  } catch (error) {
    console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'fleet_call_failed', path, message: error.message }));
    throw unavailable();
  }
  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

// Cars that are in service (not retired, not in maintenance right now).
async function listAvailableCars(authorizationHeader) {
  const { status, body } = await get('/api/vehicles', authorizationHeader, { status: 'Available' });
  if (status !== 200 || !Array.isArray(body)) throw unavailable();
  return body;
}

async function getCar(vehicleId, authorizationHeader) {
  const { status, body } = await get(`/api/vehicles/${encodeURIComponent(vehicleId)}`, authorizationHeader);
  if (status === 404) return null;
  if (status !== 200 || !body || !body.id) throw unavailable();
  return body;
}

// { available: true|false, reason: null | 'RETIRED' | 'IN_MAINTENANCE' | 'MAINTENANCE_SCHEDULED' }
async function checkAvailability(vehicleId, from, to, authorizationHeader) {
  const { status, body } = await get(`/api/vehicles/${encodeURIComponent(vehicleId)}/availability`, authorizationHeader, {
    from: from.toISOString(),
    to: to.toISOString()
  });
  if (status === 404) throw badRequest('vehicleId does not match any company car.');
  if (status !== 200 || !body || typeof body.available !== 'boolean') throw unavailable();
  return body;
}

module.exports = { listAvailableCars, getCar, checkAvailability };
