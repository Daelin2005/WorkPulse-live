const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, isPriv, audit, notify, localToday, workdays } = require('../lib/util');
const { requirePriv } = require('../lib/auth');
const { insertTicket } = require('../lib/tickets');

const L_SQL = `SELECT lr.id, lr.employee_id AS "employeeId", e.full_name AS employee, d.name AS department, lt.name AS "leaveType", lr.leave_type_id AS "leaveTypeId",
  lr.start_date AS "startDate", lr.end_date AS "endDate", lr.day_part AS "dayPart", lr.days::float AS days, lr.reason, lr.status,
  lr.decision_note AS "decisionNote", lr.decided_at AS "decidedAt", dm.full_name AS "decidedBy", lr.created_at AS "appliedOn", lr.ticket_id AS "ticketId"
  FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN departments d ON d.id = e.department_id
  JOIN leave_types lt ON lt.id = lr.leave_type_id LEFT JOIN employees dm ON dm.id = lr.decided_by WHERE lr.company_id = $1`;

// The leave year the given day falls in, based on the company's start month.
function leaveYear(todayStr, startMonth) {
  const [y, m] = todayStr.split('-').map(Number);
  const sy = m >= startMonth ? y : y - 1;
  const start = `${sy}-${String(startMonth).padStart(2, '0')}-01`;
  const end = new Date(Date.UTC(sy + 1, startMonth - 1, 1) - 864e5).toISOString().slice(0, 10);
  return { start, end };
}

router.get('/balances', wrap(async (req, res) => {
  const u = req.user, today = await localToday(db, u.companyId);
  const co = (await db.query('SELECT leave_year_start FROM companies WHERE id = $1', [u.companyId])).rows[0];
  const yr = leaveYear(today, co.leave_year_start);
  const rows = (await db.query(
    `SELECT lt.id, lt.name, lt.days_per_year AS allowance, lt.requires_approval AS "requiresApproval", lt.min_notice_days AS "minNoticeDays",
            coalesce(sum(lr.days) FILTER (WHERE lr.status = 'approved'), 0)::float AS used, coalesce(sum(lr.days) FILTER (WHERE lr.status = 'pending'), 0)::float AS pending
       FROM leave_types lt LEFT JOIN leave_requests lr ON lr.leave_type_id = lt.id AND lr.employee_id = $2 AND lr.start_date BETWEEN $3 AND $4
      WHERE lt.company_id = $1 AND lt.enabled GROUP BY lt.id ORDER BY lt.is_core DESC, lt.name`, [u.companyId, u.id, yr.start, yr.end])).rows;
  res.json({ yearStart: yr.start, yearEnd: yr.end, types: rows.map(r => ({ ...r, remaining: r.allowance > 0 ? r.allowance - r.used - r.pending : null })) });
}));

// Your own requests. Admins and managers can pass ?scope=all (and ?status=pending) to see everyone's.
router.get('/', wrap(async (req, res) => {
  const u = req.user, p = [u.companyId], w = [];
  if (!(isPriv(u) && req.query.scope === 'all')) { p.push(u.id); w.push(`lr.employee_id = $${p.length}`); }
  if (req.query.status) { p.push(v.oneOf(req.query.status, ['pending', 'approved', 'rejected', 'cancelled'], 'Status')); w.push(`lr.status = $${p.length}`); }
  res.json((await db.query(L_SQL + (w.length ? ' AND ' + w.join(' AND ') : '') + ' ORDER BY lr.start_date DESC LIMIT 500', p)).rows);
}));

