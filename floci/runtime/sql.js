// Database access for the Floci build (replaces db/sql.js only in the build copy).
// Same db`... ${value} ...` tag as before, so every service file runs unchanged:
//   - a Neon address (*.neon.tech) -> the Neon driver, exactly like on Vercel
//   - any other Postgres address   -> the standard "pg" driver (Floci RDS)
// Values are always sent separately from the SQL text (parameterised queries).

let sql = null;

function pgSql(databaseUrl) {
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: databaseUrl, max: 3, idleTimeoutMillis: 10000, connectionTimeoutMillis: 5000 });
  return async (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    const result = await pool.query(text, values);
    return result.rows;
  };
}

function getSql() {
  if (sql) return sql;
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is not set.');
  if (/\.neon\.tech/i.test(databaseUrl)) {
    const { neon } = require('@neondatabase/serverless');
    sql = neon(databaseUrl);
  } else {
    sql = pgSql(databaseUrl);
  }
  return sql;
}

function db(strings, ...values) {
  return getSql()(strings, ...values);
}

function setSqlForTests(fakeSql) {
  sql = fakeSql;
}

module.exports = { db, setSqlForTests };
