// Where booking events are stored: Postgres table booking_events (see db/schema.sql).
// (The Floci copy swaps this file for a DynamoDB version with the same functions.)

const { db } = require('../db/sql');

function toView(row) {
  let details = {};
  try { details = JSON.parse(row.details || '{}'); } catch (error) { details = {}; }
  return {
    id: row.id,
    type: row.type,
    bookingId: row.booking_id,
    actorId: row.actor_id,
    actorRole: row.actor_role,
    fromStatus: row.from_status,
    toStatus: row.to_status,
    details,
    delivery: row.delivery,
    at: row.created_at
  };
}

async function add(event) {
  const rows = await db`
    INSERT INTO booking_events (type, booking_id, actor_id, actor_role, from_status, to_status, details, created_at)
    VALUES (${event.type}, ${event.bookingId || null}, ${event.actorId || null}, ${event.actorRole || null},
            ${event.fromStatus || null}, ${event.toStatus || null}, ${JSON.stringify(event.details || {})}, ${event.at})
    RETURNING *`;
  return toView(rows[0]);
}

async function setDelivery(id, delivery) {
  await db`UPDATE booking_events SET delivery = ${delivery} WHERE id = ${id}`;
}

// One booking's history, oldest first.
async function forBooking(bookingId) {
  const rows = await db`SELECT * FROM booking_events WHERE booking_id = ${bookingId} ORDER BY created_at, id`;
  return rows.map(toView);
}

// Newest first, optionally only some types and only after "since".
async function recent({ types = null, since = null, limit = 50 } = {}) {
  const rows = await db`
    SELECT * FROM booking_events
    WHERE (${since}::timestamptz IS NULL OR created_at > ${since}::timestamptz)
    ORDER BY created_at DESC
    LIMIT 500`;
  return rows.map(toView).filter((e) => !types || types.includes(e.type)).slice(0, limit);
}

// { type: count } for events after "since".
async function countSince(since) {
  const rows = await db`
    SELECT type, count(*)::int AS n FROM booking_events
    WHERE created_at > ${since}
    GROUP BY type`;
  return Object.fromEntries(rows.map((r) => [r.type, r.n]));
}

async function countDeliveryFailuresSince(since) {
  const rows = await db`SELECT count(*)::int AS n FROM booking_events WHERE delivery = 'failed' AND created_at > ${since}`;
  return rows[0].n;
}

module.exports = { add, setDelivery, forBooking, recent, countSince, countDeliveryFailuresSince };
