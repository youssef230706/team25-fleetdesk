// Delivers booking events to the other services.
//
//   Vercel (real site): signed webhooks. Each URL in EVENT_WEBHOOK_URLS receives a POST with JSON and
//     X-FleetDesk-Event:      booking.approved
//     X-FleetDesk-Signature:  t=<unix seconds>,v1=<HMAC-SHA256 of "<t>.<body>" with WEBHOOK_SECRET, hex>
//   The receiver recomputes the HMAC with the shared secret, compares it, and rejects requests older
//   than 5 minutes (stops forged and replayed events).
//
//   Floci copy: Amazon SNS. When EVENTS_SNS_TOPIC_ARN is set, events are also published to that topic,
//   and SNS fans them out (for example to the Trip service's SQS queue).
//
// Delivery never blocks a booking: it has a 3-second timeout, and the result is saved on the event
// ("sent" or "failed") so failures show up in the monitoring panel.

const crypto = require('crypto');

function webhookUrls() {
  return (process.env.EVENT_WEBHOOK_URLS || '').split(',').map((u) => u.trim()).filter(Boolean);
}

function sign(body, secret, timestamp = Math.floor(Date.now() / 1000)) {
  const v1 = crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

// For receivers (and the tests): true only for a correct, recent signature.
function verify(body, header, secret, maxAgeSeconds = 300) {
  const parts = Object.fromEntries(String(header || '').split(',').map((p) => p.split('=')));
  const t = Number(parts.t);
  if (!t || !parts.v1 || Math.abs(Date.now() / 1000 - t) > maxAgeSeconds) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
  return expected.length === parts.v1.length && crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
}

let sns = null;
function snsClient() {
  if (sns) return sns;
  const { SNSClient } = require('@aws-sdk/client-sns');   // only installed in the Floci build
  const endpoint = process.env.FLOCI_ENDPOINT;
  sns = new SNSClient({
    region: process.env.AWS_REGION || 'us-east-1',
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {})
  });
  return sns;
}

async function publishToSns(topicArn, message, type) {
  const { PublishCommand } = require('@aws-sdk/client-sns');
  await snsClient().send(new PublishCommand({
    TopicArn: topicArn,
    Message: message,
    MessageAttributes: { eventType: { DataType: 'String', StringValue: type } }
  }), { abortSignal: AbortSignal.timeout(3000) });
}

// Returns 'none' (nobody to tell), 'sent' (every target accepted it) or 'failed'.
async function publish(payload) {
  const urls = webhookUrls();
  const topic = process.env.EVENTS_SNS_TOPIC_ARN;
  const secret = process.env.WEBHOOK_SECRET;
  if (urls.length === 0 && !topic) return 'none';

  const body = JSON.stringify(payload);
  const jobs = [];
  if (urls.length > 0) {
    if (!secret || secret.length < 32) {
      console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'event_not_sent', reason: 'WEBHOOK_SECRET missing or shorter than 32 characters' }));
      jobs.push(Promise.reject(new Error('WEBHOOK_SECRET not set')));
    } else {
      for (const url of urls) {
        jobs.push(fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-FleetDesk-Event': payload.type, 'X-FleetDesk-Signature': sign(body, secret) },
          body,
          signal: AbortSignal.timeout(3000)
        }).then((response) => { if (!response.ok) throw new Error(`webhook answered ${response.status}`); }));
      }
    }
  }
  if (topic) jobs.push(publishToSns(topic, body, payload.type));

  const results = await Promise.allSettled(jobs);
  const failed = results.filter((r) => r.status === 'rejected');
  failed.forEach((r) => console.warn(JSON.stringify({ time: new Date().toISOString(), type: 'event_delivery_failed', event: payload.type, message: r.reason.message })));
  return failed.length ? 'failed' : 'sent';
}

module.exports = { publish, sign, verify, publishToSns };
