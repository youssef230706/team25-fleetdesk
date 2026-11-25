// Local demo of the Booking API with an in-memory database: no Neon account needed.
//   npm run demo
// It needs the Fleet API running on http://localhost:3001 (log in there) and the
// SAME JWT_SECRET as the Fleet API. Easiest: use "npm run demo:all", which starts everything.

require('dotenv').config({ quiet: true });
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('JWT_SECRET is missing. It must be the same value as the Fleet API, or no login will work here.');
  console.error('Easiest: run  npm run demo:all  instead, which starts the Fleet API, this API and the website together.');
  process.exit(1);
}

const { createTestDb } = require('../tests/testDb');

async function main() {
  await createTestDb();
  const app = require('../server');
  const port = process.env.PORT || 3002;
  app.listen(port, (error) => {
    if (error) {
      console.error(error.code === 'EADDRINUSE' ? `Port ${port} is already in use: the Booking API is probably already running.` : error.message);
      process.exit(1);
    }
    console.log(`Booking demo API on http://localhost:${port} (in-memory database)`);
    console.log(`Asking the Fleet API at ${process.env.FLEET_API_URL || 'http://localhost:3001'} about cars.`);
    if (!process.env.ORS_API_KEY) console.log('ORS_API_KEY is not set: trip estimates are off, bookings still work.');
  });
}

main();
