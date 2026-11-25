// Deploys the WHOLE FleetDesk project to Floci on your PC (local testing only, never pushed):
//
//   RDS Postgres  fleetdesk-fleet-db                        (Kareem's Fleet data: users, cars, maintenance)
//   DynamoDB      FleetDeskBookings, FleetDeskBookingEvents  (bookings + audit trail; BOOKING_STORE=rds keeps them in Postgres)
//   SNS -> SQS    fleetdesk-booking-events -> trip-booking-events   (booking events for the Trip service)
//                 fleetdesk-alerts -> fleetdesk-alerts-inbox        (monitoring alerts)
//   Lambda        fleetdesk-fleet-api, fleetdesk-booking-api (the same Express apps, through serverless-http)
//   API Gateway   one HTTP API per service                   (separately deployed services)
//   S3            fleetdesk-site                             (the website)
//
// Run from this folder:   npm run deploy
// Running it again is safe: it reuses what exists and updates the code and settings.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const AdmZip = require('adm-zip');
const { Client: PgClient } = require('pg');
const bcrypt = require('bcryptjs');
const { RDSClient, CreateDBInstanceCommand, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const {
  LambdaClient, GetFunctionCommand, CreateFunctionCommand, UpdateFunctionCodeCommand,
  UpdateFunctionConfigurationCommand, AddPermissionCommand
} = require('@aws-sdk/client-lambda');
const { IAMClient, GetRoleCommand, CreateRoleCommand } = require('@aws-sdk/client-iam');
const {
  ApiGatewayV2Client, GetApisCommand, CreateApiCommand, GetIntegrationsCommand, CreateIntegrationCommand,
  GetRoutesCommand, CreateRouteCommand, GetStagesCommand, CreateStageCommand
} = require('@aws-sdk/client-apigatewayv2');
const { S3Client, CreateBucketCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { DynamoDBClient, DescribeTableCommand, CreateTableCommand } = require('@aws-sdk/client-dynamodb');
const { createTableInput, createEventsTableInput } = require('./bookingsTable');
const { SNSClient, CreateTopicCommand, SubscribeCommand } = require('@aws-sdk/client-sns');
const { SQSClient, CreateQueueCommand, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');

// ---------- settings ----------

const ROOT = path.resolve(__dirname, '..');                     // the repo copy (fleet-service, booking-service, frontend)
const BUILD = path.join(__dirname, 'build');
const STATE_FILE = path.join(__dirname, '.state.json');         // generated secrets, stays on your PC

const ENDPOINT = process.env.FLOCI_URL || 'http://localhost:4566';
const REGION = process.env.AWS_REGION || 'us-east-1';
const ACCOUNT = process.env.FLOCI_ACCOUNT || '000000000000';
const DB_HOST_FROM_PC = process.env.DB_HOST_FROM_PC || 'localhost';         // how this script reaches the RDS proxy
const DB_HOST_FROM_LAMBDA = process.env.DB_HOST_FROM_LAMBDA || 'floci';     // how Lambda containers reach it
const FLOCI_FROM_LAMBDA = process.env.FLOCI_FROM_LAMBDA || 'http://floci:4566';
const RUNTIME = process.env.LAMBDA_RUNTIME || 'nodejs22.x';
const SITE_BUCKET = 'fleetdesk-site';
const DEMO_PASSWORD = 'Demo-Pass-2026';
const BOOKING_STORE = (process.env.BOOKING_STORE || 'dynamodb').toLowerCase();   // 'dynamodb' or 'rds'

const aws = { endpoint: ENDPOINT, region: REGION, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
const rds = new RDSClient(aws);
const lambda = new LambdaClient(aws);
const iam = new IAMClient(aws);
const apigw = new ApiGatewayV2Client(aws);
const s3 = new S3Client({ ...aws, forcePathStyle: true });
const dynamo = new DynamoDBClient(aws);
const snsApi = new SNSClient(aws);
const sqsApi = new SQSClient(aws);

const SERVICES = {
  fleet: {
    folder: 'fleet-service',
    db: 'fleetdesk-fleet-db',
    role: 'fleet_api',
    grants: 'GRANT SELECT, INSERT, UPDATE ON users, vehicles, maintenance, vehicle_reports TO fleet_api;',
    fn: 'fleetdesk-fleet-api',
    api: 'fleetdesk-fleet-http'
  },
  booking: {
    folder: 'booking-service',
    db: 'fleetdesk-booking-db',
    role: 'booking_api',
    grants: 'GRANT SELECT, INSERT, UPDATE ON bookings TO booking_api; GRANT SELECT, INSERT, UPDATE (delivery) ON booking_events TO booking_api;',
    fn: 'fleetdesk-booking-api',
    api: 'fleetdesk-booking-http'
  }
};

const step = (text) => console.log(`\n== ${text}`);
const info = (text) => console.log(`   ${text}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const secret = (bytes = 24) => crypto.randomBytes(bytes).toString('base64url');

function loadState() {
  const state = fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) : {};
  state.jwtSecret = state.jwtSecret || secret(48);
  state.masterPassword = state.masterPassword || secret(18);
  state.fleetApiPassword = state.fleetApiPassword || secret(18);
  state.bookingApiPassword = state.bookingApiPassword || secret(18);
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  return state;
}

function readEnvValue(file, name) {
  if (!fs.existsSync(file)) return '';
  // Tolerant of a byte-order mark (Notepad), spaces around "=", "export " and quotes.
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`));
    if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  }
  return '';
}

async function waitFor(what, check, { timeoutMs = 180000, everyMs = 2000 } = {}) {
  const until = Date.now() + timeoutMs;
  let last;
  while (Date.now() < until) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await sleep(everyMs);
  }
  throw new Error(`Timed out waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}

// ---------- 0. Floci running? ----------

async function checkFloci() {
  step(`0. Floci at ${ENDPOINT}`);
  try {
    await rds.send(new DescribeDBInstancesCommand({}));
    info('Floci answers.');
  } catch (error) {
    console.error(`\nCannot reach Floci at ${ENDPOINT} (${error.name || error.message}).`);
    console.error('Start it first, from this folder:   docker compose up -d');
    process.exit(1);
  }
}

// ---------- 1. RDS databases ----------

async function ensureDatabase(name, state) {
  let instance;
  try {
    instance = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: name }))).DBInstances[0];
    info(`${name} exists (${instance.DBInstanceStatus}).`);
  } catch (error) {
    if (error.name !== 'DBInstanceNotFoundFault' && error.name !== 'DBInstanceNotFound') throw error;
    await rds.send(new CreateDBInstanceCommand({
      DBInstanceIdentifier: name,
      DBInstanceClass: 'db.t3.micro',
      Engine: 'postgres',
      MasterUsername: 'fleetdesk',
      MasterUserPassword: state.masterPassword,
      AllocatedStorage: 20
    }));
    info(`${name} created (the first time, Docker downloads postgres:16-alpine).`);
  }
  instance = await waitFor(`${name} to be available`, async () => {
    const found = (await rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: name }))).DBInstances[0];
    return found.DBInstanceStatus === 'available' && found.Endpoint && found.Endpoint.Port ? found : null;
  }, { timeoutMs: 300000 });
  const port = Number(process.env[`${name.toUpperCase().replace(/-/g, '_')}_PORT`]) || instance.Endpoint.Port;
  info(`${name} is available on port ${port}.`);
  return port;
}

async function connectAsMaster(port, state) {
  return waitFor(`Postgres on port ${port} to accept connections`, async () => {
    const client = new PgClient({
      host: DB_HOST_FROM_PC, port, user: 'fleetdesk', password: state.masterPassword, database: 'postgres', connectionTimeoutMillis: 4000
    });
    await client.connect();
    return client;
  }, { timeoutMs: 120000 });
}

async function setUpDatabase(key, port, state) {
  const svc = SERVICES[key];
  const password = key === 'fleet' ? state.fleetApiPassword : state.bookingApiPassword;
  const client = await connectAsMaster(port, state);
  try {
    const schema = fs.readFileSync(path.join(ROOT, svc.folder, 'db', 'schema.sql'), 'utf8');
    await client.query(schema);
    info(`${svc.folder}/db/schema.sql applied.`);

    // Least-privilege role the Lambda connects with (same rule as on Neon).
    await client.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${svc.role}') THEN CREATE ROLE ${svc.role} LOGIN; END IF;
    END $$;`);
    await client.query(`ALTER ROLE ${svc.role} WITH LOGIN PASSWORD '${password}';`);
    await client.query(svc.grants);
    info(`Role ${svc.role} ready (SELECT, INSERT, UPDATE only).`);

    if (key === 'fleet') {
      const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
      const users = [
        ['Fleet Admin', 'admin@fleetdesk.test', 'FleetAdmin'],
        ['Sara Employee', 'sara@fleetdesk.test', 'Employee'],
        ['Omar Employee', 'omar@fleetdesk.test', 'Employee']
      ];
      for (const [name, email, role] of users) {
        await client.query(
          'INSERT INTO users (name, email, password_hash, role) SELECT $1, $2, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM users WHERE email = $2)',
          [name, email, hash, role]
        );
      }
      const cars = [
        ['ABC 123', 'Toyota', 'Corolla', 2022, 'Sedan', 5, 18500, 10000],
        ['XYZ 456', 'Hyundai', 'Elantra', 2023, 'Sedan', 5, 9200, 0],
        ['VAN 789', 'Toyota', 'Hiace', 2021, 'Van', 12, 41000, 30000],
        ['PKP 321', 'Nissan', 'Navara', 2020, 'Pickup', 5, 63000, 60000]
      ];
      for (const car of cars) {
        await client.query(
          `INSERT INTO vehicles (plate_number, make, model, year, type, seats, current_mileage, last_service_mileage)
           SELECT $1, $2, $3, $4, $5, $6, $7, $8 WHERE NOT EXISTS (SELECT 1 FROM vehicles WHERE plate_number = $1)`,
          car
        );
      }
      info(`Demo users and cars ready (password ${DEMO_PASSWORD}).`);
    }
  } finally {
    await client.end();
  }
  return `postgres://${svc.role}:${encodeURIComponent(password)}@${DB_HOST_FROM_LAMBDA}:${port}/postgres`;
}

