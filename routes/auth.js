const router = require('express').Router();
const bcrypt = require('bcryptjs');
const rateLimit = require('express-rate-limit');
const db = require('../lib/db');
const mail = require('../lib/mail');
const { HttpError, E, wrap, v, sha, token, audit, notify } = require('../lib/util');
const { startSession, endSession, requireAuth, meOf } = require('../lib/auth');
const { insertTicket } = require('../lib/tickets');
const { employeeUsername } = require('../lib/identity');

const limiter = (limit, minutes) => rateLimit({
  windowMs: minutes * 60e3, limit, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many attempts. Try again later.', code: 'RATE_LIMITED' }
});
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 12); // so unknown emails take as long to reject as wrong passwords
const isDev = () => process.env.NODE_ENV !== 'production';
const linkTo = q => `${process.env.APP_ORIGIN || ''}${process.env.LOGIN_PATH || '/Login.html'}?${q}`;
const DEV_ADMIN = (() => {
  if (process.env.NODE_ENV !== 'development') return null;
  const email = process.env.DEV_ADMIN_EMAIL;
  const password = process.env.DEV_ADMIN_PASSWORD;
  const username = process.env.DEV_ADMIN_USERNAME;
  if (!email && !password && !username) return null;
  if (!email || !password) throw new Error('Configure both DEV_ADMIN_EMAIL and DEV_ADMIN_PASSWORD to enable local developer access.');
  if (password.length < 12) throw new Error('DEV_ADMIN_PASSWORD must be at least 12 characters.');
  return {
    email: v.email(email),
    username: employeeUsername(username || 'admin', email),
    passwordHash: bcrypt.hashSync(password, 12)
  };
})();

// Does a company with this domain exist? Powers the "company does not exist" popup.
router.get('/company-exists', limiter(60, 15), wrap(async (req, res) => {
  const domain = v.str(req.query.domain, 'Domain', { max: 120 }).toLowerCase();
  const r = await db.query('SELECT 1 FROM companies WHERE domain = $1', [domain]);
  res.json({ exists: r.rowCount > 0 });
}));

// First-time setup: creates the company, its defaults, and the first person as admin.
router.post('/register', limiter(10, 60), wrap(async (req, res) => {
  const b = req.body || {};
  const companyName = v.str(b.companyName, 'Company name', { max: 120 });
  const domain = v.str(b.domain, 'Company domain', { max: 120 }).toLowerCase();
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) throw E.bad('Enter the domain only, like acme.com.');
  const timezone = v.str(b.timezone, 'Time zone', { max: 60 });
  try { new Intl.DateTimeFormat('en', { timeZone: timezone }); } catch (_) { throw E.bad('Choose a valid time zone.'); }
  const adminName = v.str(b.adminName, 'Your name', { max: 120 });
  const email = v.email(b.email);
  const username = employeeUsername(b.username, email);
  if (email.split('@')[1] !== domain) throw E.bad(`Your work email must end in @${domain}.`);
  const hash = await bcrypt.hash(v.password(b.password), 12);
  const prefix = companyName.split(/\s+/).map(w => w[0]).join('').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() || 'EMP';

  const emp = await db.tx(async c => {
    if ((await c.query('SELECT 1 FROM companies WHERE domain = $1', [domain])).rowCount) throw E.conflict('That domain is already registered. Ask your company admin to add you.', 'DOMAIN_TAKEN');
    if ((await c.query('SELECT 1 FROM employees WHERE email = $1', [email])).rowCount) throw E.conflict('That email is already in use.', 'EMAIL_TAKEN');
    const co = (await c.query('INSERT INTO companies (name, domain, employee_prefix, timezone, renews_on) VALUES ($1,$2,$3,$4, current_date + 30) RETURNING id', [companyName, domain, prefix, timezone])).rows[0];
    const itId = (await c.query('SELECT seed_company_defaults($1) AS id', [co.id])).rows[0].id;
    const e = (await c.query(
      `INSERT INTO employees (company_id, employee_no, username, full_name, email, department_id, job_title, role, status, start_date, password_hash, last_login_at)
       VALUES ($1, next_employee_no($1), $2, $3, $4, $5, 'Company admin', 'admin', 'active', current_date, $6, now()) RETURNING id, company_id`,
      [co.id, username, adminName, email, itId, hash]
    )).rows[0];
    await c.query('UPDATE departments SET head_id = $1 WHERE id = $2', [e.id, itId]);
    await c.query('INSERT INTO employee_preferences (employee_id) VALUES ($1)', [e.id]);
    await audit(c, { companyId: co.id, id: e.id, name: adminName }, 'Company', 'Company registered', `${companyName} (${domain})`);
    await startSession(c, res, req, e);
    return e;
  });
  res.status(201).json(await meOf(emp.id));
}));