// Approved leave for everyone, so people can plan around absences.
router.get('/calendar', wrap(async (req, res) => {
  const from = v.date(req.query.from, 'From'), to = v.date(req.query.to, 'To');
  res.json((await db.query(
    `SELECT lr.id, e.full_name AS employee, e.id AS "employeeId", d.name AS department, lt.name AS "leaveType", lr.start_date AS "startDate", lr.end_date AS "endDate", lr.days::float AS days
       FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN departments d ON d.id = e.department_id JOIN leave_types lt ON lt.id = lr.leave_type_id
      WHERE lr.company_id = $1 AND lr.status = 'approved' AND lr.start_date <= $3 AND lr.end_date >= $2 ORDER BY lr.start_date`, [req.user.companyId, from, to])).rows);
}));

router.post('/', wrap(async (req, res) => {
  const u = req.user, b = req.body || {};
  const typeId = v.uuid(b.leaveTypeId, 'Leave type'), start = v.date(b.startDate, 'First day off'), end = v.date(b.endDate, 'Last day off');
  const part = v.oneOf(b.dayPart || 'full', ['full', 'am', 'pm'], 'Duration'), reason = v.str(b.reason, 'Reason', { max: 1000 });
  if (end < start) throw E.bad('Your last day off cannot be before your first day.');
  if (part !== 'full' && start !== end) throw E.bad('Half days are for a single day off.');
  const days = part === 'full' ? workdays(start, end) : (workdays(start, end) ? 0.5 : 0);
  if (!days) throw E.bad('Those dates are all weekend days. Choose working days.');

  const out = await db.tx(async c => {
    const lt = (await c.query('SELECT * FROM leave_types WHERE id = $1 AND company_id = $2 AND enabled', [typeId, u.companyId])).rows[0];
    if (!lt) throw E.bad('That leave type is not available.');
    const today = await localToday(c, u.companyId);
    if (start < today) throw E.bad('You cannot request leave for days that have already passed.');
    const gap = Math.round((Date.parse(start + 'T12:00:00Z') - Date.parse(today + 'T12:00:00Z')) / 864e5);
    if (lt.min_notice_days && gap < lt.min_notice_days) throw E.bad(`${lt.name} leave needs at least ${lt.min_notice_days} days notice.`, 'NOTICE');
    await c.query('SELECT 1 FROM employees WHERE id = $1 FOR UPDATE', [u.id]);                  // serialise one person's requests so balance checks cannot race
    if ((await c.query("SELECT 1 FROM leave_requests WHERE employee_id = $1 AND status IN ('pending','approved') AND start_date <= $3 AND end_date >= $2", [u.id, start, end])).rowCount) throw E.conflict('You already have leave on some of those dates.', 'OVERLAP');
    if (lt.days_per_year > 0) {
      const yr = leaveYear(today, (await c.query('SELECT leave_year_start FROM companies WHERE id = $1', [u.companyId])).rows[0].leave_year_start);
      const used = (await c.query("SELECT coalesce(sum(days), 0)::float AS n FROM leave_requests WHERE employee_id = $1 AND leave_type_id = $2 AND status IN ('pending','approved') AND start_date BETWEEN $3 AND $4", [u.id, typeId, yr.start, yr.end])).rows[0].n;
      if (used + days > lt.days_per_year) throw E.bad(`You have ${Math.max(0, lt.days_per_year - used)} days of ${lt.name.toLowerCase()} leave available, including pending requests.`, 'NO_BALANCE');
    }
    const status = lt.requires_approval ? 'pending' : 'approved';
    const r = (await c.query(
      `INSERT INTO leave_requests (company_id, employee_id, leave_type_id, start_date, end_date, day_part, days, reason, status, decided_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $9 = 'approved' THEN now() END) RETURNING id`, [u.companyId, u.id, typeId, start, end, part, days, reason, status])).rows[0];
    if (status === 'pending') {
      const admins = (await c.query("SELECT id FROM employees WHERE company_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2", [u.companyId, u.id])).rows;
      const t = await insertTicket(c, u, { subject: `Leave request: ${lt.name}, ${start}${end !== start ? ' to ' + end : ''}`, description: reason, category: 'HR Inquiry', urgency: 'Medium', assigneeIds: admins.map(a => a.id), notifyAll: false, notifyAssignees: false });
      await c.query('UPDATE leave_requests SET ticket_id = $1 WHERE id = $2', [t.id, r.id]);
      for (const a of admins) await notify(c, u.companyId, a.id, `${u.name} requested ${days} day(s) of ${lt.name.toLowerCase()} leave`, '/leave');
    } else await audit(c, u, 'Leave', 'Leave approved automatically', `${u.name}, ${lt.name}, ${start} to ${end}`);
    return r.id;
  });
  res.status(201).json((await db.query(L_SQL + ' AND lr.id = $2', [u.companyId, out])).rows[0]);
}));

