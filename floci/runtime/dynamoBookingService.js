// Booking service on Amazon DynamoDB (Floci copy only).
// Replaces services/bookingService.js in the Floci build: same functions, same rules,
// same answers, so the routes and controllers do not change. Only the storage differs.
//
// Table (name from BOOKINGS_TABLE, default FleetDeskBookings), partition key "id" (String), on-demand.
// Global secondary indexes (created by floci/deploy.js):
//   userId-startAt-index     -> one employee's bookings, newest trip first
//   vehicleId-startAt-index  -> one car's bookings, used for the overlap checks
//   status-createdAt-index   -> the approval queue (status = Pending), oldest request first
//
// Postgres refused overlapping approvals with an exclusion constraint. DynamoDB has none, so each car
// has a small lock item ("LOCK#<vehicleId>") with a version number. An approval reads the version,
// checks for overlaps, then saves the booking AND bumps the version in ONE transaction that only
// succeeds if the version is unchanged. If another admin approved a clashing booking in between,
// the transaction is cancelled and nothing is saved.
// Lock items have no userId, vehicleId or status, so they never appear in the indexes.

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, ScanCommand, UpdateCommand, TransactWriteCommand
} = require('@aws-sdk/lib-dynamodb');
const { notFound, conflict, forbidden, badRequest } = require('../utils/errors');
const fleetClient = require('../clients/fleetClient');
const routeClient = require('../clients/routeClient');

const TABLE = process.env.BOOKINGS_TABLE || 'FleetDeskBookings';
const LOCK = 'LOCK#';
const LIMIT = 200;

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.FLOCI_ENDPOINT;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {})
}), { marshallOptions: { removeUndefinedValues: true } });

const FLEET_REASONS = {
  RETIRED: 'This car has been retired.',
  IN_MAINTENANCE: 'This car is in maintenance right now.',
  MAINTENANCE_SCHEDULED: 'This car has maintenance scheduled in that period.'
};

const iso = (date) => (date instanceof Date ? date.toISOString() : date);
const isBooking = (item) => item && typeof item.id === 'string' && !item.id.startsWith(LOCK);
const carLabel = (car) => `${car.make} ${car.model} (${car.year})`;

// Same answer shape as the Postgres version.
function toView(item) {
  return {
    id: item.id,
    userId: item.userId,
    userName: item.userName,
    vehicleId: item.vehicleId,
    vehiclePlate: item.vehiclePlate,
    vehicleLabel: item.vehicleLabel,
    purpose: item.purpose,
    destination: item.destination,
    passengers: item.passengers,
    startAt: item.startAt,
    endAt: item.endAt,
    status: item.status,
    estimate: item.estimate || null,
    decidedBy: item.decidedBy || null,
    decisionReason: item.decisionReason || null,
    decidedAt: item.decidedAt || null,
    cancelReason: item.cancelReason || null,
    cancelledAt: item.cancelledAt || null,
    actualKm: item.actualKm === undefined ? null : item.actualKm,
    completedAt: item.completedAt || null,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt
  };
}

// ---------- low-level helpers ----------

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < 1000);
  return items;
}

async function findItem(id) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id } }));
  return isBooking(Item) ? Item : null;
}

function setExpression(changes) {
  const names = {};
  const values = {};
  const parts = Object.entries(changes).map(([key, value], i) => {
    names[`#f${i}`] = key;
    values[`:v${i}`] = value === undefined ? null : value;
    return `#f${i} = :v${i}`;
  });
  return { UpdateExpression: `SET ${parts.join(', ')}`, names, values };
}

// Update only while the booking is in one of "fromStatuses" (the DynamoDB version of
// "UPDATE ... WHERE status = 'Pending'"). Returns null when the condition failed.
async function updateIfStatus(id, fromStatuses, changes) {
  const set = setExpression(changes);
  const values = { ...set.values };
  fromStatuses.forEach((status, i) => { values[`:from${i}`] = status; });
  try {
    const { Attributes } = await ddb.send(new UpdateCommand({
      TableName: TABLE,
      Key: { id },
      UpdateExpression: set.UpdateExpression,
      ConditionExpression: `attribute_exists(id) AND #s IN (${fromStatuses.map((_, i) => `:from${i}`).join(', ')})`,
      ExpressionAttributeNames: { ...set.names, '#s': 'status' },
      ExpressionAttributeValues: values,
      ReturnValues: 'ALL_NEW'
    }));
    return Attributes;
  } catch (error) {
    if (error.name === 'ConditionalCheckFailedException') return null;
    throw error;
  }
}

