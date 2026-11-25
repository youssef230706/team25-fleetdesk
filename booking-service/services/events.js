// Records every booking change in the audit trail and tells the other services about it.
// Called by the controllers after a change has been saved.

const eventStore = require('./eventStore');
const eventPublisher = require('../clients/eventPublisher');

// Only these are sent to other services; security events stay internal.
const SHARED = ['booking.created', 'booking.updated', 'booking.approved', 'booking.rejected', 'booking.cancelled', 'booking.completed'];

function log(type, extra) {
  if (process.env.NODE_ENV === 'test') return;
  console.log(JSON.stringify({ time: new Date().toISOString(), type, ...extra }));
}

// The payload other services receive: enough to act on, no reasons or free text.
function payloadFor(event, booking) {
  return {
    id: event.id,
    type: event.type,
    at: event.at,
    actor: { id: event.actorId, role: event.actorRole },
    booking: booking && {
      id: booking.id,
      userId: booking.userId,
      vehicleId: booking.vehicleId,
      status: booking.status,
      startAt: booking.startAt,
      endAt: booking.endAt,
      estimate: booking.estimate,
      actualKm: booking.actualKm
    }
  };
}

// A failure here never undoes the booking change: it is logged and shows up in monitoring.
async function bookingChanged(type, booking, user, fromStatus = null, details = {}) {
  try {
    const event = await eventStore.add({
      type,
      bookingId: booking.id,
      actorId: user.id,
      actorRole: user.role,
      fromStatus,
      toStatus: booking.status,
      details,
      at: new Date()
    });
    log('booking_event', { event: type, bookingId: booking.id, from: fromStatus, to: booking.status });
    if (SHARED.includes(type)) {
      const delivery = await eventPublisher.publish(payloadFor(event, booking));
      if (delivery !== 'none') await eventStore.setDelivery(event.id, delivery);
    }
    return event;
  } catch (error) {
    log('booking_event_failed', { event: type, bookingId: booking.id, message: error.message });
    return null;
  }
}

module.exports = { bookingChanged, payloadFor, SHARED };
