// Automated tests for the Booking service.
// Normal, invalid and security cases (brief: testing 5%, security controls 10%).
// The Fleet service and OpenRouteService are replaced by fakes, so no network is needed.
// Run with:  npm test

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-secret-that-is-long-enough-for-hs256-0123456789';

jest.mock('../clients/fleetClient', () => ({
  listAvailableCars: jest.fn(),
  getCar: jest.fn(),
  checkAvailability: jest.fn()
}));
jest.mock('../clients/routeClient', () => ({ estimateTrip: jest.fn() }));

const crypto = require('crypto');
const request = require('supertest');
const jwt = require('jsonwebtoken');
const { createTestDb } = require('./testDb');
const { signToken } = require('../middleware/auth');
const fleetClient = require('../clients/fleetClient');
const routeClient = require('../clients/routeClient');
const { HttpError } = require('../utils/errors');
const app = require('../server');

const users = {
  admin: { id: crypto.randomUUID(), name: 'Fleet Admin', role: 'FleetAdmin' },
  admin2: { id: crypto.randomUUID(), name: 'Second Admin', role: 'FleetAdmin' },
  sara: { id: crypto.randomUUID(), name: 'Sara', role: 'Employee' },
  omar: { id: crypto.randomUUID(), name: 'Omar', role: 'Employee' }
};
const tokens = Object.fromEntries(Object.entries(users).map(([key, user]) => [key, signToken(user)]));
const auth = (who) => ({ Authorization: `Bearer ${tokens[who]}` });

const cars = {
  corolla: { id: crypto.randomUUID(), plateNumber: 'ABC 123', make: 'Toyota', model: 'Corolla', year: 2022, type: 'Sedan', seats: 5, status: 'Available' },
  hiace: { id: crypto.randomUUID(), plateNumber: 'VAN 789', make: 'Toyota', model: 'Hiace', year: 2021, type: 'Van', seats: 12, status: 'Available' }
};
const allCars = Object.values(cars);
let fleetAnswers;   // vehicleId -> { available, reason }

const HOUR = 60 * 60 * 1000;
const at = (hoursFromNow) => new Date(Date.now() + hoursFromNow * HOUR).toISOString();

let sql;
let dayOffset = 0;
// Each test gets its own day, so bookings from earlier tests never overlap by accident.
function period(lengthHours = 4) {
  dayOffset += 1;
  const start = 24 * dayOffset + 1;
  return { startAt: at(start), endAt: at(start + lengthHours) };
}

function newBooking(overrides = {}) {
  return {
    vehicleId: cars.corolla.id,
    ...period(),
    purpose: 'Client meeting at Smart Village',
    destination: 'Smart Village, Giza',
    passengers: 2,
    ...overrides
  };
}

async function book(who, overrides) {
  const res = await request(app).post('/api/bookings').set(auth(who)).send(newBooking(overrides));
  expect(res.status).toBe(201);
  return res.body;
}

const setStatus = (who, id, body) => request(app).patch(`/api/bookings/${id}/status`).set(auth(who)).send(body);

beforeAll(async () => {
  ({ sql } = await createTestDb());
});

beforeEach(() => {
  fleetAnswers = {};
  fleetClient.listAvailableCars.mockImplementation(async () => allCars);
  fleetClient.getCar.mockImplementation(async (id) => allCars.find((car) => car.id === id) || null);
  fleetClient.checkAvailability.mockImplementation(async (id) => {
    if (!allCars.find((car) => car.id === id)) throw new HttpError(400, 'VALIDATION_ERROR', 'vehicleId does not match any company car.');
    return { vehicleId: id, available: true, reason: null, ...fleetAnswers[id] };
  });
  routeClient.estimateTrip.mockResolvedValue({ destinationLabel: 'Smart Village', distanceKm: 31.4, durationMinutes: 38, source: 'OpenRouteService' });
});

describe('health and setup', () => {
  test('GET /api/health works without a token', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body.service).toBe('booking');
  });

  test('unknown route -> 404 in the team error shape', async () => {
    const res = await request(app).get('/api/nothing-here');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBeDefined();
  });

  test('security headers are set and x-powered-by is hidden', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-powered-by']).toBeUndefined();
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
  });
});

