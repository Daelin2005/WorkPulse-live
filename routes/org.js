// Company profile, departments, employees, the signed-in person's own profile, and notifications.
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const db = require('../lib/db');
const mail = require('../lib/mail');
const { E, wrap, v, sha, token, isPriv, audit } = require('../lib/util');
const { requireRole, requirePriv, endSession } = require('../lib/auth');
const { employeeUsername } = require('../lib/identity');

const admin = requireRole('admin');
const linkTo = q => `${process.env.APP_ORIGIN || ''}${process.env.LOGIN_PATH || '/Login.html'}?${q}`;
const isDev = () => process.env.NODE_ENV !== 'production';
const DATA_URL = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;

/* ------------------------------------------------------------ company */
const COMPANY_SQL = `SELECT id, public_id AS "publicId", name, domain, tier, seats, renews_on AS "renewsOn", logo, timezone,
  employee_prefix AS "employeePrefix", leave_year_start AS "leaveYearStart", staffing_warn_at AS "staffingWarnAt", sla_business_hours AS "slaBusinessHours"
  FROM companies WHERE id = $1`;

router.get('/company', wrap(async (req, res) => {
  const c = (await db.query(COMPANY_SQL, [req.user.companyId])).rows[0];
  const n = (await db.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND status <> 'deactivated'", [req.user.companyId])).rows[0].n;
  res.json({ ...c, seatsUsed: n });
}));

router.patch('/company', admin, wrap(async (req, res) => {
  const b = req.body || {}, sets = [], p = [req.user.companyId], changed = [];
  const add = (col, val, label) => { p.push(val); sets.push(`${col} = $${p.length}`); changed.push(label); };
  if (b.name !== undefined) add('name', v.str(b.name, 'Company name', { max: 120 }), 'name');
  if (b.timezone !== undefined) {
    const tz = v.str(b.timezone, 'Time zone', { max: 60 });
    try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch (_) { throw E.bad('That time zone is not recognised.'); }
    add('timezone', tz, 'time zone');
  }
  if (b.leaveYearStart !== undefined) add('leave_year_start', v.int(b.leaveYearStart, 'Leave year start month', { min: 1, max: 12 }), 'leave year start');
  if (b.staffingWarnAt !== undefined) add('staffing_warn_at', v.int(b.staffingWarnAt, 'Staffing warning', { min: 1, max: 100 }), 'staffing warning');
  if (b.slaBusinessHours !== undefined) add('sla_business_hours', v.bool(b.slaBusinessHours), 'SLA business hours');
  if (b.logo !== undefined) {
    if (b.logo === null || b.logo === '') add('logo', null, 'logo removed');
    else { if (typeof b.logo !== 'string' || b.logo.length > 1.4e6 || !DATA_URL.test(b.logo)) throw E.bad('Choose a PNG, JPEG, GIF or WebP image under 1 MB.'); add('logo', b.logo, 'logo'); }
  }
  if (!sets.length) throw E.bad('Nothing to change.');
  await db.tx(async c => {
    await c.query(`UPDATE companies SET ${sets.join(', ')} WHERE id = $1`, p);
    await audit(c, req.user, 'Company', 'Edited company profile', changed.join(', '));
  });
  res.json((await db.query(COMPANY_SQL, [req.user.companyId])).rows[0]);
}));

/* ------------------------------------------------------------ departments */
const DEPT_SQL = `SELECT d.id, d.name, d.head_id AS "headId", h.full_name AS "headName", d.handles_tickets AS "handlesTickets",
  (SELECT count(*)::int FROM employees e WHERE e.department_id = d.id AND e.status <> 'deactivated') AS people
  FROM departments d LEFT JOIN employees h ON h.id = d.head_id WHERE d.company_id = $1`;

router.get('/departments', wrap(async (req, res) => {
  res.json((await db.query(DEPT_SQL + ' ORDER BY d.name', [req.user.companyId])).rows);
}));

async function headOk(c, companyId, headId) {
  if (!headId) return null;
  v.uuid(headId, 'Department head');
  const r = await c.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND status = 'active'", [headId, companyId]);
  if (!r.rowCount) throw E.bad('The department head must be an active person in your company.');
  return headId;
}

router.post('/departments', admin, wrap(async (req, res) => {
  const name = v.str(req.body && req.body.name, 'Department name', { max: 80 });
  const out = await db.tx(async c => {
    const head = await headOk(c, req.user.companyId, req.body.headId);
    const r = await c.query('INSERT INTO departments (company_id, name, head_id, handles_tickets) VALUES ($1,$2,$3,$4) RETURNING id', [req.user.companyId, name, head, v.bool(req.body.handlesTickets)]);
    await audit(c, req.user, 'Employees', 'Added department', name);
    return r.rows[0].id;
  });
  res.status(201).json((await db.query(DEPT_SQL + ' AND d.id = $2', [req.user.companyId, out])).rows[0]);
}));

router.patch('/departments/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Department');
  await db.tx(async c => {
    const cur = (await c.query('SELECT name FROM departments WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, req.user.companyId])).rows[0];
    if (!cur) throw E.notFound('Department not found.');
    const b = req.body || {};
    const name = b.name !== undefined ? v.str(b.name, 'Department name', { max: 80 }) : cur.name;
    const head = b.headId !== undefined ? await headOk(c, req.user.companyId, b.headId) : undefined;
    const sets = ['name = $1'], p = [name];
    if (head !== undefined) { p.push(head); sets.push(`head_id = $${p.length}`); }
    if (b.handlesTickets !== undefined) { p.push(v.bool(b.handlesTickets)); sets.push(`handles_tickets = $${p.length}`); }
    p.push(id, req.user.companyId);
    await c.query(`UPDATE departments SET ${sets.join(', ')} WHERE id = $${p.length - 1} AND company_id = $${p.length}`, p);
    await audit(c, req.user, 'Employees', 'Edited department', name);
  });
  res.json((await db.query(DEPT_SQL + ' AND d.id = $2', [req.user.companyId, id])).rows[0]);
}));

