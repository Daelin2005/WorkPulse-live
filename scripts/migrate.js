const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function migrate() {
  const sqlPath = path.join(__dirname, '../database.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error('database.sql file not found in root directory!');
  }
  
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('Running full database.sql schema migration...');
  await db.query(sql);
  console.log('Database migration completed successfully!');
}

module.exports = migrate;