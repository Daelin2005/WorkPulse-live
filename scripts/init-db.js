require('dotenv').config();

const { spawn } = require('child_process');
const path = require('path');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is missing. Copy .env.example to .env and configure your PostgreSQL connection.');
  process.exit(1);
}

const schema = path.join(__dirname, '..', 'database.sql');
const psql = spawn('psql', ['--dbname', databaseUrl, '--set', 'ON_ERROR_STOP=1', '--file', schema], {
  stdio: 'inherit'
});

psql.on('error', error => {
  console.error(`Could not start psql: ${error.message}`);
  process.exitCode = 1;
});

psql.on('exit', (code, signal) => {
  if (signal) {
    console.error(`psql was stopped by signal ${signal}.`);
    process.exitCode = 1;
  } else {
    process.exitCode = code || 0;
  }
});