// ---------- 1b. DynamoDB table for bookings ----------

async function ensureTable(input, description) {
  const TableName = input.TableName;
  try {
    await dynamo.send(new DescribeTableCommand({ TableName }));
    info(`${TableName} exists.`);
  } catch (error) {
    if (error.name !== 'ResourceNotFoundException') throw error;
    await dynamo.send(new CreateTableCommand(input));
    info(`${TableName} created (${description}).`);
  }
  await waitFor(`${TableName} to be active`, async () => {
    const { Table } = await dynamo.send(new DescribeTableCommand({ TableName }));
    return Table.TableStatus === 'ACTIVE';
  }, { timeoutMs: 60000, everyMs: 1000 });
  return TableName;
}

// ---------- 1c. Event bus: SNS topics fanned out to SQS queues ----------

async function ensureTopicWithQueue(topicName, queueName) {
  const { TopicArn } = await snsApi.send(new CreateTopicCommand({ Name: topicName }));   // returns the existing one if present
  const { QueueUrl } = await sqsApi.send(new CreateQueueCommand({ QueueName: queueName }));
  const { Attributes } = await sqsApi.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  await snsApi.send(new SubscribeCommand({
    TopicArn, Protocol: 'sqs', Endpoint: Attributes.QueueArn, Attributes: { RawMessageDelivery: 'true' }
  }));
  info(`SNS ${topicName} -> SQS ${queueName}`);
  return TopicArn;
}

