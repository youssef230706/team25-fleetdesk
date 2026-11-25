// External API: OpenRouteService (https://openrouteservice.org, free key).
// Booking OWNS this call (Phase 1 feedback): it runs when an employee requests a car,
// and the estimate is saved with the booking. The Trip service reads it from the booking
// (GET /api/bookings/{id}) and compares it with the real mileage. It never calls ORS itself.
//
//   1. Geocode:    GET https://api.heigit.org/pelias/v1/search?text=<destination>  -> [longitude, latitude]
//   2. Directions: GET https://api.heigit.org/openrouteservice/v2/directions/driving-car?start=<company>&end=<destination>
// (The old host api.openrouteservice.org was shut down in November 2026; the same key works on api.heigit.org.)
//
// The key comes from ORS_API_KEY (environment variable, never in the code or GitHub).
// Results are cached for 24 hours per instance, so repeated places do not use the quota.

const { HttpError, badRequest } = require('../utils/errors');

const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const cache = new Map();

function baseUrl() {
  return process.env.ORS_BASE_URL || 'https://api.heigit.org';
}

function companyOrigin() {
  const [lon, lat] = (process.env.COMPANY_ORIGIN || '31.4913,30.0131').split(',').map(Number);
  return `${lon},${lat}`;
}

async function getJson(url, key) {
  const response = await fetch(url, {
    headers: { Accept: 'application/json, application/geo+json', Authorization: key },
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`OpenRouteService answered ${response.status}`);
  return response.json();
}

async function estimateTrip(destination) {
  const key = process.env.ORS_API_KEY;
  if (!key) throw new HttpError(503, 'ESTIMATE_UNAVAILABLE', 'Trip estimates are not set up yet (ORS_API_KEY is missing).');

  const cacheKey = destination.trim().toLowerCase();
  const cached = cache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.value;

  try {
    const geo = await getJson(`${baseUrl()}/pelias/v1/search?${new URLSearchParams({
      api_key: key, text: destination, size: '1', 'boundary.country': process.env.ORS_COUNTRY || 'EG'
    })}`, key);
    const place = geo.features && geo.features[0];
    if (!place) throw badRequest(`Could not find "${destination}". Try a more exact place name.`);

    const [lon, lat] = place.geometry.coordinates;
    const route = await getJson(`${baseUrl()}/openrouteservice/v2/directions/driving-car?${new URLSearchParams({
      api_key: key, start: companyOrigin(), end: `${lon},${lat}`
    })}`, key);
    const summary = route.features && route.features[0] && route.features[0].properties.summary;
    if (!summary) throw new Error('OpenRouteService returned no route');

    const value = {
      destinationLabel: place.properties.label || destination,
      distanceKm: Math.round((summary.distance / 1000) * 10) / 10,
      durationMinutes: Math.round(summary.duration / 60),
      source: 'OpenRouteService'
    };
    cache.set(cacheKey, { value, expires: Date.now() + CACHE_TTL_MS });
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'ors_failed', message: error.message }));
    throw new HttpError(502, 'ESTIMATE_FAILED', 'The trip estimate service is not reachable right now.');
  }
}

module.exports = { estimateTrip, _cache: cache };
