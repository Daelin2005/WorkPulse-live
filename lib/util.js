const crypto = require('crypto');

class HttpError extends Error {
  constructor(status, message, code) { super(message); this.status = status; this.code = code; }
}
const E = {
  bad: (m, c = 'BAD_REQUEST') => new HttpError(400, m, c),
  unauth: (m = 'Sign in to continue.') => new HttpError(401, m, 'UNAUTHENTICATED'),
  forbidden: (m = 'You do not have access to this.') => new HttpError(403, m, 'FORBIDDEN'),
  notFound: (m = 'Not found.') => new HttpError(404, m, 'NOT_FOUND'),
  conflict: (m, c = 'CONFLICT') => new HttpError(409, m, c)
};

// lets route handlers be async without try/catch in every one
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const v = {
  str(x, name, { min = 1, max = 300, optional = false } = {}) {
    if (x == null || x === '') { if (optional) return ''; throw E.bad(`${name} is required.`); }
    if (typeof x !== 'string') throw E.bad(`${name} must be text.`);
    const s = x.trim();
    if (s.length < min) throw E.bad(`${name} is required.`);
    if (s.length > max) throw E.bad(`${name} is too long.`);
    return s;
  },
  int(x, name, { min = 0, max = 1000000 } = {}) {
    const n = Number(x);
    if (!Number.isInteger(n) || n < min || n > max) throw E.bad(`${name} must be a whole number from ${min} to ${max}.`);
    return n;
  },
  oneOf(x, list, name) {
    if (!list.includes(x)) throw E.bad(`${name} must be one of: ${list.join(', ')}.`);
    return x;
  },
  uuid(x, name) {
    if (typeof x !== 'string' || !UUID.test(x)) throw E.bad(`${name} is not valid.`);
    return x;
  },
  date(x, name) {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || isNaN(Date.parse(x + 'T12:00:00Z'))) throw E.bad(`${name} must be a date like 2026-11-02.`);
    return x;
  },
  time(x, name) {
    if (typeof x !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(x)) throw E.bad(`${name} must be a time like 08:30.`);
    return x;
  },
  bool: x => x === true || x === 'true',
  email(x) {
    const s = v.str(x, 'Email', { max: 254 }).toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(s)) throw E.bad('Enter a valid email address.');
    return s;
  },
  password(x) {
    if (typeof x !== 'string' || x.length < 8) throw E.bad('Use at least 8 characters for your password.');
    if (x.length > 200) throw E.bad('That password is too long.');
    return x;
  },
  uuidList(x, name) {
    if (x == null) return [];
    if (!Array.isArray(x) || x.length > 50) throw E.bad(`${name} must be a list of people.`);
    return [...new Set(x.map(i => v.uuid(i, name)))];
  }
};

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');
const isPriv = u => u.role === 'admin' || u.role === 'manager';

// every change worth remembering goes through here, inside the same transaction as the change itself
async function audit(c, user, category, action, details = '') {
  await c.query(
    'INSERT INTO audit_log (company_id, actor_id, actor_name, category, action, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [user.companyId, user.id || null, user.name, category, action, details]
  );
}
async function notify(c, companyId, employeeId, body, link = null) {
  await c.query('INSERT INTO notifications (company_id, employee_id, body, link) VALUES ($1,$2,$3,$4)', [companyId, employeeId, body, link]);
}
async function localToday(c, companyId) {
  const r = await c.query('SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM companies WHERE id = $1', [companyId]);
  return r.rows[0].d;
}
// Monday to Friday between two YYYY-MM-DD dates, inclusive (public holidays are not modelled yet)
function workdays(a, b) {
  let n = 0;
  for (let d = new Date(a + 'T12:00:00Z'), end = new Date(b + 'T12:00:00Z'); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const g = d.getUTCDay();
    if (g !== 0 && g !== 6) n++;
  }
  return n;
}
function escapeLike(s) { return s.replace(/[\\%_]/g, m => '\\' + m); }

module.exports = { HttpError, E, wrap, v, sha, token, isPriv, audit, notify, localToday, workdays, escapeLike };
