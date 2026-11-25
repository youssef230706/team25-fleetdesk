// Adds a user who can log in to the FleetDesk copy on Floci (password stored only as a bcrypt hash).
//   npm run add-user -- "Mona Hassan" mona@fleetdesk.test Employee "Some-Strong-Pass-1"
//   npm run add-user -- "Second Admin" admin2@fleetdesk.test FleetAdmin "Another-Strong-Pass-2"
// Running it again for the same email updates that user's name, role and password.

const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');

const [name, email, role, password] = process.argv.slice(2);
const ROLES = ['Employee', 'FleetAdmin'];

function stop(message) {
  console.error(message);
  console.error('Usage: npm run add-user -- "Full Name" email@example.com Employee|FleetAdmin "Password"');
  process.exit(1);
}

if (!name || !email || !role || !password) stop('Missing details.');
if (name.trim().length < 2 || name.length > 100) stop('The name must be 2 to 100 characters.');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 120) stop('That email does not look right.');
if (!ROLES.includes(role)) stop(`The role must be exactly Employee or FleetAdmin (you wrote "${role}").`);
if (password.length < 8 || password.length > 200) stop('The password must be at least 8 characters.');

async function main() {
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, '.state.json'), 'utf8'));
  const rds = new RDSClient({
    endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
    region: process.env.AWS_REGION || 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
  });
  const port = Number(process.env.FLEETDESK_FLEET_DB_PORT)
    || (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: 'fleetdesk-fleet-db' }))).DBInstances[0].Endpoint.Port;

  const client = new Client({ host: 'localhost', port, user: 'fleetdesk', password: state.masterPassword, database: 'postgres' });
  await client.connect();
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await client.query(
      `INSERT INTO users (name, email, password_hash, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, password_hash = EXCLUDED.password_hash,
                                         role = EXCLUDED.role, failed_logins = 0, locked_until = NULL
       RETURNING (xmax = 0) AS created`,
      [name.trim(), email.toLowerCase(), hash, role]
    );
    console.log(`${rows[0].created ? 'Added' : 'Updated'} ${role} ${email.toLowerCase()} (${name.trim()}). They can log in now.`);
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(`Could not add the user: ${error.message}`);
  console.error('Is Floci running, and did "npm run deploy" finish?');
  process.exit(1);
});
