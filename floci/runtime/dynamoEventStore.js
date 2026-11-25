// Booking events (audit trail + monitoring) on DynamoDB, for the Floci copy.
// Replaces services/eventStore.js in the Floci build: same functions as the Postgres version.
//
// Table (BOOKING_EVENTS_TABLE, default FleetDeskBookingEvents), key "id", on-demand, with two indexes:
//   bookingId-at-index -> one booking's history in time order
//   type-at-index      -> counting events of one type since a time (metrics and alert rules)
// Security events have no bookingId, so they never appear in the booking index.

const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, PutCommand, UpdateCommand, QueryCommand, ScanCommand } = require('@aws-sdk/lib-dynamodb');

const TABLE = process.env.BOOKING_EVENTS_TABLE || 'FleetDeskBookingEvents';
const TYPES = [
  'booking.created', 'booking.updated', 'booking.approved', 'booking.rejected', 'booking.cancelled', 'booking.completed',
  'security.unauthenticated', 'security.forbidden', 'security.rate_limited', 'fleet.unavailable', 'alert.sent'
];

const endpoint = process.env.DYNAMODB_ENDPOINT || process.env.FLOCI_ENDPOINT;
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  region: process.env.AWS_REGION || 'us-east-1',
  ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {})
}), { marshallOptions: { removeUndefinedValues: true } });

const iso = (value) => (value instanceof Date ? value.toISOString() : value);

function toView(item) {
  return {
    id: item.id,
    type: item.type,
    bookingId: item.bookingId || null,
    actorId: item.actorId || null,
    actorRole: item.actorRole || null,
    fromStatus: item.fromStatus || null,
    toStatus: item.toStatus || null,
    details: item.details || {},
    delivery: item.delivery || 'none',
    at: item.at
  };
}

async function queryAll(params) {
  const items = [];
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new QueryCommand({ TableName: TABLE, ...params, ExclusiveStartKey }));
    items.push(...(result.Items || []));
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey && items.length < 2000);
  return items;
}

async function add(event) {
  const item = {
    id: crypto.randomUUID(),
    type: event.type,
    bookingId: event.bookingId || undefined,      // left out (not null) so the item stays out of the index
    actorId: event.actorId || undefined,
    actorRole: event.actorRole || undefined,
    fromStatus: event.fromStatus || undefined,
    toStatus: event.toStatus || undefined,
    details: event.details || {},
    delivery: 'none',
    at: iso(event.at)
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item, ConditionExpression: 'attribute_not_exists(id)' }));
  return toView(item);
}

async function setDelivery(id, delivery) {
  await ddb.send(new UpdateCommand({
    TableName: TABLE, Key: { id }, UpdateExpression: 'SET delivery = :d', ExpressionAttributeValues: { ':d': delivery }
  }));
}

async function forBooking(bookingId) {
  const items = await queryAll({
    IndexName: 'bookingId-at-index', KeyConditionExpression: 'bookingId = :b', ExpressionAttributeValues: { ':b': bookingId }
  });
  return items.map(toView).sort((a, b) => a.at.localeCompare(b.at));
}

async function ofType(type, since) {
  return queryAll({
    IndexName: 'type-at-index',
    KeyConditionExpression: since ? '#t = :t AND #at > :s' : '#t = :t',
    ExpressionAttributeNames: { '#t': 'type', ...(since ? { '#at': 'at' } : {}) },
    ExpressionAttributeValues: { ':t': type, ...(since ? { ':s': iso(since) } : {}) },
    ScanIndexForward: false
  });
}

async function recent({ types = null, since = null, limit = 50 } = {}) {
  const lists = await Promise.all((types || TYPES).map((t) => ofType(t, since)));
  return lists.flat().map(toView).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit);
}

async function countSince(since) {
  const counts = {};
  await Promise.all(TYPES.map(async (type) => {
    const result = await ddb.send(new QueryCommand({
      TableName: TABLE,
      IndexName: 'type-at-index',
      KeyConditionExpression: '#t = :t AND #at > :s',
      ExpressionAttributeNames: { '#t': 'type', '#at': 'at' },
      ExpressionAttributeValues: { ':t': type, ':s': iso(since) },
      Select: 'COUNT'
    }));
    if (result.Count) counts[type] = result.Count;
  }));
  return counts;
}

async function countDeliveryFailuresSince(since) {
  let count = 0;
  let ExclusiveStartKey;
  do {
    const result = await ddb.send(new ScanCommand({
      TableName: TABLE,
      FilterExpression: 'delivery = :f AND #at > :s',
      ExpressionAttributeNames: { '#at': 'at' },
      ExpressionAttributeValues: { ':f': 'failed', ':s': iso(since) },
      Select: 'COUNT',
      ExclusiveStartKey
    }));
    count += result.Count || 0;
    ExclusiveStartKey = result.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return count;
}

module.exports = { add, setDelivery, forBooking, recent, countSince, countDeliveryFailuresSince };