// ---------- overlap checks ----------

// Bookings of one car that overlap [from, to): start before "to" AND end after "from".
async function carOverlaps(vehicleId, from, to, statuses, ignoreId = null) {
  const values = { ':v': vehicleId, ':to': iso(to), ':from': iso(from) };
  statuses.forEach((s, i) => { values[`:st${i}`] = s; });
  const items = await queryAll({
    IndexName: 'vehicleId-startAt-index',
    KeyConditionExpression: 'vehicleId = :v AND startAt < :to',
    FilterExpression: `endAt > :from AND #s IN (${statuses.map((_, i) => `:st${i}`).join(', ')})`,
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: values
  });
  return items.filter((item) => item.id !== ignoreId);
}

async function approvedOverlap(vehicleId, from, to, ignoreId = null) {
  return (await carOverlaps(vehicleId, from, to, ['Approved'], ignoreId)).length > 0;
}

// The same employee cannot hold two cars at the same time.
async function ownOverlap(userId, from, to, ignoreId = null) {
  const items = await queryAll({
    IndexName: 'userId-startAt-index',
    KeyConditionExpression: 'userId = :u AND startAt < :to',
    FilterExpression: 'endAt > :from AND #s IN (:p, :a)',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':u': userId, ':to': iso(to), ':from': iso(from), ':p': 'Pending', ':a': 'Approved' }
  });
  return items.some((item) => item.id !== ignoreId);
}

async function assertCarFree(vehicleId, from, to, authorization, ignoreId = null) {
  const fleet = await fleetClient.checkAvailability(vehicleId, from, to, authorization);
  if (!fleet.available) {
    throw conflict('VEHICLE_UNAVAILABLE', FLEET_REASONS[fleet.reason] || 'This car is not available in that period.');
  }
  if (await approvedOverlap(vehicleId, from, to, ignoreId)) {
    throw conflict('VEHICLE_UNAVAILABLE', 'This car is already booked for part of that time.');
  }
}

// ---------- search ----------

async function findFreeCars(from, to, seats, authorization) {
  const cars = (await fleetClient.listAvailableCars(authorization)).filter((car) => car.seats >= seats);
  if (cars.length === 0) return [];

  const approved = await queryAll({
    IndexName: 'status-createdAt-index',
    KeyConditionExpression: '#s = :a',
    FilterExpression: 'startAt < :to AND endAt > :from',
    ExpressionAttributeNames: { '#s': 'status' },
    ExpressionAttributeValues: { ':a': 'Approved', ':to': iso(to), ':from': iso(from) }
  });
  const bookedIds = new Set(approved.map((item) => item.vehicleId));

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

async function hasConflict(vehicleId, from, to) {
  return approvedOverlap(vehicleId, from, to);
}

// ---------- create and read ----------

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

  let estimate = null;
  try {
    estimate = await routeClient.estimateTrip(input.destination);
  } catch (error) {
    estimate = null;
  }

  const now = new Date().toISOString();
  const item = {
    id: crypto.randomUUID(),
    userId: user.id,
    userName: user.name || 'Employee',
    vehicleId: car.id,
    vehiclePlate: car.plateNumber,
    vehicleLabel: carLabel(car),
    purpose: input.purpose,
    destination: input.destination,
    passengers: input.passengers,
    startAt: iso(input.start),
    endAt: iso(input.end),
    status: 'Pending',
    estimate: estimate ? { distanceKm: estimate.distanceKm, durationMinutes: estimate.durationMinutes, source: 'OpenRouteService' } : null,
    createdAt: now,
    updatedAt: now
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
  return toView(item);
}

async function get(id, user, onBlocked) {
  const item = await findItem(id);
  if (!item) throw notFound('Booking');
  if (user.role !== 'FleetAdmin' && item.userId !== user.id) {
    onBlocked();
    throw forbidden('You can only see your own bookings.');
  }
  return toView(item);
}

// Employees: only their own (the query itself is limited to their userId). Admins: everything.
async function list(user, { status, mine, vehicleId }) {
  const ownOnly = user.role !== 'FleetAdmin' || mine;
  let items;
  if (ownOnly) {
    items = await queryAll({
      IndexName: 'userId-startAt-index',
      KeyConditionExpression: 'userId = :u',
      ExpressionAttributeValues: { ':u': user.id },
      ScanIndexForward: false
    });
  } else if (status) {
    items = await queryAll({
      IndexName: 'status-createdAt-index',
      KeyConditionExpression: '#s = :s',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':s': status }
    });
  } else if (vehicleId) {
    items = await queryAll({
      IndexName: 'vehicleId-startAt-index',
      KeyConditionExpression: 'vehicleId = :v',
      ExpressionAttributeValues: { ':v': vehicleId }
    });
  } else {
    items = [];
    let ExclusiveStartKey;
    do {
      const result = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey }));
      items.push(...(result.Items || []).filter(isBooking));
      ExclusiveStartKey = result.LastEvaluatedKey;
    } while (ExclusiveStartKey && items.length < 1000);
  }

  const view = items
    .filter((item) => isBooking(item))
    .filter((item) => !status || item.status === status)
    .filter((item) => !vehicleId || item.vehicleId === vehicleId)
    .sort((a, b) => b.startAt.localeCompare(a.startAt))
    .slice(0, LIMIT)
    .map(toView);
  // The approval queue reads oldest request first.
  if (status === 'Pending') view.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  return view;
}

