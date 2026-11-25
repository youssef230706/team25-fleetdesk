// Tests for the two outside calls, with fake servers instead of the real ones:
//   fleetClient -> Kareem's Fleet API     routeClient -> OpenRouteService

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

const http = require('http');

let server;
let lastRequest;
let reply;   // (req) -> { status, body }

beforeAll((done) => {
  server = http.createServer((req, res) => {
    lastRequest = { url: req.url, auth: req.headers.authorization };
    const { status, body } = reply(req);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
    }).listen(0, done);
});
afterAll((done) => { server.close(done); });

const fakeUrl = () => `http://127.0.0.1:${server.address().port}`;

describe('fleetClient', () => {
  const fleet = require('../clients/fleetClient');
  const from = new Date('2026-12-01T09:00:00Z');
  const to = new Date('2026-12-01T13:00:00Z');

  beforeEach(() => { process.env.FLEET_API_URL = fakeUrl(); process.env.NODE_ENV = 'test'; });
  afterAll(() => { delete process.env.FLEET_API_URL; });

  test('availability: sends dates and the user token, reads the answer', async () => {
    reply = () => ({ status: 200, body: { vehicleId: 'v1', available: false, reason: 'MAINTENANCE_SCHEDULED' } });
    const result = await fleet.checkAvailability('v1', from, to, 'Bearer abc');
    expect(result.available).toBe(false);
    expect(lastRequest.url).toBe('/api/vehicles/v1/availability?from=2026-12-01T09%3A00%3A00.000Z&to=2026-12-01T13%3A00%3A00.000Z');
    expect(lastRequest.auth).toBe('Bearer abc');
  });

  test('availability: unknown car (404) -> 400', async () => {
    reply = () => ({ status: 404, body: { error: { code: 'NOT_FOUND' } } });
    await expect(fleet.checkAvailability('v1', from, to, 'Bearer abc')).rejects.toMatchObject({ status: 400 });
  });

  test('availability: unexpected answer -> 503 (fail closed)', async () => {
    reply = () => ({ status: 200, body: { available: 'maybe' } });
    await expect(fleet.checkAvailability('v1', from, to, 'Bearer abc')).rejects.toMatchObject({ status: 503 });
  });

  test('Fleet error 500 -> 503 (fail closed)', async () => {
    reply = () => ({ status: 500, body: {} });
    await expect(fleet.listAvailableCars('Bearer abc')).rejects.toMatchObject({ status: 503 });
  });

  test('list cars asks only for Available ones', async () => {
    reply = () => ({ status: 200, body: [{ id: 'v1', seats: 5 }] });
    expect(await fleet.listAvailableCars('Bearer abc')).toHaveLength(1);
    expect(lastRequest.url).toBe('/api/vehicles?status=Available');
  });

  test('getCar: 404 -> null', async () => {
    reply = () => ({ status: 404, body: {} });
    expect(await fleet.getCar('v1', 'Bearer abc')).toBeNull();
  });

  test('Fleet not reachable -> 503', async () => {
    process.env.FLEET_API_URL = 'http://127.0.0.1:1';
    await expect(fleet.getCar('v1', 'Bearer abc')).rejects.toMatchObject({ status: 503 });
  });

  test('FLEET_API_URL missing in production -> 503', async () => {
    delete process.env.FLEET_API_URL;
    process.env.NODE_ENV = 'production';
    await expect(fleet.getCar('v1', 'Bearer abc')).rejects.toMatchObject({ status: 503 });
  });
});

describe('routeClient (OpenRouteService)', () => {
  const route = require('../clients/routeClient');

  beforeEach(() => {
    process.env.ORS_BASE_URL = fakeUrl();
    process.env.ORS_API_KEY = 'test-key';
    route._cache.clear();
  });

  test('geocodes, then asks for a route from the company, and rounds the answer', async () => {
    const seen = [];
    reply = (req) => {
      seen.push(req.url);
      if (req.url.startsWith('/pelias/v1/search')) {
        return { status: 200, body: { features: [{ geometry: { coordinates: [31.02, 30.07] }, properties: { label: 'Smart Village, Giza' } }] } };
      }
      return { status: 200, body: { features: [{ properties: { summary: { distance: 31456, duration: 2290 } } }] } };
    };
    const result = await route.estimateTrip('Smart Village');
    expect(result).toEqual({ destinationLabel: 'Smart Village, Giza', distanceKm: 31.5, durationMinutes: 38, source: 'OpenRouteService' });
    expect(seen[1]).toMatch(/^\/openrouteservice\/v2\/directions\/driving-car\?/);
    expect(seen[1]).toContain('start=31.4913%2C30.0131');
    expect(seen[1]).toContain('end=31.02%2C30.07');

    // Second time: from the cache, no new calls.
    await route.estimateTrip('smart village ');
    expect(seen).toHaveLength(2);
  });

  test('place not found -> 400', async () => {
    reply = () => ({ status: 200, body: { features: [] } });
    await expect(route.estimateTrip('Nowhere at all')).rejects.toMatchObject({ status: 400 });
  });

  test('ORS error -> 502', async () => {
    reply = () => ({ status: 500, body: {} });
    await expect(route.estimateTrip('Cairo')).rejects.toMatchObject({ status: 502 });
  });

  test('no API key -> 503', async () => {
    delete process.env.ORS_API_KEY;
    await expect(route.estimateTrip('Cairo')).rejects.toMatchObject({ status: 503 });
  });
});
