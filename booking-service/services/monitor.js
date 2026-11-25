// Monitoring: security-relevant events, the admin metrics, and alerts.
//
// Recorded events (no tokens, passwords or request bodies are ever stored):
//   security.unauthenticated  401: no token, bad token, expired token
//   security.forbidden        403: wrong role, someone else's booking, approving your own booking
//   security.rate_limited     429
//   fleet.unavailable         503: the Fleet service could not be reached (fail closed)
//
// Alert rules (checked after each security event, at most one alert per rule every 15 minutes):
//   denied   401 + 403 >= ALERT_DENIED_THRESHOLD (default 10) in 15 minutes  -> possible attack or broken client
//   fleet    503 from Fleet >= ALERT_FLEET_THRESHOLD (default 3) in 15 minutes -> Fleet is down

const eventStore = require('./eventStore');
const { sendAlert } = require('../clients/alertClient');

const WINDOW_MINUTES = 15;
const SECURITY_TYPES = ['security.unauthenticated', 'security.forbidden', 'security.rate_limited', 'fleet.unavailable'];

function rules() {
  return [
    {
      name: 'denied',
      title: 'many denied requests (401/403)',
      types: ['security.unauthenticated', 'security.forbidden'],
      threshold: Number(process.env.ALERT_DENIED_THRESHOLD) || 10
    },
    {
      name: 'fleet',
      title: 'the Fleet service keeps failing (503)',
      types: ['fleet.unavailable'],
      threshold: Number(process.env.ALERT_FLEET_THRESHOLD) || 3
    }
  ];
}

const since = (minutes) => new Date(Date.now() - minutes * 60 * 1000);

async function checkAlerts() {
  const counts = await eventStore.countSince(since(WINDOW_MINUTES));
  const recentAlerts = await eventStore.recent({ types: ['alert.sent'], since: since(WINDOW_MINUTES), limit: 20 });
  for (const rule of rules()) {
    const count = rule.types.reduce((sum, t) => sum + (counts[t] || 0), 0);
    if (count < rule.threshold) continue;
    if (recentAlerts.some((a) => a.details.rule === rule.name)) continue;   // cooldown
    const alert = { rule: rule.name, title: rule.title, count, threshold: rule.threshold, windowMinutes: WINDOW_MINUTES };
    const delivered = await sendAlert(alert);
    await eventStore.add({ type: 'alert.sent', details: { ...alert, delivered }, at: new Date() });
    if (process.env.NODE_ENV !== 'test') {
      console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'alert', ...alert, delivered }));
    }
  }
}

// Called by the error handler and the rate limiter. Never throws.
async function recordSecurity(type, req, extra = {}) {
  try {
    await eventStore.add({
      type,
      actorId: req.user ? req.user.id : null,
      actorRole: req.user ? req.user.role : null,
      details: { method: req.method, path: req.originalUrl.split('?')[0].slice(0, 120), ...extra },
      at: new Date()
    });
    await checkAlerts();
  } catch (error) {
    if (process.env.NODE_ENV !== 'test') {
      console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'monitor_failed', message: error.message }));
    }
  }
}

// GET /api/bookings/metrics (FleetAdmin)
async function metrics(bookingCounts) {
  const day = await eventStore.countSince(since(24 * 60));
  const window = await eventStore.countSince(since(WINDOW_MINUTES));
  const recentSecurity = await eventStore.recent({ types: SECURITY_TYPES, since: since(24 * 60), limit: 15 });
  const lastAlerts = await eventStore.recent({ types: ['alert.sent'], limit: 5 });
  const deliveryFailures = await eventStore.countDeliveryFailuresSince(since(24 * 60));
  return {
    generatedAt: new Date().toISOString(),
    bookingsByStatus: bookingCounts,
    last24h: {
      created: day['booking.created'] || 0,
      approved: day['booking.approved'] || 0,
      rejected: day['booking.rejected'] || 0,
      cancelled: day['booking.cancelled'] || 0,
      completed: day['booking.completed'] || 0,
      unauthenticated: day['security.unauthenticated'] || 0,
      forbidden: day['security.forbidden'] || 0,
      rateLimited: day['security.rate_limited'] || 0,
      fleetUnavailable: day['fleet.unavailable'] || 0,
      eventDeliveryFailures: deliveryFailures
    },
    alerting: {
      windowMinutes: WINDOW_MINUTES,
      rules: rules().map((r) => ({
        name: r.name, title: r.title, threshold: r.threshold,
        current: r.types.reduce((sum, t) => sum + (window[t] || 0), 0)
      })),
      channels: {
        webhook: Boolean(process.env.ALERT_WEBHOOK_URL),
        sns: Boolean(process.env.ALERTS_SNS_TOPIC_ARN)
      },
      recentAlerts: lastAlerts.map((a) => ({ at: a.at, rule: a.details.rule, count: a.details.count, delivered: a.details.delivered }))
    },
    recentSecurityEvents: recentSecurity.map((e) => ({
      at: e.at, type: e.type, actorRole: e.actorRole, method: e.details.method, path: e.details.path
    }))
  };
}

module.exports = { recordSecurity, checkAlerts, metrics, SECURITY_TYPES };
