// Shows the messages waiting in the SQS queues (what SNS delivered):
//   trip-booking-events     booking events for the Trip service (approved, cancelled, ...)
//   fleetdesk-alerts-inbox  monitoring alerts
//   npm run events            look without removing them
//   npm run events -- --clear  read and remove them (like a consumer would)
const { SQSClient, GetQueueUrlCommand, ReceiveMessageCommand, DeleteMessageCommand } = require('@aws-sdk/client-sqs');

const sqs = new SQSClient({
  endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
});
const clear = process.argv.includes('--clear');

async function show(queueName, describe) {
  console.log(`\n== SQS ${queueName}`);
  let QueueUrl;
  try {
    ({ QueueUrl } = await sqs.send(new GetQueueUrlCommand({ QueueName: queueName })));
  } catch (error) {
    console.log('   not found: run "npm run deploy" first');
    return;
  }
  const seen = new Set();
  const rows = [];
  for (let round = 0; round < 10; round += 1) {
    const { Messages = [] } = await sqs.send(new ReceiveMessageCommand({
      QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 0, VisibilityTimeout: clear ? 30 : 2
    }));
    const fresh = Messages.filter((m) => !seen.has(m.MessageId));
    if (fresh.length === 0) break;
    for (const m of fresh) {
      seen.add(m.MessageId);
      let body;
      try { body = JSON.parse(m.Body); } catch (error) { body = { raw: m.Body }; }
      if (body.Message) { try { body = JSON.parse(body.Message); } catch (error) { /* not wrapped */ } }
      rows.push(describe(body));
      if (clear) await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: m.ReceiptHandle }));
    }
  }
  if (rows.length === 0) console.log('   empty');
  else console.table(rows);
  if (clear && rows.length) console.log(`   ${rows.length} message(s) removed.`);
}

(async () => {
  await show('trip-booking-events', (e) => ({
    event: e.type, at: (e.at || '').slice(0, 16).replace('T', ' '),
    booking: e.booking ? e.booking.id.slice(0, 8) : '', status: e.booking && e.booking.status,
    car: e.booking && e.booking.vehicleId ? e.booking.vehicleId.slice(0, 8) : '', by: e.actor && e.actor.role,
    estimateKm: e.booking && e.booking.estimate ? e.booking.estimate.distanceKm : null
  }));
  await show('fleetdesk-alerts-inbox', (a) => ({ rule: a.rule, title: a.title, count: a.count, threshold: a.threshold, minutes: a.windowMinutes }));
  if (!clear) console.log('\n(Messages stay in the queues. Add -- --clear to remove them.)');
})().catch((error) => {
  console.error(`Could not read the queues: ${error.message}. Is Floci running?`);
  process.exit(1);
});
