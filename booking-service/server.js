// FleetDesk - Booking service (Youssef).
// Deployed on its own as a Vercel project (root directory: booking-service).
// Same layout as Lab 4/5 and fleet-service: server.js -> routes -> controllers -> services.

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');

const bookingRoutes = require('./routes/bookings');
const { requestLogger } = require('./middleware/logger');
const requireJson = require('./middleware/requireJson');
const { apiLimiter } = require('./middleware/rateLimits');
const { notFoundRoute, errorHandler } = require('./middleware/errorHandler');

const app = express();
const PORT = process.env.PORT || 3002;

// Vercel sits in front of the app as a proxy; this makes req.ip the real client IP.
app.set('trust proxy', 1);
app.disable('x-powered-by');

// Security headers for API responses. The API only returns JSON, so nothing may load.
app.use(helmet({
  contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }
}));

// CORS allow-list from .env, exactly as in Lab 5 (never "*").
const allowedOrigins = (process.env.CORS_ORIGINS || 'http://localhost:8080')
  .split(',')
  .map((origin) => origin.trim());
app.use(cors({
  origin: allowedOrigins,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(requestLogger);
app.use(express.json({ limit: '10kb' }));

// Friendly root route and health check (no database needed).
app.get('/', (req, res) => {
  res.status(200).json({
    name: 'FleetDesk Booking API',
    endpoints: ['/api/health', '/api/bookings', '/api/bookings/availability', '/api/bookings/estimate', '/api/bookings/conflicts']
  });
});
app.get('/api/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'booking', environment: process.env.NODE_ENV || 'development' });
});

app.use('/api', apiLimiter, requireJson);
app.use('/api/bookings', bookingRoutes);

app.use(notFoundRoute);
app.use(errorHandler);

if (require.main === module) {
  app.listen(PORT, (error) => {
    if (error) {
      console.error(error.code === 'EADDRINUSE'
        ? `Port ${PORT} is already in use: the Booking API is probably already running in another terminal.`
        : error.message);
      process.exit(1);
    }
    console.log(`Booking API running on http://localhost:${PORT}`);
  });
}

// Vercel detects an Express app through app.listen() or an exported app (Lab 5).
module.exports = app;
