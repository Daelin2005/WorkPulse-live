const fs = require('fs');
const path = require('path');
const db = require('../lib/db');

async function migrate() {
  const sqlPath = path.join(__dirname, '../database.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error('database.sql file not found in root directory!');
  }
  
  let sql = fs.readFileSync(sqlPath, 'utf8');
  
  // 1. Make functions safe
  sql = sql.replace(/CREATE FUNCTION/g, 'CREATE OR REPLACE FUNCTION');
  
  // 2. Make tables safe
  sql = sql.replace(/CREATE TABLE /g, 'CREATE TABLE IF NOT EXISTS ');
  
  // 3. Make triggers safe by dropping them before creating, or using IF NOT EXISTS syntax where applicable
  // We can convert standard CREATE TRIGGER statements to drop-if-exists + create to make it 100% idempotent
  sql = sql.replace(/CREATE TRIGGER (\w+)(.*?)(ON \w+)/gis, 'DROP TRIGGER IF EXISTS $1 $3;\nCREATE TRIGGER $1 $2 $3');

  console.log('Running fully idempotent database migration...');
  await db.query(sql);
  console.log('Database migration completed successfully!');
}

module.exports = migrate;