// ---------- 2. Build the Lambda packages ----------

function copyDir(from, to, skip) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (skip(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dest, skip);
    else fs.copyFileSync(src, dest);
  }
}

function zipFolder(folder) {
  const zip = new AdmZip();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else zip.addFile(path.relative(folder, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(folder);
  return zip.toBuffer();
}

function buildService(key) {
  const svc = SERVICES[key];
  const out = path.join(BUILD, svc.folder);
  fs.rmSync(out, { recursive: true, force: true });
  const skip = (name) => ['node_modules', 'tests', 'coverage', '.vercel'].includes(name) || name.startsWith('.env');
  copyDir(path.join(ROOT, svc.folder), out, skip);

  // Floci-only changes, made in the build copy (the service folders stay exactly like GitHub):
  fs.copyFileSync(path.join(__dirname, 'runtime', 'sql.js'), path.join(out, 'db', 'sql.js'));
  fs.copyFileSync(path.join(__dirname, 'runtime', 'lambda.js'), path.join(out, 'lambda.js'));
  fs.copyFileSync(path.join(__dirname, 'runtime', 'lambda-fetch.js'), path.join(out, 'lambda-fetch.js'));
  const useDynamo = key === 'booking' && BOOKING_STORE === 'dynamodb';
  if (useDynamo) {
    // Same functions and rules, stored in DynamoDB instead of Postgres.
    fs.copyFileSync(path.join(__dirname, 'runtime', 'dynamoBookingService.js'), path.join(out, 'services', 'bookingService.js'));
    fs.copyFileSync(path.join(__dirname, 'runtime', 'dynamoEventStore.js'), path.join(out, 'services', 'eventStore.js'));
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(out, 'package.json'), 'utf8'));
  delete pkg.devDependencies;
  delete pkg.jest;
  pkg.dependencies = {
    ...pkg.dependencies,
    pg: '^8.13.1',
    'serverless-http': '^3.2.0',
    '@aws-sdk/client-lambda': '^3.700.0',
    ...(key === 'booking' ? { '@aws-sdk/client-sns': '^3.700.0' } : {}),
    ...(useDynamo ? { '@aws-sdk/client-dynamodb': '^3.700.0', '@aws-sdk/lib-dynamodb': '^3.700.0' } : {})
  };
  fs.writeFileSync(path.join(out, 'package.json'), JSON.stringify(pkg, null, 2));
  fs.rmSync(path.join(out, 'package-lock.json'), { force: true });

  info(`npm install in build/${svc.folder} (production packages only)...`);
  execSync('npm install --omit=dev --no-audit --no-fund --loglevel=error', { cwd: out, stdio: 'inherit' });
  const zip = zipFolder(out);
  fs.writeFileSync(path.join(BUILD, `${svc.folder}.zip`), zip);
  info(`build/${svc.folder}.zip (${(zip.length / 1024 / 1024).toFixed(1)} MB)`);
  return zip;
}

// ---------- 3. Lambda functions ----------

async function ensureRole() {
  const RoleName = 'fleetdesk-lambda-role';
  try {
    return (await iam.send(new GetRoleCommand({ RoleName }))).Role.Arn;
  } catch (error) {
    const trust = { Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'lambda.amazonaws.com' }, Action: 'sts:AssumeRole' }] };
    return (await iam.send(new CreateRoleCommand({ RoleName, AssumeRolePolicyDocument: JSON.stringify(trust) }))).Role.Arn;
  }
}

