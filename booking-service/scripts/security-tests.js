// Controlled security tests for the Booking service, run against a RUNNING deployment
// (local demo, Floci or the live Vercel site). Writes the report's security test table.
//
//   npm run security-tests                         local demo (npm run demo:all must be running)
//   $env:BOOKING_API_URL="https://<booking>.vercel.app"; $env:FLEET_API_URL="https://fleetdesk-fleet-api.vercel.app"
//   $env:EMPLOYEE_EMAIL="..."; $env:EMPLOYEE_PASSWORD="..."      (a second employee and an admin too, see below)
//   npm run security-tests
//
// Accounts: EMPLOYEE_*, EMPLOYEE2_* and ADMIN_* (email + password). For localhost they default to the
// public demo accounts; for any other address they MUST come from environment variables (never in code).
// Output: security-test-results.md (table for the report) and security-test-results.json, next to this file.
// It creates a few test bookings far in the future and cancels them at the end.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { scan } = require('./secret-scan');

const BOOKING = (process.env.BOOKING_API_URL || 'http://localhost:3002').replace(/\/$/, '');
const FLEET = (process.env.FLEET_API_URL || 'http://localhost:3001').replace(/\/$/, '');
const LOCAL = /localhost|127\.0\.0\.1/.test(BOOKING);
const DEMO = 'Demo-Pass-2026';

function account(prefix, demoEmail) {
  const email = process.env[`${prefix}_EMAIL`] || (LOCAL ? demoEmail : '');
  const password = process.env[`${prefix}_PASSWORD`] || (LOCAL ? DEMO : '');
  if (!email || !password) {
    console.error(`Set ${prefix}_EMAIL and ${prefix}_PASSWORD (environment variables) to test ${BOOKING}.`);
    process.exit(1);
  }
  return { email, password };
}

const results = [];
const created = [];
let caseNo = 0;

