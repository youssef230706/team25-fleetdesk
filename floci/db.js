// Shows what is stored on Floci: the Fleet RDS Postgres database and the bookings (DynamoDB or RDS).
//   npm run db                 everything, newest first
//   npm run db -- bookings     only one table (bookings, events, vehicles, users, maintenance, vehicle_reports)

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, ScanCommand } = require('@aws-sdk/lib-dynamodb');
const { TABLE, EVENTS_TABLE } = require('./bookingsTable');

const rds = new RDSClient({
  endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
});
const awsConfig = {
  endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
};
const state = JSON.parse(fs.readFileSync(path.join(__dirname, '.state.json'), 'utf8'));
const only = process.argv[2];

const DATABASES = [
  { id: 'fleetdesk-fleet-db', tables: ['users', 'vehicles', 'maintenance', 'vehicle_reports'] },
  { id: 'fleetdesk-booking-db', tables: ['bookings'] }
];
// Never print password hashes.
const HIDE = ['password_hash'];

async function portOf(id) {
  const override = process.env[`${id.toUpperCase().replace(/-/g, '_')}_PORT`];
  if (override) return Number(override);
  const { DBInstances } = await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: id }));
  return DBInstances[0].Endpoint.Port;
}

const short = (value) => (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) ? value.slice(0, 16).replace('T', ' ') : value);

// Bookings in DynamoDB (the default). Returns false if the table does not exist (BOOKING_STORE=rds).
async function showDynamoBookings() {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));
  let items;
  try {
    items = (await doc.send(new ScanCommand({ TableName: TABLE }))).Items || [];
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') return false;
    throw error;
  }
  const bookings = items.filter((i) => !String(i.id).startsWith('LOCK#'))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))).slice(0, 20);
  console.log(`\n######## DynamoDB table ${TABLE}`);
  console.log(`\n== bookings (${bookings.length} item${bookings.length === 1 ? '' : 's'} shown)`);
  if (bookings.length) {
    console.table(bookings.map((b) => ({
      id: b.id.slice(0, 8), user: b.userName, car: b.vehiclePlate, purpose: b.purpose, destination: b.destination,
      start: short(b.startAt), end: short(b.endAt), status: b.status,
      km: b.estimate ? b.estimate.distanceKm : null, decidedBy: b.decidedBy || null, created: short(b.createdAt)
    })));
  }
  return true;
}

// The audit trail / event log (DynamoDB).
async function showDynamoEvents() {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient(awsConfig));
  let items;
  try {
    items = (await doc.send(new ScanCommand({ TableName: EVENTS_TABLE }))).Items || [];
  } catch (error) {
    if (error.name === 'ResourceNotFoundException') return false;
    throw error;
  }
  const events = items.sort((a, b) => String(b.at).localeCompare(String(a.at))).slice(0, 30);
  console.log(`\n######## DynamoDB table ${EVENTS_TABLE}`);
  console.log(`\n== events (${events.length} newest shown)`);
  if (events.length) {
    console.table(events.map((e) => ({
      at: short(e.at), type: e.type, booking: e.bookingId ? e.bookingId.slice(0, 8) : '', role: e.actorRole || 'anonymous',
      change: e.fromStatus || e.toStatus ? `${e.fromStatus || '-'} -> ${e.toStatus || '-'}` : '', delivery: e.delivery,
      detail: e.details && (e.details.reason || e.details.path || e.details.rule || (e.details.changed || []).join(', ')) || ''
    })));
  }
  return true;
}

async function main() {
  if (only === 'events') {
    if (!(await showDynamoEvents())) console.log('No events table (BOOKING_STORE=rds keeps events in Postgres: use Adminer).');
    return;
  }
  if ((!only || only === 'bookings') && await showDynamoBookings()) {
    DATABASES.splice(1, 1);   // bookings are in DynamoDB, not in the booking RDS database
    if (only === 'bookings') return;
  }
  for (const database of DATABASES) {
    const tables = database.tables.filter((t) => !only || t === only);
    if (tables.length === 0) continue;
    const port = await portOf(database.id);
    const client = new Client({ host: 'localhost', port, user: 'fleetdesk', password: state.masterPassword, database: 'postgres' });
    await client.connect();
    console.log(`\n######## RDS ${database.id} (localhost:${port})`);
    for (const table of tables) {
      const { rows } = await client.query(`SELECT * FROM ${table} ORDER BY created_at DESC LIMIT 20`);
      console.log(`\n== ${table} (${rows.length} row${rows.length === 1 ? '' : 's'} shown)`);
      if (rows.length) {
        console.table(rows.map((row) => Object.fromEntries(Object.entries(row)
          .filter(([key]) => !HIDE.includes(key))
          .map(([key, value]) => [key, value instanceof Date ? value.toISOString().slice(0, 16).replace('T', ' ') : value]))));
      }
    }
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Could not read the databases: ${error.message}`);
  console.error('Is Floci running, and did "npm run deploy" finish? (docker compose up -d, then npm run deploy)');
  process.exit(1);
});
