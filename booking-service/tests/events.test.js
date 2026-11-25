// Tests for the audit trail, signed event webhooks, the metrics panel and alerts.
// Fake webhook servers stand in for the Trip service and for Discord/Teams.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';
process.env.WEBHOOK_SECRET = 'test-webhook-secret-that-is-long-enough-0123';
process.env.ALERT_DENIED_THRESHOLD = '5';
process.env.ALERT_FLEET_THRESHOLD = '2';

jest.mock('../clients/fleetClient', () => ({ listAvailableCars: jest.fn(), getCar: jest.fn(), checkAvailability: jest.fn() }));
jest.mock('../clients/routeClient', () => ({ estimateTrip: jest.fn() }));

const http = require('http');
const crypto = require('crypto');
const request = require('supertest');
const { createTestDb } = require('./testDb');
const { signToken } = require('../middleware/auth');
const fleetClient = require('../clients/fleetClient');
const routeClient = require('../clients/routeClient');
const { verify } = require('../clients/eventPublisher');
const { HttpError } = require('../utils/errors');
const app = require('../server');

const u = (role, name) => ({ id: crypto.randomUUID(), name, role });
const sara = u('Employee', 'Sara');
const omar = u('Employee', 'Omar');
const admin = u('FleetAdmin', 'Fleet Admin');
const auth = (user) => ({ Authorization: `Bearer ${signToken(user)}` });
const car = { id: crypto.randomUUID(), plateNumber: 'ABC 123', make: 'Toyota', model: 'Corolla', year: 2022, type: 'Sedan', seats: 5 };

let sql;
let received;       // what the fake Trip webhook received
let alerts;         // what the fake Discord webhook received
let servers;
let day = 0;

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler).listen(0, () => resolve(server));
  });
}
const readBody = (req) => new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => resolve(b)); });

function newBooking() {
  day += 1;
  const start = new Date(Date.now() + (24 * day + 2) * 3600e3);
  return { vehicleId: car.id, startAt: start.toISOString(), endAt: new Date(start.getTime() + 3 * 3600e3).toISOString(),
    purpose: 'Client meeting downtown', destination: 'Downtown Cairo', passengers: 2 };
}

beforeAll(async () => {
  ({ sql } = await createTestDb());
  const trip = await listen(async (req, res) => {
    const body = await readBody(req);
    received.push({ headers: req.headers, body });
    res.writeHead(200).end('{}');
  });
  const discord = await listen(async (req, res) => {
    alerts.push(JSON.parse(await readBody(req)));
    res.writeHead(204).end();
  });
  servers = [trip, discord];
  process.env.EVENT_WEBHOOK_URLS = `http://127.0.0.1:${trip.address().port}/hooks/booking`;
  process.env.ALERT_WEBHOOK_URL = `http://127.0.0.1:${discord.address().port}/discord`;
});

afterAll(async () => { await Promise.all(servers.map((s) => new Promise((r) => s.close(r)))); });

beforeEach(async () => {
  received = [];
  alerts = [];
  await sql`DELETE FROM booking_events`;
  fleetClient.getCar.mockResolvedValue(car);
  fleetClient.listAvailableCars.mockResolvedValue([car]);
  fleetClient.checkAvailability.mockResolvedValue({ available: true, reason: null });
  routeClient.estimateTrip.mockResolvedValue({ distanceKm: 12.5, durationMinutes: 20, source: 'OpenRouteService' });
});

describe('audit trail', () => {
  test('every change is recorded: created -> updated -> approved, with who and from/to status', async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    await request(app).patch(`/api/bookings/${created.id}`).set(auth(sara)).send({ purpose: 'Client meeting moved to Maadi' });
    await request(app).patch(`/api/bookings/${created.id}/status`).set(auth(admin)).send({ status: 'Approved' });

    const res = await request(app).get(`/api/bookings/${created.id}/history`).set(auth(sara));
    expect(res.status).toBe(200);
    expect(res.body.map((e) => e.type)).toEqual(['booking.created', 'booking.updated', 'booking.approved']);
    expect(res.body[1].details.changed).toEqual(['purpose']);
    expect(res.body[2]).toMatchObject({ fromStatus: 'Pending', toStatus: 'Approved', actorRole: 'FleetAdmin', byMe: false });
    expect(res.body[0].byMe).toBe(true);
  });

  test('a rejection keeps the reason in the history', async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    await request(app).patch(`/api/bookings/${created.id}/status`).set(auth(admin)).send({ status: 'Rejected', reason: 'Car needed for management.' });
    const res = await request(app).get(`/api/bookings/${created.id}/history`).set(auth(admin));
    expect(res.body[1]).toMatchObject({ type: 'booking.rejected', details: { reason: 'Car needed for management.' } });
  });

  test("another employee cannot read someone else's history -> 403", async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    expect((await request(app).get(`/api/bookings/${created.id}/history`).set(auth(omar))).status).toBe(403);
  });

  test('a failed change records nothing', async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    await request(app).patch(`/api/bookings/${created.id}/status`).set(auth(sara)).send({ status: 'Approved' });   // 403
    const res = await request(app).get(`/api/bookings/${created.id}/history`).set(auth(sara));
    expect(res.body.map((e) => e.type)).toEqual(['booking.created']);
  });

  test('the API has no way to edit or delete events (no routes)', async () => {
    expect((await request(app).delete('/api/bookings/events').set(auth(admin))).status).toBe(404);
    expect((await request(app).patch('/api/bookings/events').set(auth(admin)).send({})).status).toBe(404);
  });
});

