// In-memory Postgres for the tests (pg-mem), so the tests need no Neon account
// and no secrets. It runs the real db/schema.sql and the real SQL in the services.
// pg-mem cannot run the btree_gist exclusion constraint, so we stop at the "@neon-only" line.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { newDb, DataType } = require('pg-mem');
const { setSqlForTests } = require('../db/sql');

async function createTestDb() {
  const mem = newDb();
  mem.public.registerFunction({
    name: 'gen_random_uuid',
    returns: DataType.uuid,
    implementation: () => crypto.randomUUID(),
    impure: true
  });

  const full = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const schema = full.split('-- @neon-only')[0]
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  mem.public.none(schema);

  const { Pool } = mem.adapters.createPg();
  const pool = new Pool();

  // Same calling style as the Neon driver: sql`... ${value} ...` -> rows
  const sql = async (strings, ...values) => {
    let text = strings[0];
    values.forEach((_, i) => { text += `$${i + 1}${strings[i + 1]}`; });
    const result = await pool.query(text, values);
    return result.rows;
  };
  setSqlForTests(sql);
  return { sql, mem };
}

module.exports = { createTestDb };
