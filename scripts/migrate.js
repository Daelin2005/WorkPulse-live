const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function migrate() {
  const sqlPath = path.join(__dirname, '../database.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error('database.sql file not found in root directory!');
  }
  
  let sql = fs.readFileSync(sqlPath, 'utf8');
  
  // Make all function creations safe for re-running
  sql = sql.replace(/CREATE FUNCTION/g, 'CREATE OR REPLACE FUNCTION');
  
  console.log('Running safe database.sql schema migration...');
  await db.query(sql);
  console.log('Database migration completed successfully!');
}

module.exports = migrate;