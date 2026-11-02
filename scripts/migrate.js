const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function migrate() {
  const sqlPath = path.join(__dirname, '../database.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error('database.sql file not found in root directory!');
  }
  
  let sql = fs.readFileSync(sqlPath, 'utf8');
  
  // Make function creations safe so re-running never fails
  sql = sql.replace(/CREATE FUNCTION/g, 'CREATE OR REPLACE FUNCTION');
  
  // Make table creations safe so they don't error out if they already exist
  sql = sql.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ');

  console.log('Running safe, idempotent database migration...');
  await db.query(sql);
  console.log('Database migration completed successfully!');
}

module.exports = migrate;