router.delete('/departments/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Department');
  await db.tx(async c => {
    const d = (await c.query('SELECT name FROM departments WHERE id = $1 AND company_id = $2', [id, req.user.companyId])).rows[0];
    if (!d) throw E.notFound('Department not found.');
    if ((await c.query('SELECT 1 FROM employees WHERE department_id = $1', [id])).rowCount) throw E.conflict('Move the people out of this department before deleting it.', 'DEPARTMENT_NOT_EMPTY');
    await c.query('DELETE FROM departments WHERE id = $1', [id]);
    await audit(c, req.user, 'Employees', 'Deleted department', d.name);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ employees */
const EMP_SQL = `SELECT e.id, e.employee_no AS "employeeNo", e.username, e.full_name AS name, e.email, e.job_title AS "jobTitle", e.role, e.status,
  e.start_date AS "startDate", e.phone, d.id AS "departmentId", d.name AS department, e.last_login_at AS "lastLoginAt"
  FROM employees e JOIN departments d ON d.id = e.department_id WHERE e.company_id = $1`;

// Active coworkers can see one another's work contact details in the directory.
router.get('/employees', wrap(async (req, res) => {
  const priv = isPriv(req.user);
  const rows = (await db.query(EMP_SQL + (priv ? '' : " AND e.status = 'active'") + ' ORDER BY e.employee_no', [req.user.companyId])).rows;
  res.json(priv ? rows : rows.map(r => ({ id: r.id, name: r.name, jobTitle: r.jobTitle, email: r.email, phone: r.phone, role: r.role, department: r.department, departmentId: r.departmentId, status: r.status })));
}));

async function otherAdmins(c, companyId, exceptId) {
  return (await c.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2", [companyId, exceptId])).rows[0].n;
}
async function deptOk(c, companyId, deptId) {
  const r = await c.query('SELECT name FROM departments WHERE id = $1 AND company_id = $2', [v.uuid(deptId, 'Department'), companyId]);
  if (!r.rowCount) throw E.bad('That department does not exist.');
  return r.rows[0].name;
}
async function inviteFor(c, empId, email, username, companyName) {
  const t = token();
  await c.query("UPDATE employees SET invite_token_hash = $1, invite_expires_at = now() + interval '7 days' WHERE id = $2", [sha(t), empId]);
  const link = linkTo(`invite=${t}`);
  await mail.send(email, `You have been added to ${companyName} on WorkPulse`, `Your WorkPulse username is ${username}. Set your password using this one-time link (valid for 7 days): ${link}`);
  return link;
}

router.post('/employees', admin, wrap(async (req, res) => {
  const b = req.body || {};
  const fullName = v.str(b.fullName, 'Full name', { max: 120 });
  const email = v.email(b.email);
  const username = employeeUsername(b.username, email);
  const title = v.str(b.jobTitle, 'Job title', { max: 120 });
  const role = v.oneOf(b.role || 'employee', ['employee', 'manager', 'admin'], 'Role');
  const start = b.startDate ? v.date(b.startDate, 'Start date') : null;
  const passwordHash = await bcrypt.hash(v.password(b.password), 12);
  let id;
  await db.tx(async c => {
    const co = (await c.query('SELECT domain, seats FROM companies WHERE id = $1 FOR UPDATE', [req.user.companyId])).rows[0];
    if (email.split('@')[1] !== co.domain) throw E.bad(`The work email must end in @${co.domain}.`);
    const dept = await deptOk(c, req.user.companyId, b.departmentId);
    const used = (await c.query("SELECT count(*)::int AS n FROM employees WHERE company_id = $1 AND status <> 'deactivated'", [req.user.companyId])).rows[0].n;
    if (used >= co.seats) throw E.conflict(`Your plan includes ${co.seats} seats and all of them are in use.`, 'SEAT_LIMIT');
    if ((await c.query('SELECT 1 FROM employees WHERE email = $1', [email])).rowCount) throw E.conflict('Someone already uses that email.', 'EMAIL_TAKEN');
    if ((await c.query('SELECT 1 FROM employees WHERE company_id = $1 AND username = $2', [req.user.companyId, username])).rowCount) throw E.conflict('That username is already used in your company.', 'USERNAME_TAKEN');
    id = (await c.query(
      `INSERT INTO employees (company_id, employee_no, username, full_name, email, department_id, job_title, role, status, start_date, password_hash)
       VALUES ($1, next_employee_no($1), $2, $3,$4,$5,$6,$7,'active',$8,$9) RETURNING id`,
      [req.user.companyId, username, fullName, email, b.departmentId, title, role, start, passwordHash]
    )).rows[0].id;
    await c.query('INSERT INTO employee_preferences (employee_id) VALUES ($1) ON CONFLICT (employee_id) DO NOTHING', [id]);
    await audit(c, req.user, 'Employees', 'Added employee', `${fullName} (${dept})`);
  });
  const row = (await db.query(EMP_SQL + ' AND e.id = $2', [req.user.companyId, id])).rows[0];
  res.status(201).json(row);
}));

router.post('/employees/:id/resend-invite', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Employee');
  let link;
  await db.tx(async c => {
    const e = (await c.query("SELECT e.email, e.username, e.full_name, co.name FROM employees e JOIN companies co ON co.id = e.company_id WHERE e.id = $1 AND e.company_id = $2 AND e.status = 'invited'", [id, req.user.companyId])).rows[0];
    if (!e) throw E.notFound('There is no pending invitation for that person.');
    link = await inviteFor(c, id, e.email, e.username, e.name);
    await audit(c, req.user, 'Employees', 'Resent invitation', e.full_name);
  });
  res.json({ ok: true, ...(isDev() ? { inviteLink: link } : {}) });
}));

router.patch('/employees/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Employee');
  const b = req.body || {};
  await db.tx(async c => {
    const cur = (await c.query('SELECT e.*, d.name AS dept_name, co.domain FROM employees e JOIN departments d ON d.id = e.department_id JOIN companies co ON co.id = e.company_id WHERE e.id = $1 AND e.company_id = $2 FOR UPDATE OF e', [id, req.user.companyId])).rows[0];
    if (!cur) throw E.notFound('Employee not found.');
    const next = {
      full_name: b.fullName !== undefined ? v.str(b.fullName, 'Full name', { max: 120 }) : cur.full_name,
      email: b.email !== undefined ? v.email(b.email) : cur.email,
      username: b.username !== undefined ? employeeUsername(b.username, cur.email) : cur.username,
      job_title: b.jobTitle !== undefined ? v.str(b.jobTitle, 'Job title', { max: 120 }) : cur.job_title,
      role: b.role !== undefined ? v.oneOf(b.role, ['employee', 'manager', 'admin'], 'Role') : cur.role,
      department_id: b.departmentId !== undefined ? b.departmentId : cur.department_id,
      start_date: b.startDate !== undefined ? (b.startDate ? v.date(b.startDate, 'Start date') : null) : cur.start_date
    };
    if (next.email !== cur.email) {
      if (next.email.split('@')[1] !== cur.domain) throw E.bad(`The work email must end in @${cur.domain}.`);
      if ((await c.query('SELECT 1 FROM employees WHERE email = $1 AND id <> $2', [next.email, id])).rowCount) throw E.conflict('Someone already uses that email.', 'EMAIL_TAKEN');
    }
    if (next.username !== cur.username && (await c.query('SELECT 1 FROM employees WHERE company_id = $1 AND username = $2 AND id <> $3', [req.user.companyId, next.username, id])).rowCount) {
      throw E.conflict('That username is already used in your company.', 'USERNAME_TAKEN');
    }
    const deptName = next.department_id !== cur.department_id ? await deptOk(c, req.user.companyId, next.department_id) : cur.dept_name;
    if (cur.role === 'admin' && next.role !== 'admin' && !(await otherAdmins(c, req.user.companyId, id))) throw E.conflict('Every company needs at least one admin. Make someone else an admin first.', 'LAST_ADMIN');
    const ch = [];
    if (next.role !== cur.role) ch.push(`role ${cur.role} to ${next.role}`);
    if (next.department_id !== cur.department_id) ch.push(`department ${cur.dept_name} to ${deptName}`);
    if (next.job_title !== cur.job_title) ch.push('title');
    if (next.email !== cur.email) ch.push('email');
    if (next.full_name !== cur.full_name) ch.push('name');
    if (next.username !== cur.username) ch.push('username');
    await c.query('UPDATE employees SET full_name=$1, email=$2, job_title=$3, role=$4, department_id=$5, start_date=$6, username=$7 WHERE id=$8',
      [next.full_name, next.email, next.job_title, next.role, next.department_id, next.start_date, next.username, id]);
    await audit(c, req.user, next.role !== cur.role ? 'Security' : 'Employees', next.role !== cur.role ? 'Changed role' : 'Edited employee', `${next.full_name}${ch.length ? ': ' + ch.join(', ') : ''}`);
  });
  res.json((await db.query(EMP_SQL + ' AND e.id = $2', [req.user.companyId, id])).rows[0]);
}));