describe('login token (shared JWT from the Fleet service)', () => {
  test('no token -> 401', async () => {
    const res = await request(app).get('/api/bookings');
    expect(res.status).toBe(401);
  });

  test('token signed with another secret -> 401', async () => {
    const fake = jwt.sign({ sub: users.sara.id, role: 'FleetAdmin', name: 'Sara' }, 'another-secret-that-is-also-long-enough-123456', { issuer: 'fleetdesk', expiresIn: '1h' });
    const res = await request(app).get('/api/bookings').set('Authorization', `Bearer ${fake}`);
    expect(res.status).toBe(401);
  });

  test('expired token -> 401', async () => {
    const old = jwt.sign({ sub: users.sara.id, role: 'Employee', name: 'Sara' }, process.env.JWT_SECRET, { issuer: 'fleetdesk', expiresIn: -10 });
    const res = await request(app).get('/api/bookings').set('Authorization', `Bearer ${old}`);
    expect(res.status).toBe(401);
  });

  test('"none" algorithm token -> 401', async () => {
    const unsigned = jwt.sign({ sub: users.sara.id, role: 'FleetAdmin' }, null, { algorithm: 'none', issuer: 'fleetdesk' });
    const res = await request(app).get('/api/bookings').set('Authorization', `Bearer ${unsigned}`);
    expect(res.status).toBe(401);
  });
});

describe('search free cars', () => {
  test('lists cars that fit the passengers, smallest first', async () => {
    const { startAt, endAt } = period();
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: startAt, to: endAt, seats: 2 });
    expect(res.status).toBe(200);
    expect(res.body.cars.map((car) => car.plateNumber)).toEqual(['ABC 123', 'VAN 789']);
  });

  test('more passengers than a sedan -> only the van', async () => {
    const { startAt, endAt } = period();
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: startAt, to: endAt, seats: 8 });
    expect(res.body.cars.map((car) => car.plateNumber)).toEqual(['VAN 789']);
  });

  test('a car with maintenance in that period (Fleet says no) is hidden', async () => {
    fleetAnswers[cars.corolla.id] = { available: false, reason: 'MAINTENANCE_SCHEDULED' };
    const { startAt, endAt } = period();
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: startAt, to: endAt });
    expect(res.body.cars.map((car) => car.plateNumber)).toEqual(['VAN 789']);
  });

  test('a car with an approved booking in that period is hidden', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    const res = await request(app).get('/api/bookings/availability').set(auth('omar'))
      .query({ from: booking.startAt, to: booking.endAt });
    expect(res.body.cars.map((car) => car.plateNumber)).toEqual(['VAN 789']);
  });

  test('dates in the past -> 400', async () => {
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: at(-48), to: at(-44) });
    expect(res.status).toBe(400);
  });

  test('to before from -> 400', async () => {
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: at(30), to: at(28) });
    expect(res.status).toBe(400);
  });

  test('longer than 14 days -> 400', async () => {
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: at(24), to: at(24 + 15 * 24) });
    expect(res.status).toBe(400);
  });

  test('more than 90 days ahead -> 400', async () => {
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: at(24 * 95), to: at(24 * 95 + 3) });
    expect(res.status).toBe(400);
  });

  test('seats = 0 -> 400', async () => {
    const { startAt, endAt } = period();
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: startAt, to: endAt, seats: 0 });
    expect(res.status).toBe(400);
  });

  test('Fleet service down -> 503 (fail closed)', async () => {
    fleetClient.listAvailableCars.mockRejectedValue(new HttpError(503, 'FLEET_SERVICE_UNAVAILABLE', 'down'));
    const { startAt, endAt } = period();
    const res = await request(app).get('/api/bookings/availability').set(auth('sara'))
      .query({ from: startAt, to: endAt });
    expect(res.status).toBe(503);
  });
});

