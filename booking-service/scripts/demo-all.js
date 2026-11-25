// Starts the whole site on your PC with in-memory databases, in ONE terminal:
//   Fleet API (Kareem)  http://localhost:3001   (from ../fleet-service, run its npm install once)
//   Booking API (you)   http://localhost:3002
//   Website             http://localhost:8080   (the ../frontend folder)
//   npm run demo:all    then open http://localhost:8080   (Ctrl+C stops everything)
//
// One random JWT_SECRET is made here and given to both APIs, so the Fleet login works for Booking.

require('dotenv').config({ quiet: true });
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..', '..');
const fleetDir = path.join(root, 'fleet-service');
const frontendDir = path.join(root, 'frontend');

if (!fs.existsSync(path.join(fleetDir, 'node_modules'))) {
  console.error('Kareem\'s fleet-service has no node_modules yet. Run this once:  cd ../fleet-service ; npm install');
  process.exit(1);
}

const shared = {
  ...process.env,
  NODE_ENV: 'development',
  JWT_SECRET: crypto.randomBytes(48).toString('base64url'),
  CORS_ORIGINS: 'http://localhost:8080,http://127.0.0.1:8080'
};

function start(name, cwd, script, extraEnv) {
  const child = spawn(process.execPath, [script], { cwd, env: { ...shared, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'] });
  const print = (stream, out) => stream.on('data', (data) => {
    data.toString().split('\n').filter(Boolean).forEach((line) => out.write(`[${name}] ${line}\n`));
  });
  print(child.stdout, process.stdout);
  print(child.stderr, process.stderr);
  child.on('exit', (code) => { if (code) console.error(`[${name}] stopped (exit ${code})`); });
  return child;
}

const children = [
  start('fleet', fleetDir, 'scripts/demo.js', { PORT: '3001', BOOKING_API_URL: 'http://localhost:3002' }),
  start('booking', path.join(__dirname, '..'), 'scripts/demo.js', { PORT: '3002', FLEET_API_URL: 'http://localhost:3001' })
];

// Tiny static file server for the website (no extra packages, no caching, so edits show at once).
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };
http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(frontendDir, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(frontendDir + path.sep) && file !== frontendDir || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, () => console.log('[site] Website on http://localhost:8080  (Ctrl+C stops everything)'))
  .on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? '[site] Port 8080 is busy: close the other http-server first.' : error.message);
    process.exit(1);
  });

const stopAll = () => { children.forEach((child) => child.kill()); process.exit(0); };
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