async function setStatus(req, res, status) {
  const id = v.uuid(req.params.id, 'Employee');
  await db.tx(async c => {
    const e = (await c.query('SELECT full_name, role, status, password_hash FROM employees WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, req.user.companyId])).rows[0];
    if (!e) throw E.notFound('Employee not found.');
    if (status === 'deactivated') {
      if (e.role === 'admin' && e.status === 'active' && !(await otherAdmins(c, req.user.companyId, id))) throw E.conflict('Every company needs at least one active admin.', 'LAST_ADMIN');
      await c.query('UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [id]);
    }
    const target = status === 'active' && !e.password_hash ? 'invited' : status;
    await c.query('UPDATE employees SET status = $1 WHERE id = $2', [target, id]);
    await audit(c, req.user, 'Employees', status === 'deactivated' ? 'Deactivated employee' : 'Reactivated employee', e.full_name);
  });
  res.json({ ok: true });
}
router.post('/employees/:id/deactivate', admin, wrap((req, res) => setStatus(req, res, 'deactivated')));
router.post('/employees/:id/reactivate', admin, wrap((req, res) => setStatus(req, res, 'active')));

/* ------------------------------------------------------------ me */
router.get('/me/profile', wrap(async (req, res) => {
  const e = (await db.query(EMP_SQL + ' AND e.id = $2', [req.user.companyId, req.user.id])).rows[0];
  const p = (await db.query('SELECT prefs, work_mode AS "workMode", default_status AS "defaultStatus", status_message AS "statusMessage" FROM employee_preferences WHERE employee_id = $1', [req.user.id])).rows[0];
  const a = (await db.query('SELECT avatar FROM employees WHERE id = $1', [req.user.id])).rows[0];
  res.json({ ...e, avatar: a.avatar, preferences: p || { prefs: {}, workMode: 'Office', defaultStatus: 'Online', statusMessage: '' } });
}));

router.patch('/me/profile', wrap(async (req, res) => {
  const b = req.body || {}, sets = [], p = [req.user.id];
  if (b.phone !== undefined) {
    const phone = v.str(b.phone, 'Phone number', { max: 30, optional: true });
    if (phone && !/^\+?[\d\s()-]{7,}$/.test(phone)) throw E.bad('Enter a valid phone number.');
    p.push(phone || null); sets.push(`phone = $${p.length}`);
  }
  if (b.avatar !== undefined) {
    if (b.avatar === null || b.avatar === '') { p.push(null); sets.push(`avatar = $${p.length}`); }
    else { if (typeof b.avatar !== 'string' || b.avatar.length > 2.8e6 || !DATA_URL.test(b.avatar)) throw E.bad('Choose a PNG, JPEG, GIF or WebP photo under 2 MB.'); p.push(b.avatar); sets.push(`avatar = $${p.length}`); }
  }
  if (!sets.length) throw E.bad('Nothing to change.');
  await db.query(`UPDATE employees SET ${sets.join(', ')} WHERE id = $1`, p);
  res.json({ ok: true });
}));

router.put('/me/preferences', wrap(async (req, res) => {
  const b = req.body || {};
  const prefs = b.prefs && typeof b.prefs === 'object' && !Array.isArray(b.prefs) ? b.prefs : {};
  if (prefs.ticketNotifications !== undefined && !['assigned', 'all'].includes(prefs.ticketNotifications)) {
    throw E.bad('Ticket notifications must be assigned or all.');
  }
  if (JSON.stringify(prefs).length > 5000) throw E.bad('Those preferences are too large.');
  await db.query(
    `INSERT INTO employee_preferences (employee_id, prefs, work_mode, default_status, status_message) VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (employee_id) DO UPDATE SET prefs = EXCLUDED.prefs, work_mode = EXCLUDED.work_mode, default_status = EXCLUDED.default_status, status_message = EXCLUDED.status_message`,
    [req.user.id, prefs, v.oneOf(b.workMode || 'Office', ['Office', 'Remote', 'On site'], 'Work mode'), v.oneOf(b.defaultStatus || 'Online', ['Online', 'Away'], 'Default status'), v.str(b.statusMessage, 'Status message', { max: 60, optional: true })]
  );
  res.json({ ok: true });
}));

router.post('/me/password', wrap(async (req, res) => {
  const cur = typeof (req.body || {}).current === 'string' ? req.body.current : '';
  const next = v.password(req.body.next);
  if (next === cur) throw E.bad('Your new password must be different from the current one.');
  const row = (await db.query('SELECT password_hash FROM employees WHERE id = $1', [req.user.id])).rows[0];
  if (!(await bcrypt.compare(cur, row.password_hash))) throw E.bad('Your current password is not correct.', 'BAD_PASSWORD');
  const hash = await bcrypt.hash(next, 12);
  await db.tx(async c => {
    await c.query('UPDATE employees SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    await c.query('UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND id <> $2 AND revoked_at IS NULL', [req.user.id, req.user.sessionId]);
    await audit(c, req.user, 'Security', 'Changed password', 'Other sessions were signed out');
  });
  res.json({ ok: true });
}));

router.get('/me/sessions', wrap(async (req, res) => {
  const rows = (await db.query(
    `SELECT id, user_agent AS "userAgent", ip, created_at AS "createdAt", last_seen_at AS "lastSeenAt", (id = $2) AS current
       FROM sessions WHERE employee_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_seen_at DESC`, [req.user.id, req.user.sessionId])).rows;
  res.json(rows);
}));
router.delete('/me/sessions/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Session');
  if (id === req.user.sessionId) { await endSession(res, id); return res.json({ ok: true, signedOut: true }); }
  const r = await db.query('UPDATE sessions SET revoked_at = now() WHERE id = $1 AND employee_id = $2 AND revoked_at IS NULL', [id, req.user.id]);
  if (!r.rowCount) throw E.notFound('That session was not found.');
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ notifications */
router.get('/notifications', wrap(async (req, res) => {
  const rows = (await db.query('SELECT id, body, link, created_at AS "createdAt", read_at AS "readAt" FROM notifications WHERE employee_id = $1 ORDER BY created_at DESC LIMIT 50', [req.user.id])).rows;
  res.json({ unread: rows.filter(r => !r.readAt).length, items: rows });
}));
router.post('/notifications/read-all', wrap(async (req, res) => {
  await db.query('UPDATE notifications SET read_at = now() WHERE employee_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ ok: true });
}));
router.post('/notifications/:id/read', wrap(async (req, res) => {
  await db.query('UPDATE notifications SET read_at = now() WHERE id = $1 AND employee_id = $2', [v.uuid(req.params.id, 'Notification'), req.user.id]);
  res.json({ ok: true });
}));

module.exports = router;