describe('request a car', () => {
  test('creates a Pending booking with the trip estimate; owner comes from the token', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).send(newBooking());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('Pending');
    expect(res.body.userId).toBe(users.sara.id);
    expect(res.body.userName).toBe('Sara');
    expect(res.body.vehiclePlate).toBe('ABC 123');
    expect(res.body.estimate).toEqual({ distanceKm: 31.4, durationMinutes: 38, source: 'OpenRouteService' });
  });

  test('checks Fleet availability with the user\'s own token', async () => {
    await book('sara');
    expect(fleetClient.checkAvailability).toHaveBeenCalledWith(
      cars.corolla.id, expect.any(Date), expect.any(Date), `Bearer ${tokens.sara}`);
  });

  test('extra fields (userId, status) in the body are ignored (mass assignment)', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara'))
      .send(newBooking({ userId: users.omar.id, status: 'Approved', decidedBy: users.admin.id }));
    expect(res.status).toBe(201);
    expect(res.body.userId).toBe(users.sara.id);
    expect(res.body.status).toBe('Pending');
    expect(res.body.decidedBy).toBeNull();
  });

  test('ORS down -> the booking is still created, without an estimate', async () => {
    routeClient.estimateTrip.mockRejectedValue(new HttpError(502, 'ESTIMATE_FAILED', 'down'));
    const res = await request(app).post('/api/bookings').set(auth('sara')).send(newBooking());
    expect(res.status).toBe(201);
    expect(res.body.estimate).toBeNull();
  });

  test('car in maintenance (Fleet says no) -> 409', async () => {
    fleetAnswers[cars.corolla.id] = { available: false, reason: 'IN_MAINTENANCE' };
    const res = await request(app).post('/api/bookings').set(auth('sara')).send(newBooking());
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('VEHICLE_UNAVAILABLE');
  });

  test('retired / unknown car -> 400', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara'))
      .send(newBooking({ vehicleId: crypto.randomUUID() }));
    expect(res.status).toBe(400);
  });

  test('more passengers than seats -> 400', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).send(newBooking({ passengers: 7 }));
    expect(res.status).toBe(400);
  });

  test('car already approved for part of that time -> 409', async () => {
    const first = await book('sara');
    await setStatus('admin', first.id, { status: 'Approved' });
    const res = await request(app).post('/api/bookings').set(auth('omar'))
      .send(newBooking({ startAt: first.startAt, endAt: first.endAt }));
    expect(res.status).toBe(409);
  });

  test('two Pending requests for the same car are allowed (the admin picks one)', async () => {
    const first = await book('sara');
    const res = await request(app).post('/api/bookings').set(auth('omar'))
      .send(newBooking({ startAt: first.startAt, endAt: first.endAt }));
    expect(res.status).toBe(201);
  });

  test('the same employee cannot hold two bookings at the same time -> 409', async () => {
    const first = await book('sara');
    const res = await request(app).post('/api/bookings').set(auth('sara'))
      .send(newBooking({ vehicleId: cars.hiace.id, startAt: first.startAt, endAt: first.endAt }));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('OVERLAPPING_BOOKING');
  });

  test.each([
    ['missing purpose', { purpose: undefined }],
    ['purpose too short', { purpose: 'abc' }],
    ['destination too long', { destination: 'x'.repeat(151) }],
    ['bad vehicleId', { vehicleId: 'car-1' }],
    ['bad date', { startAt: 'tomorrow' }],
    ['passengers as text', { passengers: '2' }],
    ['16 passengers', { passengers: 16 }]
  ])('invalid input (%s) -> 400', async (name, change) => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).send(newBooking(change));
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  test('a script tag is stored as plain text, not run', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara'))
      .send(newBooking({ purpose: '<script>alert(1)</script> trip' }));
    expect(res.status).toBe(201);
    expect(res.body.purpose).toBe('<script>alert(1)</script> trip');
  });

  test('SQL injection text is stored as text (parameterised queries)', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara'))
      .send(newBooking({ destination: "Cairo'; DROP TABLE bookings; --" }));
    expect(res.status).toBe(201);
    const rows = await sql`SELECT count(*)::int AS n FROM bookings`;
    expect(rows[0].n).toBeGreaterThan(0);
  });

  test('not JSON -> 415', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).set('Content-Type', 'text/plain').send('hello');
    expect(res.status).toBe(415);
  });

  test('broken JSON -> 400', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).set('Content-Type', 'application/json').send('{"purpose":');
    expect(res.status).toBe(400);
  });

  test('body over 10kb -> 413', async () => {
    const res = await request(app).post('/api/bookings').set(auth('sara')).send({ purpose: 'x'.repeat(12000) });
    expect(res.status).toBe(413);
  });
});

