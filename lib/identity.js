const { E, v } = require('./util');

function employeeUsername(value, email) {
  const generated = email.split('@')[0].replace(/[^a-z0-9._-]/gi, '-').replace(/^[^a-z0-9]+/i, '').slice(0, 32) || 'user';
  const source = value === undefined ? generated : value;
  const username = v.str(source, 'Username', { max: 32 }).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(username)) {
    throw E.bad('Use 1–32 characters for the username: letters, numbers, dots, underscores or hyphens.');
  }
  return username;
}

module.exports = { employeeUsername };
