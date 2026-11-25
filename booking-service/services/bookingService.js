// Bookings: search free cars, request, edit, approve/reject, cancel, complete,
// and the conflicts check that the Fleet service calls before scheduling maintenance.
//
// Two services decide if a car is free for a period:
//   - Fleet (Kareem): is the car in service, and is there maintenance in that period?
//   - Booking (here): is there an APPROVED booking that overlaps?
// A car is free only when both say yes.

const { db } = require('../db/sql');
const { notFound, conflict, forbidden, badRequest } = require('../utils/errors');
const fleetClient = require('../clients/fleetClient');
const routeClient = require('../clients/routeClient');

const FLEET_REASONS = {
  RETIRED: 'This car has been retired.',
  IN_MAINTENANCE: 'This car is in maintenance right now.',
  MAINTENANCE_SCHEDULED: 'This car has maintenance scheduled in that period.'
};

function toView(row) {
  return {
    id: row.id,
    userId: row.user_id,
    userName: row.user_name,
    vehicleId: row.vehicle_id,
    vehiclePlate: row.vehicle_plate,
    vehicleLabel: row.vehicle_label,
    purpose: row.purpose,
    destination: row.destination,
    passengers: row.passengers,
    startAt: row.start_at,
    endAt: row.end_at,
    status: row.status,
    estimate: row.estimated_km === null
      ? null
      : { distanceKm: Number(row.estimated_km), durationMinutes: row.estimated_minutes, source: 'OpenRouteService' },
    decidedBy: row.decided_by_name,
    decisionReason: row.decision_reason,
    decidedAt: row.decided_at,
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at,
    actualKm: row.actual_km === null ? null : Number(row.actual_km),
    completedAt: row.completed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function carLabel(car) {
  return `${car.make} ${car.model} (${car.year})`;
}

// --- overlap checks -------------------------------------------------------------

// Two periods overlap when each one starts before the other ends.
async function approvedOverlap(vehicleId, from, to, ignoreId = null) {
  const rows = await db`
    SELECT id FROM bookings
    WHERE vehicle_id = ${vehicleId} AND status = 'Approved'
      AND start_at < ${to} AND end_at > ${from}
      AND (${ignoreId}::uuid IS NULL OR id <> ${ignoreId}::uuid)
    LIMIT 1`;
  return rows.length > 0;
}

// The same employee cannot hold two cars at the same time.
async function ownOverlap(userId, from, to, ignoreId = null) {
  const rows = await db`
    SELECT id FROM bookings
    WHERE user_id = ${userId} AND status IN ('Pending', 'Approved')
      AND start_at < ${to} AND end_at > ${from}
      AND (${ignoreId}::uuid IS NULL OR id <> ${ignoreId}::uuid)
    LIMIT 1`;
  return rows.length > 0;
}

// Fleet first (in service, no maintenance), then our own approved bookings.
async function assertCarFree(vehicleId, from, to, authorization, ignoreId = null) {
  const fleet = await fleetClient.checkAvailability(vehicleId, from, to, authorization);
  if (!fleet.available) {
    throw conflict('VEHICLE_UNAVAILABLE', FLEET_REASONS[fleet.reason] || 'This car is not available in that period.');
  }
  if (await approvedOverlap(vehicleId, from, to, ignoreId)) {
    throw conflict('VEHICLE_UNAVAILABLE', 'This car is already booked for part of that time.');
  }
}

// --- search ------------------------------------------------------------------------

// GET /api/bookings/availability: cars that fit the passengers and are free for the whole period.
async function findFreeCars(from, to, seats, authorization) {
  const cars = (await fleetClient.listAvailableCars(authorization)).filter((car) => car.seats >= seats);
  if (cars.length === 0) return [];

  const booked = await db`
    SELECT DISTINCT vehicle_id FROM bookings
    WHERE status = 'Approved' AND start_at < ${to} AND end_at > ${from}`;
  const bookedIds = new Set(booked.map((row) => row.vehicle_id));

  const candidates = cars.filter((car) => !bookedIds.has(car.id));
  const checks = await Promise.all(candidates.map((car) => fleetClient.checkAvailability(car.id, from, to, authorization)));

  return candidates
    .filter((car, index) => checks[index].available)
    .sort((a, b) => a.seats - b.seats || a.plateNumber.localeCompare(b.plateNumber))
    .map((car) => ({
      id: car.id, plateNumber: car.plateNumber, make: car.make, model: car.model,
      year: car.year, type: car.type, seats: car.seats, label: carLabel(car)
    }));
}

// GET /api/bookings/conflicts (called by the Fleet service before it schedules maintenance)
async function hasConflict(vehicleId, from, to) {
  return approvedOverlap(vehicleId, from, to);
}

// --- create and read ------------------------------------------------------------------

async function create(input, user, authorization) {
  const car = await fleetClient.getCar(input.vehicleId, authorization);
  if (!car) throw badRequest('vehicleId does not match any company car.');
  if (car.seats < input.passengers) {
    throw badRequest(`This car has ${car.seats} seats, which is fewer than ${input.passengers} passengers.`);
  }

  await assertCarFree(car.id, input.start, input.end, authorization);
  if (await ownOverlap(user.id, input.start, input.end)) {
    throw conflict('OVERLAPPING_BOOKING', 'You already have a booking in that period.');
  }

  // The trip estimate is helpful but optional: if OpenRouteService is down, the request still goes in.
  let estimate = null;
  try {
    estimate = await routeClient.estimateTrip(input.destination);
  } catch (error) {
    estimate = null;
  }

  const now = new Date();
  const rows = await db`
    INSERT INTO bookings (user_id, user_name, vehicle_id, vehicle_plate, vehicle_label,
                          purpose, destination, passengers, start_at, end_at, status,
                          estimated_km, estimated_minutes, created_at, updated_at)
    VALUES (${user.id}, ${user.name || 'Employee'}, ${car.id}, ${car.plateNumber}, ${carLabel(car)},
            ${input.purpose}, ${input.destination}, ${input.passengers}, ${input.start}, ${input.end}, 'Pending',
            ${estimate ? estimate.distanceKm : null}, ${estimate ? estimate.durationMinutes : null}, ${now}, ${now})
    RETURNING *`;
  return toView(rows[0]);
}

async function findRow(id) {
  const rows = await db`SELECT * FROM bookings WHERE id = ${id}`;
  return rows[0] || null;
}

// Owner or admin; anyone else gets 403 (and the attempt is logged by the controller).
async function get(id, user, onBlocked) {
  const row = await findRow(id);
  if (!row) throw notFound('Booking');
  if (user.role !== 'FleetAdmin' && row.user_id !== user.id) {
    onBlocked();
    throw forbidden('You can only see your own bookings.');
  }
  return toView(row);
}

// Employees: only their own. Admins: everything, or their own with mine=true.
async function list(user, { status, mine, vehicleId }) {
  // Employees: only their own bookings, enforced inside the SQL itself.
  const ownerFilter = user.role !== 'FleetAdmin' || mine ? user.id : null;
  const statusFilter = status || null;
  const vehicleFilter = vehicleId || null;
  const rows = await db`
    SELECT * FROM bookings
    WHERE (${ownerFilter}::uuid IS NULL OR user_id = ${ownerFilter}::uuid)
      AND (${statusFilter}::text IS NULL OR status = ${statusFilter})
      AND (${vehicleFilter}::uuid IS NULL OR vehicle_id = ${vehicleFilter}::uuid)
    ORDER BY start_at DESC
    LIMIT 200`;
  const view = rows.map(toView);
  // The approval queue reads oldest request first.
  if (status === 'Pending') view.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  return view;
}

// --- change ------------------------------------------------------------------------------

// PATCH /api/bookings/:id: the owner edits the trip while it is still Pending.
async function update(id, changes, user, authorization) {
  const row = await findRow(id);
  if (!row) throw notFound('Booking');
  if (row.user_id !== user.id) throw forbidden('Only the person who made the booking can edit it.');
  if (row.status !== 'Pending') throw conflict('INVALID_STATUS', `This booking is already ${row.status} and cannot be edited.`);

  const next = {
    purpose: changes.purpose ?? row.purpose,
    destination: changes.destination ?? row.destination,
    passengers: changes.passengers ?? row.passengers,
    start: changes.start ?? new Date(row.start_at),
    end: changes.end ?? new Date(row.end_at)
  };
  if (next.end <= next.start) throw badRequest('endAt must be after startAt.');

  const datesChanged = changes.start !== undefined || changes.end !== undefined;
  if (datesChanged || changes.passengers !== undefined) {
    const car = await fleetClient.getCar(row.vehicle_id, authorization);
    if (!car) throw conflict('VEHICLE_UNAVAILABLE', 'This car is no longer in the fleet.');
    if (car.seats < next.passengers) throw badRequest(`This car has ${car.seats} seats, which is fewer than ${next.passengers} passengers.`);
  }
  if (datesChanged) {
    await assertCarFree(row.vehicle_id, next.start, next.end, authorization, id);
    if (await ownOverlap(user.id, next.start, next.end, id)) {
      throw conflict('OVERLAPPING_BOOKING', 'You already have a booking in that period.');
    }
  }

  let estimatedKm = row.estimated_km;
  let estimatedMinutes = row.estimated_minutes;
  if (changes.destination !== undefined && changes.destination !== row.destination) {
    try {
      const estimate = await routeClient.estimateTrip(next.destination);
      estimatedKm = estimate.distanceKm;
      estimatedMinutes = estimate.durationMinutes;
    } catch (error) {
      estimatedKm = null;
      estimatedMinutes = null;
    }
  }

  // "AND status = 'Pending'" stops an edit that races with an approval.
  const rows = await db`
    UPDATE bookings SET purpose = ${next.purpose}, destination = ${next.destination}, passengers = ${next.passengers},
           start_at = ${next.start}, end_at = ${next.end},
           estimated_km = ${estimatedKm}, estimated_minutes = ${estimatedMinutes}, updated_at = ${new Date()}
    WHERE id = ${id} AND status = 'Pending'
    RETURNING *`;
  if (!rows[0]) throw conflict('INVALID_STATUS', 'This booking was decided while you were editing it.');
  const changed = Object.keys(changes).filter((key) => changes[key] !== undefined).map((key) => (key === 'start' ? 'startAt' : key === 'end' ? 'endAt' : key));
  return { booking: toView(rows[0]), from: row.status, changed };
}

// PATCH /api/bookings/:id/status
//   Approved / Rejected : FleetAdmin, Pending only, never their own booking
//   Cancelled           : the owner, or an admin with a reason; Pending, or Approved before it starts
//   Completed           : the owner or an admin, Approved only, once the trip has started
async function changeStatus(id, { status, reason, actualKm }, user, authorization) {
  const row = await findRow(id);
  if (!row) throw notFound('Booking');
  const isAdmin = user.role === 'FleetAdmin';
  const isOwner = row.user_id === user.id;
  const now = new Date();

  if (status === 'Approved' || status === 'Rejected') {
    if (!isAdmin) throw forbidden('Only a Fleet Admin can do this.');
    if (isOwner) throw forbidden('You cannot approve or reject your own booking.');
    if (row.status !== 'Pending') throw conflict('INVALID_STATUS', `This booking is already ${row.status}.`);
    if (status === 'Rejected' && !reason) throw badRequest('Give a reason when rejecting a booking.');

    if (status === 'Approved') {
      if (new Date(row.end_at) <= now) throw conflict('BOOKING_EXPIRED', 'This booking has already ended and cannot be approved.');
      // Check again: maintenance or another approval may have happened since the request.
      await assertCarFree(row.vehicle_id, new Date(row.start_at), new Date(row.end_at), authorization, id);
    }
    // The WHERE status = 'Pending' makes the decision safe when two admins click at the same time.
    // The exclusion constraint in schema.sql is the last guard against two overlapping approvals.
    const rows = await db`
      UPDATE bookings SET status = ${status}, decided_by = ${user.id}, decided_by_name = ${user.name || 'Fleet Admin'},
             decision_reason = ${reason || null}, decided_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND status = 'Pending'
      RETURNING *`;
    if (!rows[0]) throw conflict('INVALID_STATUS', 'Another admin decided on this booking first.');
    return { booking: toView(rows[0]), from: row.status };
  }

  if (status === 'Cancelled') {
    if (!isOwner && !isAdmin) throw forbidden('You can only cancel your own bookings.');
    if (!isOwner && !reason) throw badRequest('Give a reason when cancelling someone else\'s booking.');
    if (row.status !== 'Pending' && row.status !== 'Approved') {
      throw conflict('INVALID_STATUS', `This booking is already ${row.status}.`);
    }
    if (row.status === 'Approved' && new Date(row.start_at) <= now) {
      throw conflict('TRIP_STARTED', 'This trip has already started and cannot be cancelled.');
    }
    const rows = await db`
      UPDATE bookings SET status = 'Cancelled', cancelled_by = ${user.id}, cancel_reason = ${reason || null},
             cancelled_at = ${now}, updated_at = ${now}
      WHERE id = ${id} AND status IN ('Pending', 'Approved')
      RETURNING *`;
    if (!rows[0]) throw conflict('INVALID_STATUS', 'This booking changed while you were cancelling it.');
    return { booking: toView(rows[0]), from: row.status };
  }

  // Completed (the car was returned; used by the Trip, Fuel & Reporting service at check-in)
  if (!isOwner && !isAdmin) throw forbidden('You can only complete your own bookings.');
  if (row.status !== 'Approved') throw conflict('INVALID_STATUS', `Only an approved booking can be completed (this one is ${row.status}).`);
  if (new Date(row.start_at) > now) throw conflict('TRIP_NOT_STARTED', 'This trip has not started yet.');
  const rows = await db`
    UPDATE bookings SET status = 'Completed', actual_km = ${actualKm ?? null}, completed_at = ${now}, updated_at = ${now}
    WHERE id = ${id} AND status = 'Approved'
    RETURNING *`;
  if (!rows[0]) throw conflict('INVALID_STATUS', 'This booking changed while you were completing it.');
  return { booking: toView(rows[0]), from: row.status };
}

// Number of bookings in each status (monitoring panel).
async function statusCounts() {
  const rows = await db`SELECT status, count(*)::int AS n FROM bookings GROUP BY status`;
  const counts = { Pending: 0, Approved: 0, Rejected: 0, Cancelled: 0, Completed: 0 };
  rows.forEach((r) => { counts[r.status] = r.n; });
  return counts;
}

module.exports = { findFreeCars, hasConflict, create, get, list, update, changeStatus, statusCounts, toView };