router.post('/login', limiter(20, 15), wrap(async (req, res) => {
  const email = v.email(req.body && req.body.email);
  const username = req.body && req.body.username !== undefined ? employeeUsername(req.body.username, email) : null;
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!(await db.query('SELECT 1 FROM companies WHERE domain = $1', [email.split('@')[1]])).rowCount) {
    throw new HttpError(404, 'We could not find a company for that email domain.', 'NO_COMPANY');
  }
  const emp = (await db.query('SELECT id, company_id, full_name, username, email, role, status, password_hash FROM employees WHERE email = $1 AND ($2::text IS NULL OR username = $2)', [email, username])).rows[0];
  if (emp && emp.status === 'invited') throw E.conflict('Open the link in your invitation email to finish setting up your account.', 'INVITED');
  const passwordOk = await bcrypt.compare(password, (emp && emp.password_hash) || DUMMY_HASH);
  const developerPasswordOk = Boolean(DEV_ADMIN && emp && emp.status === 'active' && emp.role === 'admin' &&
    emp.username === DEV_ADMIN.username && emp.email === DEV_ADMIN.email &&
    await bcrypt.compare(password, DEV_ADMIN.passwordHash));
  const passwordAccepted = Boolean(emp && ((emp.password_hash && passwordOk) || developerPasswordOk));
  if (!passwordAccepted) throw new HttpError(401, 'Email or password is incorrect.', 'BAD_CREDENTIALS');
  if (emp.status === 'deactivated') throw E.forbidden('This account has been deactivated. Contact your admin.');
  await db.tx(async c => {
    await c.query('UPDATE employees SET last_login_at = now() WHERE id = $1', [emp.id]);
    await startSession(c, res, req, emp);
    await audit(c, { companyId: emp.company_id, id: emp.id, name: emp.full_name }, 'Security', 'Signed in', (req.get('user-agent') || '').slice(0, 120));
  });
  res.json(await meOf(emp.id));
}));

