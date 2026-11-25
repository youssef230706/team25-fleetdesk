// Shows the recent logs of one Lambda function (like "aws logs tail" in Lab 7).
//   npm run logs -- booking        npm run logs -- fleet
const { CloudWatchLogsClient, FilterLogEventsCommand } = require('@aws-sdk/client-cloudwatch-logs');

const which = process.argv[2] || 'booking';
const name = { booking: 'fleetdesk-booking-api', fleet: 'fleetdesk-fleet-api' }[which] || which;
const logs = new CloudWatchLogsClient({
  endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
});

logs.send(new FilterLogEventsCommand({ logGroupName: `/aws/lambda/${name}`, startTime: Date.now() - 30 * 60 * 1000, limit: 200 }))
  .then(({ events = [] }) => {
    if (events.length === 0) console.log(`No logs for ${name} in the last 30 minutes.`);
    events.forEach((e) => console.log(`${new Date(e.timestamp).toLocaleTimeString()}  ${e.message.trim()}`));
  })
  .catch((error) => console.error(`Could not read logs for ${name}: ${error.message}`));