async function waitForFunction(name) {
  await waitFor(`${name} to be ready`, async () => {
    const { Configuration } = await lambda.send(new GetFunctionCommand({ FunctionName: name }));
    if (Configuration.State === 'Failed') throw new Error(Configuration.StateReason || 'function failed');
    const ready = (!Configuration.State || Configuration.State === 'Active')
      && (!Configuration.LastUpdateStatus || Configuration.LastUpdateStatus === 'Successful');
    return ready;
  }, { timeoutMs: 120000 });
}

async function deployFunction(name, zip, env, roleArn) {
  const Environment = { Variables: env };
  let exists = true;
  try {
    await lambda.send(new GetFunctionCommand({ FunctionName: name }));
  } catch (error) {
    exists = false;
  }
  if (exists) {
    await lambda.send(new UpdateFunctionCodeCommand({ FunctionName: name, ZipFile: zip }));
    await waitForFunction(name);
    await lambda.send(new UpdateFunctionConfigurationCommand({
      FunctionName: name, Environment, Runtime: RUNTIME, Handler: 'lambda.handler', Timeout: 20, MemorySize: 512
    }));
    info(`${name} updated.`);
  } else {
    await lambda.send(new CreateFunctionCommand({
      FunctionName: name, Runtime: RUNTIME, Handler: 'lambda.handler', Role: roleArn,
      Code: { ZipFile: zip }, Timeout: 20, MemorySize: 512, Environment
    }));
    info(`${name} created.`);
  }
  await waitForFunction(name);
  return `arn:aws:lambda:${REGION}:${ACCOUNT}:function:${name}`;
}

