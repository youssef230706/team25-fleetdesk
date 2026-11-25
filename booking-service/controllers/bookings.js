// Booking controllers: read and check the input, call the service, send the answer.
// The user always comes from req.user (the verified token), never from the body.

const bookingService = require('../services/bookingService');
const events = require('../services/events');
const eventStore = require('../services/eventStore');
const monitor = require('../services/monitor');
const routeClient = require('../clients/routeClient');
const validate = require('../utils/validate');
const { notFound, badRequest } = require('../utils/errors');
const { securityLog } = require('../middleware/logger');

const STATUSES = ['Pending', 'Approved', 'Rejected', 'Cancelled', 'Completed'];
const NEW_STATUSES = ['Approved', 'Rejected', 'Cancelled', 'Completed'];

const DAY = 24 * 60 * 60 * 1000;
const MAX_BOOKING_DAYS = 14;
const MAX_DAYS_AHEAD = 90;

function idParam(req) {
  if (!validate.isUuid(req.params.id)) throw notFound('Booking');
  return req.params.id;
}

// A booking period: real ISO dates, end after start, not in the past,
// at most 14 days long and at most 90 days ahead.
function bookingPeriod(source, startField, endField) {
  const start = validate.date(source, startField);
  const end = validate.date(source, endField);
  if (end <= start) throw badRequest(`${endField} must be after ${startField}.`);
  if (start < new Date(Date.now() - 5 * 60 * 1000)) throw badRequest(`${startField} cannot be in the past.`);
  if (end - start > MAX_BOOKING_DAYS * DAY) throw badRequest(`A booking cannot be longer than ${MAX_BOOKING_DAYS} days.`);
  if (start - Date.now() > MAX_DAYS_AHEAD * DAY) throw badRequest(`You can book at most ${MAX_DAYS_AHEAD} days ahead.`);
  return { start, end };
}

function seatsFrom(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 15) throw badRequest('seats must be a whole number between 1 and 15.');
  return n;
}

// GET /api/bookings/availability?from=&to=&seats=
async function availability(req, res) {
  const { start, end } = bookingPeriod(req.query, 'from', 'to');
  const seats = req.query.seats === undefined ? 1 : seatsFrom(req.query.seats);
  const cars = await bookingService.findFreeCars(start, end, seats, req.get('Authorization'));
  res.status(200).json({ from: start, to: end, seats, cars });
}

// GET /api/bookings/estimate?destination=
async function estimate(req, res) {
  const destination = validate.text(req.query, 'destination', { min: 3, max: 150 });
  res.status(200).json(await routeClient.estimateTrip(destination));
}

// GET /api/bookings/conflicts?vehicleId=&from=&to=  (FleetAdmin: the Fleet service forwards the admin's token)
async function conflicts(req, res) {
  if (!validate.isUuid(req.query.vehicleId)) throw badRequest('vehicleId is required and must be a valid id.');
  const start = validate.date(req.query, 'from');
  const end = validate.date(req.query, 'to');
  if (end <= start) throw badRequest('to must be after from.');
  res.status(200).json({ conflict: await bookingService.hasConflict(req.query.vehicleId, start, end) });
}

// POST /api/bookings  (any logged-in user; always starts as Pending)
async function createBooking(req, res) {
  const body = validate.pick(req.body, ['vehicleId', 'startAt', 'endAt', 'purpose', 'destination', 'passengers']);
  if (!validate.isUuid(body.vehicleId)) throw badRequest('vehicleId is required and must be a valid id.');
  const { start, end } = bookingPeriod(body, 'startAt', 'endAt');
  const input = {
    vehicleId: body.vehicleId,
    start,
    end,
    purpose: validate.text(body, 'purpose', { min: 5, max: 200 }),
    destination: validate.text(body, 'destination', { min: 3, max: 150 }),
    passengers: validate.integer(body, 'passengers', { min: 1, max: 15, required: false }) ?? 1
  };
  const booking = await bookingService.create(input, req.user, req.get('Authorization'));
  securityLog(req, 'booking_created', 201, { bookingId: booking.id });
  await events.bookingChanged('booking.created', booking, req.user, null);
  res.status(201).json(booking);
}

// GET /api/bookings?status=&mine=true&vehicleId=  (employee: own only; admin: all)
async function listBookings(req, res) {
  const status = req.query.status ? validate.oneOf(req.query, 'status', STATUSES) : undefined;
  const vehicleId = req.query.vehicleId;
  if (vehicleId !== undefined && !validate.isUuid(vehicleId)) throw badRequest('vehicleId must be a valid id.');
  const mine = req.query.mine === 'true';
  res.status(200).json(await bookingService.list(req.user, { status, mine, vehicleId }));
}