router.post('/logout', wrap(async (req, res) => {
  await endSession(res, req.user && req.user.sessionId);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, wrap(async (req, res) => res.json(await meOf(req.user.id))));

router.get('/invite-info', limiter(20, 15), wrap(async (req, res) => {
  const t = v.str(req.query.token, 'Invitation token', { max: 200 });
  const employee = (await db.query(
    `SELECT e.username, e.full_name AS name, e.email, c.name AS company
       FROM employees e JOIN companies c ON c.id = e.company_id
      WHERE e.invite_token_hash = $1 AND e.invite_expires_at > now() AND e.status = 'invited'`,
    [sha(t)]
  )).rows[0];
  if (!employee) throw E.bad('This invitation link is not valid or has expired. Ask your admin to send a new one.', 'BAD_INVITE');
  res.json({ authorized: true, employee: { username: employee.username, name: employee.name, email: employee.email }, company: employee.company });
}));

// An admin added you: the emailed link carries a one-time token. You choose a password and are signed in.
router.post('/activate', limiter(10, 15), wrap(async (req, res) => {
  const t = v.str(req.body && req.body.token, 'Invitation token', { max: 200 });
  const username = employeeUsername(req.body && req.body.username, v.email(req.body && req.body.email));
  const email = v.email(req.body.email);
  const hash = await bcrypt.hash(v.password(req.body.password), 12);
  const emp = await db.tx(async c => {
    const r = await c.query(
      `UPDATE employees SET password_hash = $1, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL, last_login_at = now()
        WHERE invite_token_hash = $2 AND invite_expires_at > now() AND status = 'invited' AND username = $3 AND email = $4
        RETURNING id, company_id, full_name`,
      [hash, sha(t), username, email]
    );
    if (!r.rowCount) throw E.bad('This invitation link is not valid or has expired. Ask your admin to send a new one.', 'BAD_INVITE');
    const e = r.rows[0];
    await c.query('INSERT INTO employee_preferences (employee_id) VALUES ($1) ON CONFLICT DO NOTHING', [e.id]);
    await audit(c, { companyId: e.company_id, id: e.id, name: e.full_name }, 'Employees', 'Accepted invitation', e.full_name);
    await startSession(c, res, req, e);
    return e;
  });
  res.json(await meOf(emp.id));
}));

// Always answers the same way, so nobody can use this to find out who has an account.
router.post('/forgot', limiter(5, 15), wrap(async (req, res) => {
  const email = v.email(req.body && req.body.email);
  const emp = (await db.query("SELECT id FROM employees WHERE email = $1 AND status = 'active'", [email])).rows[0];
  let devLink;
  if (emp) {
    const t = token();
    await db.query("INSERT INTO password_resets (employee_id, token_hash, expires_at) VALUES ($1,$2, now() + interval '1 hour')", [emp.id, sha(t)]);
    const link = linkTo(`reset=${t}`);
    await mail.send(email, 'Reset your WorkPulse password', `Use this link within one hour: ${link}`);
    if (isDev()) devLink = link;
  }
  res.json({ ok: true, ...(devLink ? { devLink } : {}) });
}));

router.post('/reset', limiter(10, 15), wrap(async (req, res) => {
  const t = v.str(req.body && req.body.token, 'Reset token', { max: 200 });
  const hash = await bcrypt.hash(v.password(req.body.password), 12);
  await db.tx(async c => {
    const r = await c.query('UPDATE password_resets SET used_at = now() WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING employee_id', [sha(t)]);
    if (!r.rowCount) throw E.bad('This reset link is not valid or has expired. Ask for a new one.', 'BAD_RESET');
    const id = r.rows[0].employee_id;
    const e = (await c.query('UPDATE employees SET password_hash = $1 WHERE id = $2 RETURNING company_id, full_name', [hash, id])).rows[0];
    await c.query('UPDATE sessions SET revoked_at = now() WHERE employee_id = $1 AND revoked_at IS NULL', [id]);
    await audit(c, { companyId: e.company_id, id, name: e.full_name }, 'Security', 'Password reset', 'All other sessions were signed out');
  });
  res.json({ ok: true });
}));

// "Contact admin" from the sign-in page: forgotten details, or new and not on the system yet.
router.post('/contact-admin', limiter(5, 60), wrap(async (req, res) => {
  const email = v.email(req.body && req.body.email);
  const message = v.str(req.body.message, 'Message', { max: 2000 });
  const co = (await db.query('SELECT id FROM companies WHERE domain = $1', [email.split('@')[1]])).rows[0];
  if (!co) throw new HttpError(404, 'We could not find a company for that email domain.', 'NO_COMPANY');
  const admin = await db.tx(async c => {
    const admins = (await c.query("SELECT id, full_name FROM employees WHERE company_id = $1 AND role = 'admin' AND status = 'active' ORDER BY created_at", [co.id])).rows;
    if (!admins.length) return null;
    const known = (await c.query('SELECT id, full_name FROM employees WHERE email = $1 AND company_id = $2', [email, co.id])).rows[0];
    const sender = known || admins[0];                                 // a newcomer has no account yet, so the ticket is filed under the first admin
    const u = { companyId: co.id, id: sender.id, name: sender.full_name };
    const t = await insertTicket(c, u, {
      subject: `Sign-in help: ${email}`, description: `From ${email}\n\n${message}`, category: 'General Support', urgency: 'High',
      assigneeIds: admins.map(a => a.id), createdNote: `created this ticket from the sign-in page (${email})`
    });
    await audit(c, u, 'Security', 'Sign-in help requested', `${email} asked an admin for help (ticket #${t.number})`);
    return admins[0];
  });
  res.status(201).json({ ok: true, adminName: admin ? admin.full_name : null });
}));

module.exports = router;