// ---------- 4. API Gateway (one HTTP API per service) ----------

async function deployApi(name, functionName, functionArn) {
  const apis = (await apigw.send(new GetApisCommand({}))).Items || [];
  let api = apis.find((a) => a.Name === name);
  if (!api) {
    api = await apigw.send(new CreateApiCommand({ Name: name, ProtocolType: 'HTTP' }));
    info(`${name} created (${api.ApiId}).`);
  } else {
    info(`${name} exists (${api.ApiId}).`);
  }
  const ApiId = api.ApiId;

  const integrations = (await apigw.send(new GetIntegrationsCommand({ ApiId }))).Items || [];
  let integration = integrations.find((i) => i.IntegrationUri === functionArn);
  if (!integration) {
    integration = await apigw.send(new CreateIntegrationCommand({
      ApiId, IntegrationType: 'AWS_PROXY', IntegrationUri: functionArn, PayloadFormatVersion: '2.0'
    }));
  }

  // Every /api/... request goes to the function; Express decides the rest (including CORS preflight).
  const existing = new Set(((await apigw.send(new GetRoutesCommand({ ApiId }))).Items || []).map((r) => r.RouteKey));
  for (const method of ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS']) {
    for (const routePath of ['/api/{proxy+}', '/']) {
      const RouteKey = `${method} ${routePath}`;
      if (routePath === '/' && method !== 'GET') continue;
      if (!existing.has(RouteKey)) {
        await apigw.send(new CreateRouteCommand({ ApiId, RouteKey, Target: `integrations/${integration.IntegrationId}` }));
      }
    }
  }
  const stages = (await apigw.send(new GetStagesCommand({ ApiId }))).Items || [];
  if (!stages.find((s) => s.StageName === '$default')) {
    await apigw.send(new CreateStageCommand({ ApiId, StageName: '$default', AutoDeploy: true }));
  }
  try {
    await lambda.send(new AddPermissionCommand({
      FunctionName: functionName, StatementId: `apigw-${ApiId}`, Action: 'lambda:InvokeFunction',
      Principal: 'apigateway.amazonaws.com', SourceArn: `arn:aws:execute-api:${REGION}:${ACCOUNT}:${ApiId}/*`
    }));
  } catch (error) {
    // already allowed
  }
  return `http://${ApiId}.execute-api.localhost.floci.io:4566`;
}

// ---------- 5. Website on S3 ----------

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

function buildSite(urls) {
  const out = path.join(BUILD, 'frontend');
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(path.join(ROOT, 'frontend'), out, (name) => name === 'vercel.json');

  fs.writeFileSync(path.join(out, 'js', 'config.js'), `// Generated by floci/deploy.js for the Floci copy. Do not commit.
const IS_LOCAL = true;
const FLEET_API_URL = '${urls.fleet}';
const BOOKING_API_URL = '${urls.booking}';
const TRIPS_API_URL = 'http://localhost:3003';
`);

  // Floci copy only: add the Bookings link to Kareem's pages if they do not have it yet.
  for (const page of ['vehicles.html', 'maintenance.html', 'reports.html']) {
    const file = path.join(out, page);
    if (!fs.existsSync(file)) continue;
    let html = fs.readFileSync(file, 'utf8');
    if (!html.includes('href="bookings.html"')) {
      html = html.replace(/(<a href="vehicles\.html"[^>]*>Cars<\/a>)/, '$1\n      <a href="bookings.html">Bookings</a>');
      fs.writeFileSync(file, html);
    }
  }
  return out;
}

