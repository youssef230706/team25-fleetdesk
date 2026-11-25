// Serves the built website (build/frontend, made by "npm run deploy") on http://localhost:8080.
// Use it if the S3 address does not open the site in your browser. The pages still call the APIs on Floci.
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, 'build', 'frontend');
if (!fs.existsSync(root)) {
  console.error('Run "npm run deploy" first: it builds the website with the Floci API addresses.');
  process.exit(1);
}
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json' };

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(root, urlPath === '/' ? 'index.html' : urlPath));
  if ((!file.startsWith(root + path.sep) && file !== root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}).listen(8080, () => console.log('Website on http://localhost:8080  (Ctrl+C to stop)'))
  .on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? 'Port 8080 is busy: stop "npm run demo:all" or the other server first.' : error.message);
    process.exit(1);
  });
