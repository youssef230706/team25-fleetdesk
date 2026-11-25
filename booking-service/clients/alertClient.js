// Sends monitoring alerts to people.
//   ALERT_WEBHOOK_URL    a Discord, Slack or Microsoft Teams incoming-webhook address (a secret: env only)
//   ALERTS_SNS_TOPIC_ARN Floci copy: an SNS topic for alerts
// The message holds counts and the rule name only: never tokens, passwords or personal data.

const { publishToSns } = require('./eventPublisher');

async function sendAlert(alert) {
  const text = `FleetDesk Booking alert: ${alert.title}. ${alert.count} in the last ${alert.windowMinutes} minutes `
    + `(threshold ${alert.threshold}). Check the monitoring panel and the logs.`;
  const targets = [];
  if (process.env.ALERT_WEBHOOK_URL) {
    targets.push(fetch(process.env.ALERT_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // "content" is what Discord reads; "text" is what Slack and Teams read.
      body: JSON.stringify({ content: text, text }),
      signal: AbortSignal.timeout(3000)
    }).then((response) => { if (!response.ok) throw new Error(`alert webhook answered ${response.status}`); }));
  }
  if (process.env.ALERTS_SNS_TOPIC_ARN) {
    targets.push(publishToSns(process.env.ALERTS_SNS_TOPIC_ARN, JSON.stringify({ ...alert, text }), 'alert'));
  }
  if (targets.length === 0) return 'none';
  const results = await Promise.allSettled(targets);
  return results.some((r) => r.status === 'rejected') ? 'failed' : 'sent';
}

module.exports = { sendAlert };