// ---------- change ----------

async function update(id, changes, user, authorization) {
  const item = await findItem(id);
  if (!item) throw notFound('Booking');
  if (item.userId !== user.id) throw forbidden('Only the person who made the booking can edit it.');
  if (item.status !== 'Pending') throw conflict('INVALID_STATUS', `This booking is already ${item.status} and cannot be edited.`);

  const next = {
    purpose: changes.purpose ?? item.purpose,
    destination: changes.destination ?? item.destination,
    passengers: changes.passengers ?? item.passengers,
    start: changes.start ?? new Date(item.startAt),
    end: changes.end ?? new Date(item.endAt)
  };
  if (next.end <= next.start) throw badRequest('endAt must be after startAt.');

  const datesChanged = changes.start !== undefined || changes.end !== undefined;
  if (datesChanged || changes.passengers !== undefined) {
    const car = await fleetClient.getCar(item.vehicleId, authorization);
    if (!car) throw conflict('VEHICLE_UNAVAILABLE', 'This car is no longer in the fleet.');
    if (car.seats < next.passengers) throw badRequest(`This car has ${car.seats} seats, which is fewer than ${next.passengers} passengers.`);
  }
  if (datesChanged) {
    await assertCarFree(item.vehicleId, next.start, next.end, authorization, id);
    if (await ownOverlap(user.id, next.start, next.end, id)) {
      throw conflict('OVERLAPPING_BOOKING', 'You already have a booking in that period.');
    }
  }

  let estimate = item.estimate || null;
  if (changes.destination !== undefined && changes.destination !== item.destination) {
    try {
      const e = await routeClient.estimateTrip(next.destination);
      estimate = { distanceKm: e.distanceKm, durationMinutes: e.durationMinutes, source: 'OpenRouteService' };
    } catch (error) {
      estimate = null;
    }
  }

  const saved = await updateIfStatus(id, ['Pending'], {
    purpose: next.purpose, destination: next.destination, passengers: next.passengers,
    startAt: iso(next.start), endAt: iso(next.end), estimate, updatedAt: new Date().toISOString()
  });
  if (!saved) throw conflict('INVALID_STATUS', 'This booking was decided while you were editing it.');
  const changed = Object.keys(changes).filter((key) => changes[key] !== undefined).map((key) => (key === 'start' ? 'startAt' : key === 'end' ? 'endAt' : key));
  return { booking: toView(saved), from: item.status, changed };
}

async function lockVersion(vehicleId) {
  const { Item } = await ddb.send(new GetCommand({ TableName: TABLE, Key: { id: LOCK + vehicleId } }));
  return Item ? Item.version : 0;
}

