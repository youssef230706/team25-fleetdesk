// Lists everything deployed on Floci, without needing the AWS CLI.
//   npm run status
const { RDSClient, DescribeDBInstancesCommand } = require('@aws-sdk/client-rds');
const { LambdaClient, ListFunctionsCommand } = require('@aws-sdk/client-lambda');
const { ApiGatewayV2Client, GetApisCommand, GetRoutesCommand } = require('@aws-sdk/client-apigatewayv2');
const { S3Client, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { DynamoDBClient, ListTablesCommand, DescribeTableCommand } = require('@aws-sdk/client-dynamodb');
const { SNSClient, ListTopicsCommand, ListSubscriptionsByTopicCommand } = require('@aws-sdk/client-sns');
const { SQSClient, ListQueuesCommand, GetQueueAttributesCommand } = require('@aws-sdk/client-sqs');

const aws = {
  endpoint: process.env.FLOCI_URL || 'http://localhost:4566',
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' }
};

async function section(title, fn) {
  console.log(`\n== ${title}`);
  try {
    await fn();
  } catch (error) {
    console.log(`   could not read: ${error.name || error.message}`);
  }
}

async function main() {
  await section('RDS databases', async () => {
    const { DBInstances = [] } = await new RDSClient(aws).send(new DescribeDBInstancesCommand({}));
    console.table(DBInstances.map((d) => ({ name: d.DBInstanceIdentifier, engine: d.Engine, port: d.Endpoint && d.Endpoint.Port, status: d.DBInstanceStatus })));
  });
  await section('DynamoDB tables', async () => {
    const client = new DynamoDBClient(aws);
    const { TableNames = [] } = await client.send(new ListTablesCommand({}));
    const rows = [];
    for (const TableName of TableNames) {
      const { Table } = await client.send(new DescribeTableCommand({ TableName }));
      rows.push({ name: TableName, status: Table.TableStatus, items: Table.ItemCount, indexes: (Table.GlobalSecondaryIndexes || []).map((i) => i.IndexName).join(', ') });
    }
    if (rows.length) console.table(rows); else console.log('   none');
  });
  await section('Event bus (SNS topics -> SQS queues)', async () => {
    const sns = new SNSClient(aws);
    const sqs = new SQSClient(aws);
    const { Topics = [] } = await sns.send(new ListTopicsCommand({}));
    for (const { TopicArn } of Topics) {
      const { Subscriptions = [] } = await sns.send(new ListSubscriptionsByTopicCommand({ TopicArn }));
      console.log(`   SNS ${TopicArn.split(':').pop()}  ->  ${Subscriptions.map((s) => `${s.Protocol} ${s.Endpoint.split(':').pop()}`).join(', ') || 'no subscribers'}`);
    }
    const { QueueUrls = [] } = await sqs.send(new ListQueuesCommand({}));
    for (const QueueUrl of QueueUrls) {
      const { Attributes = {} } = await sqs.send(new GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['ApproximateNumberOfMessages'] }));
      console.log(`   SQS ${QueueUrl.split('/').pop()}: ${Attributes.ApproximateNumberOfMessages || 0} message(s) waiting`);
    }
  });
  await section('Lambda functions', async () => {
    const { Functions = [] } = await new LambdaClient(aws).send(new ListFunctionsCommand({}));
    console.table(Functions.map((f) => ({ name: f.FunctionName, runtime: f.Runtime, handler: f.Handler, memoryMB: f.MemorySize, timeoutS: f.Timeout })));
  });
  await section('API Gateway (HTTP APIs)', async () => {
    const client = new ApiGatewayV2Client(aws);
    const { Items = [] } = await client.send(new GetApisCommand({}));
    for (const api of Items) {
      const routes = (await client.send(new GetRoutesCommand({ ApiId: api.ApiId }))).Items || [];
      console.log(`   ${api.Name}  ->  http://${api.ApiId}.execute-api.localhost.floci.io:4566   (${routes.length} routes)`);
    }
  });
  await section('S3 website bucket fleetdesk-site', async () => {
    const { Contents = [] } = await new S3Client({ ...aws, forcePathStyle: true }).send(new ListObjectsV2Command({ Bucket: 'fleetdesk-site' }));
    console.log(`   ${Contents.length} files, e.g. ${Contents.slice(0, 5).map((c) => c.Key).join(', ')}`);
    console.log(`   open: ${aws.endpoint}/fleetdesk-site/index.html`);
  });
}

main();