router.post('/:id/cancel', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Request'), u = req.user;
  await db.tx(async c => {
    const r = (await c.query('SELECT status, start_date FROM leave_requests WHERE id = $1 AND employee_id = $2 AND company_id = $3 FOR UPDATE', [id, u.id, u.companyId])).rows[0];
    if (!r) throw E.notFound('Request not found.');
    const today = await localToday(c, u.companyId);
    if (!(r.status === 'pending' || (r.status === 'approved' && String(r.start_date.toISOString ? r.start_date.toISOString().slice(0, 10) : r.start_date) > today))) throw E.conflict('Only pending requests, or approved leave that has not started, can be cancelled.', 'NOT_CANCELLABLE');
    await c.query("UPDATE leave_requests SET status = 'cancelled' WHERE id = $1", [id]);
  });
  res.json({ ok: true });
}));

// Approve or reject. The answer includes a staffing warning when others in the same department are already away.
router.post('/:id/decision', requirePriv, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Request'), u = req.user;
  const decision = v.oneOf(req.body && req.body.decision, ['approve', 'reject'], 'Decision');
  const note = v.str(req.body.note, 'Note', { max: 1000, optional: true });
  const out = await db.tx(async c => {
    const r = (await c.query(
      `SELECT lr.*, e.full_name, e.department_id, lt.name AS type_name FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
        WHERE lr.id = $1 AND lr.company_id = $2 FOR UPDATE OF lr`, [id, u.companyId])).rows[0];
    if (!r) throw E.notFound('Request not found.');
    if (r.employee_id === u.id) throw E.forbidden('You cannot decide your own leave request.');
    if (r.status !== 'pending') throw E.conflict('That request has already been decided.', 'ALREADY_DECIDED');
    const warnAt = (await c.query('SELECT staffing_warn_at FROM companies WHERE id = $1', [u.companyId])).rows[0].staffing_warn_at;
    const away = (await c.query(
      `SELECT e.full_name FROM leave_requests o JOIN employees e ON e.id = o.employee_id
        WHERE o.company_id = $1 AND o.status = 'approved' AND e.department_id = $2 AND o.employee_id <> $3 AND o.start_date <= $5 AND o.end_date >= $4`,
      [u.companyId, r.department_id, r.employee_id, r.start_date, r.end_date])).rows.map(x => x.full_name);
    const status = decision === 'approve' ? 'approved' : 'rejected';
    await c.query('UPDATE leave_requests SET status = $1, decided_by = $2, decision_note = $3, decided_at = now() WHERE id = $4', [status, u.id, note, id]);
    if (r.ticket_id) await c.query("UPDATE tickets SET status = 'Resolved', resolved_at = now() WHERE id = $1", [r.ticket_id]);
    await notify(c, u.companyId, r.employee_id, `Your ${r.type_name.toLowerCase()} leave request was ${status}${note ? ': ' + note : ''}`, '/leave');
    await audit(c, u, 'Leave', status === 'approved' ? 'Approved leave' : 'Rejected leave', `${r.full_name}, ${r.type_name}`);
    return { warning: away.length >= warnAt ? { message: 'Others in the same department are already away on those dates.', people: away } : null };
  });
  res.json({ ok: true, ...out });
}));

module.exports = router;
