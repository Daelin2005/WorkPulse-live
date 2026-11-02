const db = require('./db');
const { E, sha, token, isPriv } = require('./util');

const COOKIE = 'wp_sid';
const DAYS = Number(process.env.SESSION_DAYS || 14);

function cookieOptions() {
  return { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: DAYS * 864e5 };
}

// Only a hash of the cookie value is stored, so a database leak does not hand out working sessions.
async function startSession(c, res, req, emp) {
  const t = token();
  await c.query(
    `INSERT INTO sessions (employee_id, company_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval)`,
    [emp.id, emp.company_id, sha(t), (req.get('user-agent') || '').slice(0, 300), req.ip, String(DAYS)]
  );
  res.cookie(COOKIE, t, cookieOptions());
}

async function endSession(res, sessionId) {
  if (sessionId) await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [sessionId]);
  res.clearCookie(COOKIE, { path: '/' });
}

// Runs on every request. Fills req.user when the cookie belongs to a live session of an active employee.
async function loadUser(req, res, next) {
  try {
    const t = req.cookies && req.cookies[COOKIE];
    if (!t) return next();
    const { rows } = await db.query(
      `SELECT s.id AS session_id, s.last_seen_at, e.id, e.company_id, e.full_name, e.email, e.role, e.department_id,
              d.name AS dept_name, d.handles_tickets, c.timezone
         FROM sessions s
         JOIN employees e ON e.id = s.employee_id
         JOIN departments d ON d.id = e.department_id
         JOIN companies c ON c.id = e.company_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND e.status = 'active'`,
      [sha(t)]
    );
    const r = rows[0];
    if (r) {
      req.user = { id: r.id, companyId: r.company_id, name: r.full_name, email: r.email, role: r.role, departmentId: r.department_id,
                   department: r.dept_name, handlesTickets: r.handles_tickets, timezone: r.timezone, sessionId: r.session_id };
      if (Date.now() - new Date(r.last_seen_at).getTime() > 5 * 60e3) {
        db.query('UPDATE sessions SET last_seen_at = now() WHERE id = $1', [r.session_id]).catch(() => {});
      }
    }
    next();
  } catch (e) { next(e); }
}

const requireAuth = (req, res, next) => (req.user ? next() : next(E.unauth()));
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(E.unauth());
  return roles.includes(req.user.role) ? next() : next(E.forbidden());
};
const requirePriv = (req, res, next) => (!req.user ? next(E.unauth()) : isPriv(req.user) ? next() : next(E.forbidden()));

// The signed-in person and their company, in the shape the pages use.
async function meOf(employeeId) {
  const { rows } = await db.query(
    `SELECT e.id, e.employee_no, e.username, e.full_name, e.email, e.role, e.job_title, e.phone, e.avatar, e.start_date,
            d.id AS dept_id, d.name AS dept_name,
            c.id AS company_id, c.public_id, c.name AS company_name, c.domain, c.tier, c.seats, c.renews_on, c.logo, c.timezone
       FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies c ON c.id = e.company_id WHERE e.id = $1`,
    [employeeId]
  );
  const r = rows[0];
  return {
    user: { id: r.id, employeeNo: r.employee_no, username: r.username, name: r.full_name, email: r.email, role: r.role, jobTitle: r.job_title, phone: r.phone,
            avatar: r.avatar, startDate: r.start_date, department: { id: r.dept_id, name: r.dept_name } },
    company: { id: r.company_id, publicId: r.public_id, name: r.company_name, domain: r.domain, tier: r.tier, seats: r.seats,
               renewsOn: r.renews_on, logo: r.logo, timezone: r.timezone }
  };
}

module.exports = { COOKIE, startSession, endSession, loadUser, requireAuth, requireRole, requirePriv, meOf };