describe('signed event webhooks (to the Trip service)', () => {
  test('approval sends booking.approved with a valid HMAC signature and no free text', async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    received = [];
    await request(app).patch(`/api/bookings/${created.id}/status`).set(auth(admin)).send({ status: 'Approved', reason: 'ok go' });
    expect(received).toHaveLength(1);
    const { headers, body } = received[0];
    expect(headers['x-fleetdesk-event']).toBe('booking.approved');
    expect(verify(body, headers['x-fleetdesk-signature'], process.env.WEBHOOK_SECRET)).toBe(true);
    expect(verify(body, headers['x-fleetdesk-signature'], 'wrong-secret-wrong-secret-wrong-secret-123')).toBe(false);
    expect(verify(body.replace('Approved', 'Rejected'), headers['x-fleetdesk-signature'], process.env.WEBHOOK_SECRET)).toBe(false);
    const payload = JSON.parse(body);
    expect(payload.booking).toMatchObject({ id: created.id, status: 'Approved', estimate: { distanceKm: 12.5 } });
    expect(body).not.toContain('ok go');               // reasons stay in the audit trail only
    expect(body).not.toContain('Client meeting');      // so does the purpose
  });

  test('an old signature is rejected (replay protection)', () => {
    const { sign } = require('../clients/eventPublisher');
    const old = sign('{"a":1}', process.env.WEBHOOK_SECRET, Math.floor(Date.now() / 1000) - 600);
    expect(verify('{"a":1}', old, process.env.WEBHOOK_SECRET)).toBe(false);
  });

  test('a webhook that is down does not break the booking; the event is marked failed', async () => {
    const saved = process.env.EVENT_WEBHOOK_URLS;
    process.env.EVENT_WEBHOOK_URLS = 'http://127.0.0.1:1/nothing-here';
    const res = await request(app).post('/api/bookings').set(auth(sara)).send(newBooking());
    process.env.EVENT_WEBHOOK_URLS = saved;
    expect(res.status).toBe(201);
    const rows = await sql`SELECT delivery FROM booking_events WHERE booking_id = ${res.body.id}`;
    expect(rows[0].delivery).toBe('failed');
    const metrics = await request(app).get('/api/bookings/metrics').set(auth(admin));
    expect(metrics.body.last24h.eventDeliveryFailures).toBeGreaterThanOrEqual(1);
  });

  test('admin event feed lists booking events; employees get 403', async () => {
    const created = (await request(app).post('/api/bookings').set(auth(sara)).send(newBooking())).body;
    await request(app).patch(`/api/bookings/${created.id}/status`).set(auth(sara)).send({ status: 'Cancelled' });
    const feed = await request(app).get('/api/bookings/events').set(auth(admin)).query({ type: 'booking.cancelled' });
    expect(feed.status).toBe(200);
    expect(feed.body[0]).toMatchObject({ type: 'booking.cancelled', bookingId: created.id, fromStatus: 'Pending', toStatus: 'Cancelled' });
    expect((await request(app).get('/api/bookings/events').set(auth(sara))).status).toBe(403);
    expect((await request(app).get('/api/bookings/events').set(auth(admin)).query({ type: 'security.forbidden' })).status).toBe(400);
  });
});

describe('monitoring and alerts', () => {
  test('401 and 403 are counted, and the metrics show them (no tokens stored)', async () => {
    await request(app).get('/api/bookings');                                                   // 401
    await request(app).get('/api/bookings').set('Authorization', 'Bearer not-a-real-token');   // 401
    await request(app).get('/api/bookings/metrics').set(auth(sara));                           // 403
    const res = await request(app).get('/api/bookings/metrics').set(auth(admin));
    expect(res.status).toBe(200);
    expect(res.body.last24h.unauthenticated).toBe(2);
    expect(res.body.last24h.forbidden).toBe(1);
    expect(res.body.recentSecurityEvents[0]).toMatchObject({ type: 'security.forbidden', path: '/api/bookings/metrics', actorRole: 'Employee' });
    const all = JSON.stringify(await sql`SELECT * FROM booking_events`);
    expect(all).not.toContain('not-a-real-token');
  });

  test('metrics include bookings by status', async () => {
    await request(app).post('/api/bookings').set(auth(sara)).send(newBooking());
    const res = await request(app).get('/api/bookings/metrics').set(auth(admin));
    expect(res.body.bookingsByStatus.Pending).toBeGreaterThanOrEqual(1);
    expect(res.body.alerting.channels).toEqual({ webhook: true, sns: false });
  });

  test('5 denied requests in 15 minutes send ONE alert (cooldown), with counts only', async () => {
    for (let i = 0; i < 7; i += 1) await request(app).get('/api/bookings').set('Authorization', 'Bearer bad');
    expect(alerts).toHaveLength(1);
    expect(alerts[0].content).toMatch(/many denied requests/);
    expect(alerts[0].content).toMatch(/5 in the last 15 minutes/);
    expect(alerts[0].content).not.toMatch(/Bearer|bad/);
    const res = await request(app).get('/api/bookings/metrics').set(auth(admin));
    expect(res.body.alerting.recentAlerts[0]).toMatchObject({ rule: 'denied', delivered: 'sent' });
  });

  test('the Fleet service failing twice raises the fleet alert', async () => {
    fleetClient.getCar.mockRejectedValue(new HttpError(503, 'FLEET_SERVICE_UNAVAILABLE', 'down'));
    await request(app).post('/api/bookings').set(auth(sara)).send(newBooking());
    await request(app).post('/api/bookings').set(auth(sara)).send(newBooking());
    expect(alerts.map((a) => a.content).join(' ')).toMatch(/Fleet service keeps failing/);
  });

  test('employees cannot see the metrics -> 403', async () => {
    expect((await request(app).get('/api/bookings/metrics').set(auth(sara))).status).toBe(403);
  });
});