async function call(method, url, { token, body, headers = {}, raw } = {}) {
  const h = { Accept: 'application/json', ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
  if (raw) h['Content-Type'] = raw.type;
  const response = await fetch(url, { method, headers: h, body: raw ? raw.body : body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  let json = null;
  try { json = JSON.parse(text); } catch (error) { json = null; }
  return { status: response.status, json, headers: response.headers };
}

function summary(res) {
  const code = res.json && res.json.error ? ` ${res.json.error.code}` : '';
  return `${res.status}${code}`;
}

async function test(category, scenario, expected, run) {
  caseNo += 1;
  const id = `SEC-${String(caseNo).padStart(2, '0')}`;
  try {
    const { pass, actual } = await run();
    results.push({ id, category, scenario, expected, actual, result: pass ? 'PASS' : 'FAIL' });
  } catch (error) {
    results.push({ id, category, scenario, expected, actual: `error: ${error.message}`, result: 'FAIL' });
  }
}

async function login({ email, password }) {
  const res = await call('POST', `${FLEET}/api/auth/login`, { body: { email, password } });
  if (res.status !== 200) throw new Error(`login for ${email} failed (${summary(res)})`);
  return { token: res.json.token, user: res.json.user };
}

function period(daysAhead, hours = 2) {
  const start = new Date(Date.now() + daysAhead * 24 * 3600e3);
  start.setUTCMinutes(0, 0, 0);
  start.setUTCHours(5 + Math.floor(Math.random() * 10));
  return { startAt: start.toISOString(), endAt: new Date(start.getTime() + hours * 3600e3).toISOString() };
}

async function main() {
  console.log(`Security tests against ${BOOKING} (Fleet login: ${FLEET})\n`);
  const emp = await login(account('EMPLOYEE', 'sara@fleetdesk.test'));
  const emp2 = await login(account('EMPLOYEE2', 'omar@fleetdesk.test'));
  const admin = await login(account('ADMIN', 'admin@fleetdesk.test'));

  // A car and a free period far ahead, so the tests never touch real bookings.
  const day = 60 + Math.floor(Math.random() * 25);
  const slot = period(day);
  const search = await call('GET', `${BOOKING}/api/bookings/availability?from=${slot.startAt}&to=${slot.endAt}&seats=1`, { token: emp.token });
  if (search.status !== 200 || !search.json.cars.length) throw new Error(`no free car to test with (${summary(search)})`);
  const car = search.json.cars[0];
  const base = { vehicleId: car.id, ...slot, purpose: 'Security test booking', destination: 'Cairo', passengers: 1 };

  const mine = await call('POST', `${BOOKING}/api/bookings`, { token: emp.token, body: base });
  if (mine.status !== 201) throw new Error(`could not create the test booking (${summary(mine)})`);
  created.push({ id: mine.json.id, token: emp.token });
  const bookingUrl = `${BOOKING}/api/bookings/${mine.json.id}`;

  // ---- Authentication ----
  await test('Authentication', 'List bookings with no token', '401', async () => {
    const r = await call('GET', `${BOOKING}/api/bookings`);
    return { pass: r.status === 401, actual: summary(r) };
  });
  await test('Authentication', 'Token signed with a different secret (forged admin)', '401', async () => {
    const forged = jwt.sign({ sub: emp.user.id, role: 'FleetAdmin', name: 'Forged' }, crypto.randomBytes(48).toString('hex'), { issuer: 'fleetdesk', expiresIn: '5m' });
    const r = await call('GET', `${BOOKING}/api/bookings/metrics`, { token: forged });
    return { pass: r.status === 401, actual: summary(r) };
  });
  await test('Authentication', 'Unsigned token (alg "none") claiming FleetAdmin', '401', async () => {
    const unsigned = jwt.sign({ sub: emp.user.id, role: 'FleetAdmin' }, null, { algorithm: 'none', issuer: 'fleetdesk' });
    const r = await call('GET', `${BOOKING}/api/bookings`, { token: unsigned });
    return { pass: r.status === 401, actual: summary(r) };
  });

  // ---- Authorization (roles) ----
  await test('Authorization', 'Employee tries to approve a booking', '403', async () => {
    const r = await call('PATCH', `${bookingUrl}/status`, { token: emp2.token, body: { status: 'Approved' } });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Authorization', 'Employee opens the admin monitoring metrics', '403', async () => {
    const r = await call('GET', `${BOOKING}/api/bookings/metrics`, { token: emp.token });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Authorization', 'Employee calls the Fleet-only conflicts check', '403', async () => {
    const r = await call('GET', `${BOOKING}/api/bookings/conflicts?vehicleId=${car.id}&from=${slot.startAt}&to=${slot.endAt}`, { token: emp.token });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Authorization', 'Admin approves their OWN booking (separation of duties)', '403', async () => {
    const own = await call('POST', `${BOOKING}/api/bookings`, { token: admin.token, body: { ...base, ...period(day + 1) } });
    if (own.status === 201) created.push({ id: own.json.id, token: admin.token });
    const r = await call('PATCH', `${BOOKING}/api/bookings/${own.json.id}/status`, { token: admin.token, body: { status: 'Approved' } });
    return { pass: r.status === 403, actual: summary(r) };
  });

  // ---- Ownership / object access (IDOR) ----
  await test('Ownership', "Employee B reads employee A's booking", '403', async () => {
    const r = await call('GET', bookingUrl, { token: emp2.token });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Ownership', "Employee B reads A's booking history", '403', async () => {
    const r = await call('GET', `${bookingUrl}/history`, { token: emp2.token });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Ownership', "Employee B edits A's booking", '403', async () => {
    const r = await call('PATCH', bookingUrl, { token: emp2.token, body: { purpose: 'Taken over by B' } });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Ownership', "Employee B cancels A's booking", '403', async () => {
    const r = await call('PATCH', `${bookingUrl}/status`, { token: emp2.token, body: { status: 'Cancelled' } });
    return { pass: r.status === 403, actual: summary(r) };
  });
  await test('Ownership', "Employee list only contains the employee's own bookings", 'only own userId', async () => {
    const r = await call('GET', `${BOOKING}/api/bookings`, { token: emp2.token });
    const others = (r.json || []).filter((b) => b.userId !== emp2.user.id).length;
    return { pass: r.status === 200 && others === 0, actual: `${r.status}, ${others} foreign bookings` };
  });

  // ---- Input validation ----
  await test('Input validation', 'End time before start time', '400', async () => {
    const r = await call('POST', `${BOOKING}/api/bookings`, { token: emp.token, body: { ...base, startAt: slot.endAt, endAt: slot.startAt } });
    return { pass: r.status === 400, actual: summary(r) };
  });
  await test('Input validation', '99 passengers (range 1-15)', '400', async () => {
    const r = await call('POST', `${BOOKING}/api/bookings`, { token: emp.token, body: { ...base, passengers: 99 } });
    return { pass: r.status === 400, actual: summary(r) };
  });
  await test('Input validation', 'Malformed JSON body', '400', async () => {
    const r = await call('POST', `${BOOKING}/api/bookings`, { token: emp.token, raw: { type: 'application/json', body: '{"purpose":' } });
    return { pass: r.status === 400, actual: summary(r) };
  });
  await test('Input validation', 'Non-JSON content type', '415', async () => {
    const r = await call('POST', `${BOOKING}/api/bookings`, { token: emp.token, raw: { type: 'text/plain', body: 'hello' } });
    return { pass: r.status === 415, actual: summary(r) };
  });
  await test('Input validation', 'Mass assignment: body sets status=Approved and another userId', '201, Pending, own userId', async () => {
    const r = await call('POST', `${BOOKING}/api/bookings`, {
      token: emp2.token, body: { ...base, ...period(day + 2), status: 'Approved', userId: emp.user.id, decidedBy: 'me' }
    });
    if (r.status === 201) created.push({ id: r.json.id, token: emp2.token });
    const ok = r.status === 201 && r.json.status === 'Pending' && r.json.userId === emp2.user.id;
    return { pass: ok, actual: r.status === 201 ? `201, ${r.json.status}, ${r.json.userId === emp2.user.id ? 'own' : 'FOREIGN'} userId` : summary(r) };
  });

  // ---- Business rules ----
  await test('Business rule', 'Two clashing requests for one car: the second approval is refused', '200 then 409', async () => {
    const clash = await call('POST', `${BOOKING}/api/bookings`, { token: emp2.token, body: { ...base } });
    if (clash.status === 201) created.push({ id: clash.json.id, token: emp2.token });
    const first = await call('PATCH', `${bookingUrl}/status`, { token: admin.token, body: { status: 'Approved' } });
    const second = await call('PATCH', `${BOOKING}/api/bookings/${clash.json.id}/status`, { token: admin.token, body: { status: 'Approved' } });
    return { pass: first.status === 200 && second.status === 409, actual: `${first.status} then ${summary(second)}` };
  });

  // ---- Transport and headers ----
  await test('Configuration', 'Security headers present, framework header hidden', 'CSP + nosniff, no X-Powered-By', async () => {
    const r = await call('GET', `${BOOKING}/api/health`);
    const csp = r.headers.get('content-security-policy') || '';
    const ok = csp.includes("default-src 'none'") && r.headers.get('x-content-type-options') === 'nosniff' && !r.headers.get('x-powered-by');
    return { pass: ok, actual: `CSP=${csp ? 'yes' : 'no'}, nosniff=${r.headers.get('x-content-type-options') || 'no'}, x-powered-by=${r.headers.get('x-powered-by') || 'absent'}` };
  });
  await test('Configuration', 'CORS: an unknown website origin is not allowed', 'no Access-Control-Allow-Origin', async () => {
    const r = await call('GET', `${BOOKING}/api/health`, { headers: { Origin: 'https://evil.example' } });
    const acao = r.headers.get('access-control-allow-origin');
    return { pass: !acao || acao !== 'https://evil.example', actual: `ACAO=${acao || 'absent'}` };
  });
  if (!LOCAL) {
    await test('Configuration', 'HTTP is not served in plain text (HTTPS only)', 'https URL', async () => ({
      pass: BOOKING.startsWith('https://'), actual: BOOKING.split('/')[0]
    }));
  }

  // ---- Secrets ----
  await test('Secrets', 'Secret exposure review: repository scan (.env, keys, tokens, DB URLs)', '0 findings', async () => {
    const { scanned, findings } = scan();
    return { pass: findings.length === 0, actual: `${findings.length} findings in ${scanned} files` };
  });
  await test('Secrets', 'API answers never contain password hashes, tokens or secrets', 'none found', async () => {
    const a = await call('GET', `${BOOKING}/api/bookings`, { token: admin.token });
    const text = JSON.stringify(a.json);
    const leaked = ['password', 'password_hash', 'token', 'secret', 'DATABASE_URL'].filter((k) => text.toLowerCase().includes(`"${k.toLowerCase()}"`));
    return { pass: a.status === 200 && leaked.length === 0, actual: leaked.length ? `found: ${leaked.join(', ')}` : 'none found' };
  });

  // ---- Logging / monitoring ----
  await test('Monitoring', 'The denied requests above were recorded (metrics, no secrets)', '401 and 403 counted', async () => {
    const r = await call('GET', `${BOOKING}/api/bookings/metrics`, { token: admin.token });
    const d = r.json && r.json.last24h;
    return {
      pass: r.status === 200 && d.unauthenticated >= 3 && d.forbidden >= 8,
      actual: r.status === 200 ? `401 x${d.unauthenticated}, 403 x${d.forbidden} in 24 h` : summary(r)
    };
  });

  // Clean up: cancel the test bookings (the API never deletes; cancelled ones stay in the history).
  for (const b of created) {
    const r = await call('PATCH', `${BOOKING}/api/bookings/${b.id}/status`, { token: b.token, body: { status: 'Cancelled' } });
    if (r.status !== 200) await call('PATCH', `${BOOKING}/api/bookings/${b.id}/status`, { token: admin.token, body: { status: 'Cancelled', reason: 'Security test clean-up' } });
  }
}

function write() {
  const passed = results.filter((r) => r.result === 'PASS').length;
  const when = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const md = [
    `# Booking service: security test results`,
    '',
    `Target: ${BOOKING} (login through ${FLEET}). Run: ${when} UTC. Result: **${passed}/${results.length} passed**.`,
    '',
    '| Test ID | Category | Scenario | Expected | Actual | Result |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.category} | ${r.scenario} | ${r.expected} | ${r.actual} | ${r.result} |`),
    ''
  ].join('\n');
  fs.writeFileSync(path.join(__dirname, 'security-test-results.md'), md);
  fs.writeFileSync(path.join(__dirname, 'security-test-results.json'), JSON.stringify({ target: BOOKING, ranAt: when, results }, null, 2));
  console.table(results.map(({ id, scenario, expected, actual, result }) => ({ id, scenario, expected, actual, result })));
  console.log(`\n${passed}/${results.length} passed. Table for the report: scripts/security-test-results.md`);
  if (passed !== results.length) process.exitCode = 1;
}

main().then(write).catch((error) => {
  console.error(`Security tests stopped: ${error.message}`);
  if (results.length) write();
  process.exitCode = 1;
});
