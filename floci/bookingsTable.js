// The Booking DynamoDB table and its three indexes (used by deploy.js).
const TABLE = 'FleetDeskBookings';

const keys = (hash, range) => [
  { AttributeName: hash, KeyType: 'HASH' },
  ...(range ? [{ AttributeName: range, KeyType: 'RANGE' }] : [])
];

const createTableInput = {
  TableName: TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: ['id', 'userId', 'vehicleId', 'status', 'startAt', 'createdAt']
    .map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
  KeySchema: keys('id'),
  GlobalSecondaryIndexes: [
    { IndexName: 'userId-startAt-index', KeySchema: keys('userId', 'startAt'), Projection: { ProjectionType: 'ALL' } },
    { IndexName: 'vehicleId-startAt-index', KeySchema: keys('vehicleId', 'startAt'), Projection: { ProjectionType: 'ALL' } },
    { IndexName: 'status-createdAt-index', KeySchema: keys('status', 'createdAt'), Projection: { ProjectionType: 'ALL' } }
  ]
};

// Events table: audit trail, monitoring counts and alert history.
const EVENTS_TABLE = 'FleetDeskBookingEvents';
const createEventsTableInput = {
  TableName: EVENTS_TABLE,
  BillingMode: 'PAY_PER_REQUEST',
  AttributeDefinitions: ['id', 'bookingId', 'type', 'at'].map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
  KeySchema: keys('id'),
  GlobalSecondaryIndexes: [
    { IndexName: 'bookingId-at-index', KeySchema: keys('bookingId', 'at'), Projection: { ProjectionType: 'ALL' } },
    { IndexName: 'type-at-index', KeySchema: keys('type', 'at'), Projection: { ProjectionType: 'ALL' } }
  ]
};

module.exports = { TABLE, createTableInput, EVENTS_TABLE, createEventsTableInput };