async function uploadSite(folder) {
  try {
    await s3.send(new CreateBucketCommand({ Bucket: SITE_BUCKET }));
  } catch (error) {
    if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) throw error;
  }
  const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
  for (const file of walk(folder)) {
    const Key = path.relative(folder, file).split(path.sep).join('/');
    await s3.send(new PutObjectCommand({
      Bucket: SITE_BUCKET, Key, Body: fs.readFileSync(file),
      ContentType: TYPES[path.extname(file)] || 'application/octet-stream', CacheControl: 'no-store'
    }));
  }
  return `${ENDPOINT}/${SITE_BUCKET}/index.html`;
}

// ---------- 6. Smoke test ----------

async function smokeTest(urls) {
  const call = async (url, options = {}) => {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(90000) });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  };
  const report = (label, ok, detail) => info(`${ok ? 'OK  ' : 'FAIL'} ${label}${detail ? `  (${detail})` : ''}`);
  try {
    const fleetHealth = await call(`${urls.fleet}/api/health`);
    report('Fleet API health', fleetHealth.status === 200, fleetHealth.status);
    const bookingHealth = await call(`${urls.booking}/api/health`);
    report('Booking API health', bookingHealth.status === 200, bookingHealth.status);

    const login = await call(`${urls.fleet}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sara@fleetdesk.test', password: DEMO_PASSWORD })
    });
    report('Login through Fleet (Lambda -> RDS)', login.status === 200, login.status === 200 ? 'token received' : JSON.stringify(login.body));
    if (login.status !== 200) return;

    const from = new Date(Date.now() + 26 * 3600e3).toISOString();
    const to = new Date(Date.now() + 30 * 3600e3).toISOString();
    const search = await call(`${urls.booking}/api/bookings/availability?from=${from}&to=${to}`, {
      headers: { Authorization: `Bearer ${login.body.token}` }
    });
    report('Booking asks Fleet for free cars (Lambda -> Lambda)', search.status === 200,
      search.status === 200 ? `${search.body.cars.length} cars` : JSON.stringify(search.body));
  } catch (error) {
    info(`Smoke test could not finish: ${error.message}`);
    info('Open the website below anyway; the first call to each Lambda can be slow while Docker starts it.');
  }
}

// ---------- main ----------

async function main() {
  for (const folder of ['fleet-service', 'booking-service', 'frontend']) {
    if (!fs.existsSync(path.join(ROOT, folder, 'package.json')) && folder !== 'frontend') {
      console.error(`\n${folder} is not in the repository yet (it arrives when its owner's pull request is merged).`);
      console.error('Run "git pull" on main after the merge, then npm run deploy again.');
      process.exit(1);
    }
  }
  if (!fs.existsSync(path.join(ROOT, 'frontend', 'js', 'api.js'))) {
    console.error('\nThe shared website files (frontend/index.html, js/api.js, ...) are not merged yet. Run "git pull" after Kareem\'s pull request.');
    process.exit(1);
  }
  const state = loadState();
  await checkFloci();

  step('1. Databases');
  const fleetPort = await ensureDatabase(SERVICES.fleet.db, state);
  const fleetDbUrl = await setUpDatabase('fleet', fleetPort, state);
  let bookingDbUrl = '';
  let bookingsTable = '';
  if (BOOKING_STORE === 'dynamodb') {
    bookingsTable = await ensureTable(createTableInput, 'key "id", indexes by employee, by car and by status');
    await ensureTable(createEventsTableInput, 'audit trail: indexes by booking and by event type');
  } else {
    const bookingPort = await ensureDatabase(SERVICES.booking.db, state);
    bookingDbUrl = await setUpDatabase('booking', bookingPort, state);
  }

  step('1c. Event bus (SNS -> SQS)');
  const eventsTopic = await ensureTopicWithQueue('fleetdesk-booking-events', 'trip-booking-events');
  const alertsTopic = await ensureTopicWithQueue('fleetdesk-alerts', 'fleetdesk-alerts-inbox');

  step('2. Build the Lambda packages');
  const fleetZip = buildService('fleet');
  const bookingZip = buildService('booking');

  step('3. Lambda functions');
  const roleArn = await ensureRole();
  const cors = 'http://localhost:4566,http://localhost:8080,http://127.0.0.1:8080';
  const orsKey = process.env.ORS_API_KEY || readEnvValue(path.join(ROOT, 'booking-service', '.env'), 'ORS_API_KEY')
    || readEnvValue(path.join(__dirname, '.env'), 'ORS_API_KEY');
  const alertWebhook = process.env.ALERT_WEBHOOK_URL || readEnvValue(path.join(__dirname, '.env'), 'ALERT_WEBHOOK_URL');
  const fleetArn = await deployFunction(SERVICES.fleet.fn, fleetZip, {
    NODE_ENV: 'production',
    DATABASE_URL: fleetDbUrl,
    JWT_SECRET: state.jwtSecret,
    CORS_ORIGINS: cors,
    BOOKING_API_URL: `lambda://${SERVICES.booking.fn}`,
    FLOCI_ENDPOINT: FLOCI_FROM_LAMBDA,
    TURNSTILE_ENABLED: 'false',
    // Self-registration on the Floci copy: Employee accounts only, company domains only.
    SIGNUP_ENABLED: 'true',
    SIGNUP_EMAIL_DOMAINS: process.env.SIGNUP_EMAIL_DOMAINS || readEnvValue(path.join(__dirname, '.env'), 'SIGNUP_EMAIL_DOMAINS') || 'fleetdesk.test'
  }, roleArn);
  const bookingArn = await deployFunction(SERVICES.booking.fn, bookingZip, {
    NODE_ENV: 'production',
    ...(bookingsTable ? { BOOKINGS_TABLE: bookingsTable } : { DATABASE_URL: bookingDbUrl }),
    JWT_SECRET: state.jwtSecret,
    CORS_ORIGINS: cors,
    FLEET_API_URL: `lambda://${SERVICES.fleet.fn}`,
    FLOCI_ENDPOINT: FLOCI_FROM_LAMBDA,
    ORS_API_KEY: orsKey,
    EVENTS_SNS_TOPIC_ARN: eventsTopic,
    ALERTS_SNS_TOPIC_ARN: alertsTopic,
    ...(alertWebhook ? { ALERT_WEBHOOK_URL: alertWebhook } : {})
  }, roleArn);
  info(`Bookings are stored in ${bookingsTable ? `DynamoDB (${bookingsTable})` : 'RDS Postgres'}.`);
  info(`Booking events go to SNS fleetdesk-booking-events; alerts to fleetdesk-alerts${alertWebhook ? ' and your ALERT_WEBHOOK_URL' : ''}.`);
  info(orsKey
    ? `ORS_API_KEY found (${orsKey.length} characters): trip estimates are on.`
    : 'No ORS_API_KEY found in booking-service\\.env or floci\\.env: trip estimates are off (bookings still work).');

  step('4. API Gateway');
  const urls = {
    fleet: await deployApi(SERVICES.fleet.api, SERVICES.fleet.fn, fleetArn),
    booking: await deployApi(SERVICES.booking.api, SERVICES.booking.fn, bookingArn)
  };
  info(`Fleet API:   ${urls.fleet}`);
  info(`Booking API: ${urls.booking}`);

  step('5. Website on S3');
  const siteFolder = buildSite(urls);
  const siteUrl = await uploadSite(siteFolder);
  fs.writeFileSync(path.join(BUILD, 'urls.json'), JSON.stringify({ ...urls, site: siteUrl }, null, 2));

  step('6. Smoke test');
  await smokeTest(urls);

  console.log(`
Done.
  Website:      ${siteUrl}
  (or run "npm run site" and open http://localhost:8080)
  Log in as sara@fleetdesk.test / omar@fleetdesk.test / admin@fleetdesk.test, password ${DEMO_PASSWORD}
  Fleet API:    ${urls.fleet}/api/health
  Booking API:  ${urls.booking}/api/health
  Logs:         npm run logs -- booking     (or fleet)
  Data:         npm run db  |  RDS: http://localhost:8081  |  DynamoDB: http://localhost:8001
  Events:       npm run events   (messages waiting in the SQS queues)
`);
}

main().catch((error) => {
  console.error(`\nDeploy failed: ${error.name ? `${error.name}: ` : ''}${error.message}`);
  process.exit(1);
});
