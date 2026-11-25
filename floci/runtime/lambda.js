// Floci / AWS Lambda entry point (added to each service only in the Floci build).
// Lambda setting: handler = lambda.handler
//
// 1. serverless-http turns the API Gateway event into an Express request and back (Lab 7).
// 2. On Lambda the body arrives as a ready Buffer, which Express 5's express.json() leaves
//    unparsed, so it is parsed here with the same rules (JSON only, 10 kb, 400 on bad JSON).
// 3. lambda-fetch lets "lambda://<function>" addresses work, so Fleet and Booking call each
//    other with a Lambda Invoke inside Floci instead of going out through API Gateway.

require('./lambda-fetch');
const express = require('express');
const serverless = require('serverless-http');
const app = require('./server');

const LIMIT = 10 * 1024;
const outer = express();
outer.disable('x-powered-by');
outer.set('trust proxy', 1);

outer.use((req, res, next) => {
  if (!Buffer.isBuffer(req.body)) return next();
  const raw = req.body;
  req.body = undefined;
  if (raw.length === 0 || !req.is('application/json')) return next();
  if (raw.length > LIMIT) {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'The request body is too large.' } });
  }
  try {
    req.body = JSON.parse(raw.toString('utf8'));
    req._body = true;   // tells express.json() the body is already parsed
    return next();
  } catch (error) {
    return res.status(400).json({ error: { code: 'INVALID_JSON', message: 'The request body is not valid JSON.' } });
  }
});
outer.use(app);

module.exports.handler = serverless(outer);