describe('who can see which booking', () => {
  test('an employee only lists their own bookings', async () => {
    await book('omar');
    const res = await request(app).get('/api/bookings').set(auth('sara'));
    expect(res.status).toBe(200);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body.every((b) => b.userId === users.sara.id)).toBe(true);
  });

  test('an admin lists everyone\'s bookings, and the Pending queue is oldest first', async () => {
    const res = await request(app).get('/api/bookings').set(auth('admin')).query({ status: 'Pending' });
    expect(res.status).toBe(200);
    const owners = new Set(res.body.map((b) => b.userId));
    expect(owners.has(users.sara.id) && owners.has(users.omar.id)).toBe(true);
    const created = res.body.map((b) => new Date(b.createdAt).getTime());
    expect([...created].sort((a, b) => a - b)).toEqual(created);
  });

  test('another employee\'s booking -> 403 (IDOR)', async () => {
    const booking = await book('omar');
    const res = await request(app).get(`/api/bookings/${booking.id}`).set(auth('sara'));
    expect(res.status).toBe(403);
  });

  test('owner and admin can read one booking (the Trip service reads the estimate here)', async () => {
    const booking = await book('sara');
    expect((await request(app).get(`/api/bookings/${booking.id}`).set(auth('sara'))).status).toBe(200);
    const res = await request(app).get(`/api/bookings/${booking.id}`).set(auth('admin'));
    expect(res.status).toBe(200);
    expect(res.body.estimate.distanceKm).toBe(31.4);
  });

  test('unknown or badly formed id -> 404', async () => {
    expect((await request(app).get(`/api/bookings/${crypto.randomUUID()}`).set(auth('sara'))).status).toBe(404);
    expect((await request(app).get('/api/bookings/not-an-id').set(auth('sara'))).status).toBe(404);
  });

  test('bad status filter -> 400', async () => {
    const res = await request(app).get('/api/bookings').set(auth('admin')).query({ status: 'Done' });
    expect(res.status).toBe(400);
  });
});

describe('edit a booking', () => {
  test('owner edits a Pending booking; a new destination gets a new estimate', async () => {
    const booking = await book('sara');
    routeClient.estimateTrip.mockResolvedValue({ distanceKm: 120, durationMinutes: 95, source: 'OpenRouteService' });
    const res = await request(app).patch(`/api/bookings/${booking.id}`).set(auth('sara'))
      .send({ destination: 'Alexandria', purpose: 'Visit the Alexandria branch' });
    expect(res.status).toBe(200);
    expect(res.body.destination).toBe('Alexandria');
    expect(res.body.estimate.distanceKm).toBe(120);
  });

  test('someone else cannot edit it -> 403', async () => {
    const booking = await book('sara');
    const res = await request(app).patch(`/api/bookings/${booking.id}`).set(auth('omar')).send({ purpose: 'Taking over this trip' });
    expect(res.status).toBe(403);
  });

  test('an approved booking cannot be edited -> 409', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    const res = await request(app).patch(`/api/bookings/${booking.id}`).set(auth('sara')).send({ purpose: 'Changed my mind' });
    expect(res.status).toBe(409);
  });

  test('only one of startAt / endAt -> 400', async () => {
    const booking = await book('sara');
    const res = await request(app).patch(`/api/bookings/${booking.id}`).set(auth('sara')).send({ startAt: at(500) });
    expect(res.status).toBe(400);
  });
});

