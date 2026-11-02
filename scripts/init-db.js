require('dotenv').config();

const fs = require('fs');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is missing. Copy .env.example to .env and configure your PostgreSQL connection.');
  process.exit(1);
}

const db = require('../lib/db');

async function initialize() {
  try {
    const existing = await db.query("SELECT to_regclass('public.companies') AS schema");
    if (existing.rows[0].schema) {
      console.log('Database schema already exists; skipping initialization.');
      return;
    }

    const schema = fs.readFileSync(path.join(__dirname, '..', 'database.sql'), 'utf8');
    await db.pool.query(schema);
    console.log('Database schema initialized.');
  } finally {
    await db.pool.end();
  }
}

initialize().catch(error => {
  console.error('Could not initialize the database schema.', error);
  process.exitCode = 1;
});
