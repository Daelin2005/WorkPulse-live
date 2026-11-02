const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function migrate() {
  const sqlPath = path.join(__dirname, '../database.sql');
  const sql = fs.readFileSync(sqlPath, 'utf8');
  
  console.log('Running clean database.sql migration...');
  await db.query(sql);
  console.log('Database migration completed successfully!');
}

module.exports = migrate;