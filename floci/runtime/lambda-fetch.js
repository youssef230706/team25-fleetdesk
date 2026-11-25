// Makes fetch('lambda://<function-name>/path?query') call another Lambda function directly
// (AWS Lambda Invoke with an API Gateway v2 event), and return a normal fetch Response.
// Every other address goes to the real fetch unchanged.
//
// Why: inside Floci, a Lambda container cannot reach the *.execute-api.localhost.floci.io
// addresses (they point back to itself), but it can reach Floci's Lambda API at FLOCI_ENDPOINT.
// The calling service's code does not change: only its *_API_URL setting becomes lambda://...

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');

const realFetch = globalThis.fetch;
let client = null;

function lambdaClient() {
  if (client) return client;
  const endpoint = process.env.FLOCI_ENDPOINT;
  client = new LambdaClient({
    region: process.env.AWS_REGION || 'us-east-1',
    ...(endpoint ? { endpoint, credentials: { accessKeyId: 'test', secretAccessKey: 'test' } } : {})
  });
  return client;
}

function headersObject(headers) {
  const out = {};
  new Headers(headers || {}).forEach((value, key) => { out[key] = value; });
  return out;
}

async function invokeFetch(url, init = {}) {
  const method = (init.method || 'GET').toUpperCase();
  const event = {
    version: '2.0',
    routeKey: '$default',
    rawPath: url.pathname,
    rawQueryString: url.search.replace(/^\?/, ''),
    headers: { host: url.host, 'x-forwarded-proto': 'https', ...headersObject(init.headers) },
    requestContext: {
      stage: '$default',
      requestId: `invoke-${Date.now()}`,
      http: { method, path: url.pathname, protocol: 'HTTP/1.1', sourceIp: '10.0.0.1', userAgent: 'lambda-invoke' }
    },
    body: typeof init.body === 'string' ? init.body : undefined,
    isBase64Encoded: false
  };

  const result = await lambdaClient().send(
    new InvokeCommand({ FunctionName: url.host, Payload: Buffer.from(JSON.stringify(event)) }),
    { abortSignal: init.signal }
  );
  if (result.FunctionError) throw new Error(`Lambda ${url.host} failed: ${result.FunctionError}`);

  const answer = JSON.parse(Buffer.from(result.Payload).toString('utf8') || '{}');
  const body = answer.isBase64Encoded ? Buffer.from(answer.body || '', 'base64') : (answer.body || '');
  return new Response(body, { status: answer.statusCode || 200, headers: answer.headers || {} });
}

globalThis.fetch = (input, init) => {
  const href = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (href && href.startsWith('lambda://')) return invokeFetch(new URL(href), init);
  return realFetch(input, init);
};

module.exports = { invokeFetch };