async function changeStatus(id, { status, reason, actualKm }, user, authorization) {
  const item = await findItem(id);
  if (!item) throw notFound('Booking');
  const isAdmin = user.role === 'FleetAdmin';
  const isOwner = item.userId === user.id;
  const now = new Date();
  const nowIso = now.toISOString();

  if (status === 'Approved' || status === 'Rejected') {
    if (!isAdmin) throw forbidden('Only a Fleet Admin can do this.');
    if (isOwner) throw forbidden('You cannot approve or reject your own booking.');
    if (item.status !== 'Pending') throw conflict('INVALID_STATUS', `This booking is already ${item.status}.`);
    if (status === 'Rejected' && !reason) throw badRequest('Give a reason when rejecting a booking.');

    const decision = {
      status, decidedById: user.id, decidedBy: user.name || 'Fleet Admin',
      decisionReason: reason || null, decidedAt: nowIso, updatedAt: nowIso
    };

    if (status === 'Rejected') {
      const saved = await updateIfStatus(id, ['Pending'], decision);
      if (!saved) throw conflict('INVALID_STATUS', 'Another admin decided on this booking first.');
      return { booking: toView(saved), from: item.status };
    }

    if (new Date(item.endAt) <= now) throw conflict('BOOKING_EXPIRED', 'This booking has already ended and cannot be approved.');
    const seenVersion = await lockVersion(item.vehicleId);   // read BEFORE the overlap check
    await assertCarFree(item.vehicleId, new Date(item.startAt), new Date(item.endAt), authorization, id);

    const set = setExpression(decision);
    try {
      await ddb.send(new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: TABLE,
              Key: { id },
              UpdateExpression: set.UpdateExpression,
              ConditionExpression: 'attribute_exists(id) AND #s = :pending',
              ExpressionAttributeNames: { ...set.names, '#s': 'status' },
              ExpressionAttributeValues: { ...set.values, ':pending': 'Pending' }
            }
          },
          {
            Update: {
              TableName: TABLE,
              Key: { id: LOCK + item.vehicleId },
              UpdateExpression: 'SET version = :next, updatedAt = :now',
              ConditionExpression: 'attribute_not_exists(version) OR version = :seen',
              ExpressionAttributeValues: { ':next': seenVersion + 1, ':seen': seenVersion, ':now': nowIso }
            }
          }
        ]
      }));
    } catch (error) {
      if (error.name === 'TransactionCanceledException') {
        const [bookingReason] = error.CancellationReasons || [];
        if (bookingReason && bookingReason.Code === 'ConditionalCheckFailed') {
          throw conflict('INVALID_STATUS', 'Another admin decided on this booking first.');
        }
        throw conflict('VEHICLE_UNAVAILABLE', 'Another booking for this car was approved at the same moment. Refresh and try again.');
      }
      throw error;
    }
    return { booking: toView(await findItem(id)), from: item.status };
  }

  if (status === 'Cancelled') {
    if (!isOwner && !isAdmin) throw forbidden('You can only cancel your own bookings.');
    if (!isOwner && !reason) throw badRequest('Give a reason when cancelling someone else\'s booking.');
    if (item.status !== 'Pending' && item.status !== 'Approved') {
      throw conflict('INVALID_STATUS', `This booking is already ${item.status}.`);
    }
    if (item.status === 'Approved' && new Date(item.startAt) <= now) {
      throw conflict('TRIP_STARTED', 'This trip has already started and cannot be cancelled.');
    }
    const saved = await updateIfStatus(id, ['Pending', 'Approved'], {
      status: 'Cancelled', cancelledById: user.id, cancelReason: reason || null, cancelledAt: nowIso, updatedAt: nowIso
    });
    if (!saved) throw conflict('INVALID_STATUS', 'This booking changed while you were cancelling it.');
    return { booking: toView(saved), from: item.status };
  }

  // Completed (the car was returned; used by the Trip, Fuel & Reporting service at check-in)
  if (!isOwner && !isAdmin) throw forbidden('You can only complete your own bookings.');
  if (item.status !== 'Approved') throw conflict('INVALID_STATUS', `Only an approved booking can be completed (this one is ${item.status}).`);
  if (new Date(item.startAt) > now) throw conflict('TRIP_NOT_STARTED', 'This trip has not started yet.');
  const saved = await updateIfStatus(id, ['Approved'], {
    status: 'Completed', actualKm: actualKm ?? null, completedAt: nowIso, updatedAt: nowIso
  });
  if (!saved) throw conflict('INVALID_STATUS', 'This booking changed while you were completing it.');
  return { booking: toView(saved), from: item.status };
}

// Number of bookings in each status (monitoring panel).
async function statusCounts() {
  const counts = { Pending: 0, Approved: 0, Rejected: 0, Cancelled: 0, Completed: 0 };
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({ TableName: TABLE, ExclusiveStartKey, ProjectionExpression: 'id, #s', ExpressionAttributeNames: { '#s': 'status' } }));
    (result.Items || []).filter(isBooking).forEach((item) => { counts[item.status] = (counts[item.status] || 0) + 1; });
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return counts;
}

module.exports = { findFreeCars, hasConflict, create, get, list, update, changeStatus, statusCounts, toView };