// GET /api/bookings/:id  (owner or admin, otherwise 403; the Trip service reads the estimate here)
async function getBooking(req, res) {
  const booking = await bookingService.get(idParam(req), req.user, () => {
    securityLog(req, 'idor_blocked', 403, { bookingId: req.params.id });
  });
  res.status(200).json(booking);
}

// PATCH /api/bookings/:id  (owner, while Pending)
async function updateBooking(req, res) {
  const id = idParam(req);
  const body = validate.pick(req.body, ['startAt', 'endAt', 'purpose', 'destination', 'passengers']);
  if (Object.keys(body).length === 0) throw badRequest('Send startAt, endAt, purpose, destination or passengers.');
  const changes = {
    purpose: validate.text(body, 'purpose', { min: 5, max: 200, required: false }),
    destination: validate.text(body, 'destination', { min: 3, max: 150, required: false }),
    passengers: validate.integer(body, 'passengers', { min: 1, max: 15, required: false })
  };
  if (body.startAt !== undefined || body.endAt !== undefined) {
    if (body.startAt === undefined || body.endAt === undefined) throw badRequest('Send both startAt and endAt to change the dates.');
    Object.assign(changes, bookingPeriod(body, 'startAt', 'endAt'));
  }
  const { booking, from, changed } = await bookingService.update(id, changes, req.user, req.get('Authorization'));
  await events.bookingChanged('booking.updated', booking, req.user, from, { changed });
  res.status(200).json(booking);
}

// PATCH /api/bookings/:id/status  { status, reason?, actualKm? }
async function changeStatus(req, res) {
  const id = idParam(req);
  const body = validate.pick(req.body, ['status', 'reason', 'actualKm']);
  const status = validate.oneOf(body, 'status', NEW_STATUSES);
  const reason = validate.text(body, 'reason', { min: 3, max: 300, required: false });
  let actualKm;
  if (body.actualKm !== undefined && body.actualKm !== null) {
    if (status !== 'Completed') throw badRequest('actualKm is only sent when completing a booking.');
    if (typeof body.actualKm !== 'number' || !Number.isFinite(body.actualKm) || body.actualKm < 0 || body.actualKm > 5000) {
      throw badRequest('actualKm must be a number between 0 and 5000.');
    }
    actualKm = Math.round(body.actualKm * 10) / 10;
  }
  try {
    const { booking, from } = await bookingService.changeStatus(id, { status, reason, actualKm }, req.user, req.get('Authorization'));
    securityLog(req, `booking_${status.toLowerCase()}`, 200, { bookingId: id });
    await events.bookingChanged(`booking.${status.toLowerCase()}`, booking, req.user, from,
      { ...(reason ? { reason } : {}), ...(actualKm !== undefined ? { actualKm } : {}) });
    res.status(200).json(booking);
  } catch (error) {
    if (error.status === 403) securityLog(req, 'status_change_blocked', 403, { bookingId: id, wanted: status });
    throw error;
  }
}

// GET /api/bookings/:id/history  (owner or admin: the booking's audit trail, oldest first)
async function bookingHistory(req, res) {
  const id = idParam(req);
  await bookingService.get(id, req.user, () => {
    securityLog(req, 'idor_blocked', 403, { bookingId: id });
  });
  const history = await eventStore.forBooking(id);
  res.status(200).json(history.map((e) => ({
    at: e.at, type: e.type, fromStatus: e.fromStatus, toStatus: e.toStatus, actorRole: e.actorRole,
    byMe: e.actorId === req.user.id, details: e.details
  })));
}

// GET /api/bookings/events?since=&type=  (FleetAdmin: pull the event feed, e.g. for the Trip service)
async function eventFeed(req, res) {
  const since = req.query.since ? validate.date(req.query, 'since') : null;
  const type = req.query.type ? validate.oneOf(req.query, 'type', events.SHARED) : null;
  const list = await eventStore.recent({ types: type ? [type] : events.SHARED, since, limit: 100 });
  res.status(200).json(list.map((e) => ({ id: e.id, type: e.type, at: e.at, bookingId: e.bookingId, fromStatus: e.fromStatus, toStatus: e.toStatus, delivery: e.delivery })));
}

// GET /api/bookings/metrics  (FleetAdmin: monitoring panel)
async function metrics(req, res) {
  res.status(200).json(await monitor.metrics(await bookingService.statusCounts()));
}

module.exports = {
  availability, estimate, conflicts, createBooking, listBookings, getBooking, updateBooking, changeStatus,
  bookingHistory, eventFeed, metrics
};
