const { Pool, types } = require('pg');

// Return DATE columns as plain 'YYYY-MM-DD' text so dates never shift with the server's time zone.
types.setTypeParser(1082, s => s);

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 10 });

// db.query(...) for single statements, db.tx(async c => { c.query(...) }) for anything that must succeed or fail together
const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const out = await fn(c);
    await c.query('COMMIT');
    return out;
  } catch (e) {
    try { await c.query('ROLLBACK'); } catch (_) { /* connection already gone */ }
    throw e;
  } finally {
    c.release();
  }
}

module.exports = { pool, query, tx };
