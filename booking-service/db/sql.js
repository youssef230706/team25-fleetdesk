// Database access, in the same style as Lab 5 and fleet-service/db/sql.js.
//
// Every service file calls db`...` with ${values}. The Neon driver sends the
// values separately from the SQL text (a parameterised query), so user input
// can never change the query itself. This is our defence against SQL injection.
//
// Tests replace the Neon connection with an in-memory Postgres (see tests/testDb.js).

let sql = null;

function getSql() {
  if (sql) return sql;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set. Add it to booking-service/.env locally, or in Vercel: Settings > Environment Variables, then Redeploy.');
  }
  const { neon } = require('@neondatabase/serverless');
  sql = neon(databaseUrl);
  return sql;
}

function db(strings, ...values) {
  return getSql()(strings, ...values);
}

function setSqlForTests(fakeSql) {
  sql = fakeSql;
}

module.exports = { db, setSqlForTests };
