const express = require('express');
const bookings = require('../controllers/bookings');
const { requireAuth } = require('../middleware/auth');
const requireRole = require('../middleware/requireRole');
const { estimateLimiter } = require('../middleware/rateLimits');

const router = express.Router();

// Every route needs a valid login token (issued by the Fleet service's /api/auth/login).
router.use(requireAuth);

// Fixed paths first, so "availability" is never read as a booking id.
router.get('/availability', bookings.availability);                            // Employee, FleetAdmin
router.get('/estimate', estimateLimiter, bookings.estimate);                    // Employee, FleetAdmin
router.get('/conflicts', requireRole('FleetAdmin'), bookings.conflicts);        // Fleet service (admin token)
router.get('/metrics', requireRole('FleetAdmin'), bookings.metrics);            // monitoring panel
router.get('/events', requireRole('FleetAdmin'), bookings.eventFeed);           // event feed for other services

router.post('/', bookings.createBooking);                                       // Employee, FleetAdmin
router.get('/', bookings.listBookings);                                         // own (Employee), all (FleetAdmin)
router.get('/:id', bookings.getBooking);                                        // owner or FleetAdmin, else 403
router.get('/:id/history', bookings.bookingHistory);                            // owner or FleetAdmin (audit trail)
router.patch('/:id', bookings.updateBooking);                                   // owner, while Pending
router.patch('/:id/status', bookings.changeStatus);                             // rules in services/bookingService.js

module.exports = router;