describe('approve and reject', () => {
  test('admin approves a Pending booking (after checking Fleet again)', async () => {
    const booking = await book('sara');
    fleetClient.checkAvailability.mockClear();
    const res = await setStatus('admin', booking.id, { status: 'Approved' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Approved');
    expect(res.body.decidedBy).toBe('Fleet Admin');
    expect(fleetClient.checkAvailability).toHaveBeenCalledTimes(1);
  });

  test('admin rejects with a reason', async () => {
    const booking = await book('sara');
    const res = await setStatus('admin', booking.id, { status: 'Rejected', reason: 'The car is needed by management.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Rejected');
    expect(res.body.decisionReason).toBe('The car is needed by management.');
  });

  test('reject without a reason -> 400', async () => {
    const booking = await book('sara');
    expect((await setStatus('admin', booking.id, { status: 'Rejected' })).status).toBe(400);
  });

  test('an employee cannot approve -> 403', async () => {
    const booking = await book('omar');
    expect((await setStatus('sara', booking.id, { status: 'Approved' })).status).toBe(403);
    expect((await setStatus('omar', booking.id, { status: 'Approved' })).status).toBe(403);
  });

  test('an admin cannot approve their own booking -> 403', async () => {
    const booking = await book('admin');
    expect((await setStatus('admin', booking.id, { status: 'Approved' })).status).toBe(403);
    expect((await setStatus('admin2', booking.id, { status: 'Approved' })).status).toBe(200);
  });

  test('deciding twice -> 409', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    const res = await setStatus('admin2', booking.id, { status: 'Rejected', reason: 'Too late now.' });
    expect(res.status).toBe(409);
  });

  test('maintenance was scheduled after the request -> approval refused with 409', async () => {
    const booking = await book('sara');
    fleetAnswers[cars.corolla.id] = { available: false, reason: 'MAINTENANCE_SCHEDULED' };
    const res = await setStatus('admin', booking.id, { status: 'Approved' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/maintenance/i);
  });

  test('two Pending requests for the same slot: approving the second one after the first -> 409', async () => {
    const first = await book('sara');
    const second = await book('omar', { startAt: first.startAt, endAt: first.endAt });
    expect((await setStatus('admin', first.id, { status: 'Approved' })).status).toBe(200);
    const res = await setStatus('admin', second.id, { status: 'Approved' });
    expect(res.status).toBe(409);
  });

  test('Fleet service down while approving -> 503 and the booking stays Pending', async () => {
    const booking = await book('sara');
    fleetClient.checkAvailability.mockRejectedValue(new HttpError(503, 'FLEET_SERVICE_UNAVAILABLE', 'down'));
    expect((await setStatus('admin', booking.id, { status: 'Approved' })).status).toBe(503);
    const check = await request(app).get(`/api/bookings/${booking.id}`).set(auth('sara'));
    expect(check.body.status).toBe('Pending');
  });

  test('unknown status value -> 400', async () => {
    const booking = await book('sara');
    expect((await setStatus('admin', booking.id, { status: 'Pending' })).status).toBe(400);
    expect((await setStatus('admin', booking.id, { status: 'Whatever' })).status).toBe(400);
  });
});

describe('cancel', () => {
  test('owner cancels their own Pending or Approved booking', async () => {
    const pending = await book('sara');
    expect((await setStatus('sara', pending.id, { status: 'Cancelled' })).body.status).toBe('Cancelled');
    const approved = await book('sara');
    await setStatus('admin', approved.id, { status: 'Approved' });
    expect((await setStatus('sara', approved.id, { status: 'Cancelled' })).status).toBe(200);
  });

  test('a cancelled booking frees the car again', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    await setStatus('sara', booking.id, { status: 'Cancelled' });
    const res = await request(app).get('/api/bookings/conflicts').set(auth('admin'))
      .query({ vehicleId: cars.corolla.id, from: booking.startAt, to: booking.endAt });
    expect(res.body).toEqual({ conflict: false });
  });

  test('another employee cannot cancel it -> 403', async () => {
    const booking = await book('sara');
    expect((await setStatus('omar', booking.id, { status: 'Cancelled' })).status).toBe(403);
  });

  test('admin cancelling someone else\'s booking needs a reason', async () => {
    const booking = await book('sara');
    expect((await setStatus('admin', booking.id, { status: 'Cancelled' })).status).toBe(400);
    expect((await setStatus('admin', booking.id, { status: 'Cancelled', reason: 'Car sent for repair.' })).status).toBe(200);
  });

  test('cancelling twice -> 409', async () => {
    const booking = await book('sara');
    await setStatus('sara', booking.id, { status: 'Cancelled' });
    expect((await setStatus('sara', booking.id, { status: 'Cancelled' })).status).toBe(409);
  });
});

describe('complete (Trip, Fuel & Reporting check-in)', () => {
  // A trip that has already started: written straight into the database,
  // because the API (correctly) refuses to create bookings in the past.
  // Each one uses its own car id, so they never overlap (the real Neon constraint would refuse it).
  async function startedTrip(userId = users.sara.id) {
    const rows = await sql`
      INSERT INTO bookings (user_id, user_name, vehicle_id, vehicle_plate, vehicle_label, purpose, destination,
                            passengers, start_at, end_at, status, estimated_km, estimated_minutes)
      VALUES (${userId}, 'Sara', ${crypto.randomUUID()}, 'VAN 789', 'Toyota Hiace (2021)', 'Site visit in October',
              'October City', 3, ${new Date(Date.now() - 2 * HOUR)}, ${new Date(Date.now() + 2 * HOUR)}, 'Approved', 40.2, 45)
      RETURNING id`;
    return rows[0].id;
  }

  test('owner completes a started trip with the real distance (estimate vs actual)', async () => {
    const id = await startedTrip();
    const res = await setStatus('sara', id, { status: 'Completed', actualKm: 43.6 });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('Completed');
    expect(res.body.estimate.distanceKm).toBe(40.2);
    expect(res.body.actualKm).toBe(43.6);
  });

  test('a trip that has not started cannot be completed -> 409', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    expect((await setStatus('sara', booking.id, { status: 'Completed' })).status).toBe(409);
  });

  test('a started trip cannot be cancelled -> 409', async () => {
    const id = await startedTrip();
    expect((await setStatus('sara', id, { status: 'Cancelled' })).status).toBe(409);
  });

  test('another employee cannot complete it -> 403', async () => {
    const id = await startedTrip();
    expect((await setStatus('omar', id, { status: 'Completed' })).status).toBe(403);
  });

  test('negative actualKm -> 400', async () => {
    const id = await startedTrip();
    expect((await setStatus('sara', id, { status: 'Completed', actualKm: -5 })).status).toBe(400);
  });
});

describe('conflicts endpoint (called by the Fleet service)', () => {
  test('approved overlap -> { conflict: true }', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    const res = await request(app).get('/api/bookings/conflicts').set(auth('admin'))
      .query({ vehicleId: cars.corolla.id, from: booking.startAt, to: at(24 * 200) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ conflict: true });
  });

  test('only Pending bookings -> { conflict: false }', async () => {
    const booking = await book('sara');
    const res = await request(app).get('/api/bookings/conflicts').set(auth('admin'))
      .query({ vehicleId: cars.corolla.id, from: booking.startAt, to: booking.endAt });
    expect(res.body).toEqual({ conflict: false });
  });

  test('periods that only touch do not clash', async () => {
    const booking = await book('sara');
    await setStatus('admin', booking.id, { status: 'Approved' });
    const res = await request(app).get('/api/bookings/conflicts').set(auth('admin'))
      .query({ vehicleId: cars.corolla.id, from: booking.endAt, to: at(24 * 200) });
    expect(res.body).toEqual({ conflict: false });
  });

  test('employee token -> 403', async () => {
    const res = await request(app).get('/api/bookings/conflicts').set(auth('sara'))
      .query({ vehicleId: cars.corolla.id, from: at(1), to: at(2) });
    expect(res.status).toBe(403);
  });

  test('missing vehicleId -> 400', async () => {
    const res = await request(app).get('/api/bookings/conflicts').set(auth('admin')).query({ from: at(1), to: at(2) });
    expect(res.status).toBe(400);
  });
});

describe('trip estimate', () => {
  test('returns the ORS estimate', async () => {
    const res = await request(app).get('/api/bookings/estimate').set(auth('sara')).query({ destination: 'Smart Village' });
    expect(res.status).toBe(200);
    expect(res.body.distanceKm).toBe(31.4);
  });

  test('destination too short -> 400', async () => {
    const res = await request(app).get('/api/bookings/estimate').set(auth('sara')).query({ destination: 'ab' });
    expect(res.status).toBe(400);
  });
});
