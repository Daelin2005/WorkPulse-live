const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, isPriv, audit, notify, localToday } = require('../lib/util');
const { requirePriv } = require('../lib/auth');

// The working day is 8 hours: anything above is overtime. Arriving after 08:05 counts as late.
// TODO: move SCHEDULED_MINUTES and the late cut-off into company settings if companies need different shifts.
const SCHEDULED_MINUTES = 480;
const WORKED = `GREATEST(0, floor(extract(epoch FROM (coalesce(r.clock_out, now()) - r.clock_in)) / 60) - r.break_minutes
  - coalesce(floor(extract(epoch FROM (CASE WHEN r.clock_out IS NULL THEN now() - r.break_started_at END)) / 60), 0))::int`;
const REC_SQL = `SELECT r.id, r.work_date AS "date", e.id AS "employeeId", e.full_name AS employee, r.clock_in AS "clockIn", r.clock_out AS "clockOut",
  r.break_minutes AS "breakMinutes", r.break_started_at AS "breakStartedAt", r.location, ${WORKED} AS "workedMinutes",
  GREATEST(0, ${WORKED} - ${SCHEDULED_MINUTES}) AS "overtimeMinutes", ((r.clock_in AT TIME ZONE c.timezone)::time > time '08:05') AS late
  FROM attendance_records r JOIN employees e ON e.id = r.employee_id JOIN companies c ON c.id = r.company_id WHERE r.company_id = $1`;
const LOCATIONS = ['Office', 'Remote', 'On site'];

async function myToday(c, u) {
  const today = await localToday(c, u.companyId);
  const rec = (await c.query('SELECT id, clock_out, break_started_at FROM attendance_records WHERE company_id = $1 AND employee_id = $2 AND work_date = $3 FOR UPDATE', [u.companyId, u.id, today])).rows[0];
  return { today, rec };
}

// Where am I right now? in, break or out.
router.get('/state', wrap(async (req, res) => {
  const u = req.user, today = await localToday(db, u.companyId);
  const rec = (await db.query(REC_SQL + ' AND r.employee_id = $2 AND r.work_date = $3', [u.companyId, u.id, today])).rows[0] || null;
  const state = !rec || rec.clockOut ? 'out' : rec.breakStartedAt ? 'break' : 'in';
  res.json({ state, today: rec });
}));

router.post('/clock-in', wrap(async (req, res) => {
  const u = req.user, location = v.oneOf((req.body && req.body.location) || 'Office', LOCATIONS, 'Location');
  await db.tx(async c => {
    const { today, rec } = await myToday(c, u);
    if (rec && !rec.clock_out) throw E.conflict('You are already clocked in.', 'ALREADY_IN');
    if (rec) await c.query('UPDATE attendance_records SET clock_out = NULL, location = $1 WHERE id = $2', [location, rec.id]);
    else await c.query('INSERT INTO attendance_records (company_id, employee_id, work_date, clock_in, location) VALUES ($1,$2,$3, now(), $4)', [u.companyId, u.id, today, location]);
  });
  res.status(201).json({ ok: true });
}));

router.post('/clock-out', wrap(async (req, res) => {
  const u = req.user;
  await db.tx(async c => {
    const { rec } = await myToday(c, u);
    if (!rec || rec.clock_out) throw E.conflict('You are not clocked in.', 'NOT_IN');
    await c.query(
      `UPDATE attendance_records SET clock_out = now(), break_minutes = break_minutes + coalesce(floor(extract(epoch FROM (now() - break_started_at)) / 60), 0)::int, break_started_at = NULL WHERE id = $1`, [rec.id]);
  });
  res.json({ ok: true });
}));

router.post('/break/start', wrap(async (req, res) => {
  await db.tx(async c => {
    const { rec } = await myToday(c, req.user);
    if (!rec || rec.clock_out) throw E.conflict('Clock in before starting a break.', 'NOT_IN');
    if (rec.break_started_at) throw E.conflict('You are already on a break.', 'ON_BREAK');
    await c.query('UPDATE attendance_records SET break_started_at = now() WHERE id = $1', [rec.id]);
  });
  res.json({ ok: true });
}));
router.post('/break/end', wrap(async (req, res) => {
  await db.tx(async c => {
    const { rec } = await myToday(c, req.user);
    if (!rec || !rec.break_started_at) throw E.conflict('You are not on a break.', 'NOT_ON_BREAK');
    await c.query('UPDATE attendance_records SET break_minutes = break_minutes + floor(extract(epoch FROM (now() - break_started_at)) / 60)::int, break_started_at = NULL WHERE id = $1', [rec.id]);
  });
  res.json({ ok: true });
}));

// Timesheet. Everyone sees their own. Admins and managers can pass ?employeeId=<id> or ?employeeId=all.
router.get('/', wrap(async (req, res) => {
  const u = req.user, q = req.query, p = [u.companyId], w = [];
  const who = q.employeeId;
  if (who && who !== u.id && !isPriv(u)) throw E.forbidden('You can only see your own timesheet.');
  if (who !== 'all' || !isPriv(u)) { p.push(who && isPriv(u) ? v.uuid(who, 'Employee') : u.id); w.push(`r.employee_id = $${p.length}`); }
  if (q.from) { p.push(v.date(q.from, 'From')); w.push(`r.work_date >= $${p.length}`); }
  if (q.to) { p.push(v.date(q.to, 'To')); w.push(`r.work_date <= $${p.length}`); }
  p.push(Math.min(Number(q.limit) || 100, 500));
  res.json((await db.query(REC_SQL + (w.length ? ' AND ' + w.join(' AND ') : '') + ` ORDER BY r.work_date DESC, e.full_name LIMIT $${p.length}`, p)).rows);
}));

// My totals for today, this week and this month, plus overtime, breaks and punctuality.
router.get('/summary', wrap(async (req, res) => {
  const u = req.user, today = await localToday(db, u.companyId);
  const r = (await db.query(
    `SELECT coalesce(sum(w) FILTER (WHERE d = $3::date), 0)::int AS "todayMinutes",
            coalesce(sum(w) FILTER (WHERE d >= date_trunc('week', $3::date)), 0)::int AS "weekMinutes",
            coalesce(sum(w) FILTER (WHERE d >= date_trunc('month', $3::date)), 0)::int AS "monthMinutes",
            coalesce(sum(GREATEST(0, w - ${SCHEDULED_MINUTES})) FILTER (WHERE d >= date_trunc('month', $3::date)), 0)::int AS "overtimeMinutes",
            coalesce(sum(b) FILTER (WHERE d >= date_trunc('month', $3::date)), 0)::int AS "breakMinutes",
            count(*) FILTER (WHERE d >= date_trunc('month', $3::date))::int AS "daysThisMonth",
            count(*) FILTER (WHERE d >= date_trunc('month', $3::date) AND late)::int AS "lateThisMonth"
       FROM (SELECT r.work_date AS d, ${WORKED} AS w, r.break_minutes AS b, ((r.clock_in AT TIME ZONE c.timezone)::time > time '08:05') AS late
               FROM attendance_records r JOIN companies c ON c.id = r.company_id WHERE r.company_id = $1 AND r.employee_id = $2) x`, [u.companyId, u.id, today])).rows[0];
  res.json({ ...r, punctualityPercent: r.daysThisMonth ? Math.round(100 * (r.daysThisMonth - r.lateThisMonth) / r.daysThisMonth) : null });
}));

// Who is clocked in, on a break, on leave or absent right now.
router.get('/presence', wrap(async (req, res) => {
  const u = req.user, today = await localToday(db, u.companyId);
  const rows = (await db.query(
    `SELECT e.id, e.full_name AS name, d.name AS department, coalesce(o.state, 'absent') AS state, o.clock_in AS since, o.location,
            EXISTS (SELECT 1 FROM leave_requests lr WHERE lr.employee_id = e.id AND lr.status = 'approved' AND $2::date BETWEEN lr.start_date AND lr.end_date) AS "onLeave"
       FROM employees e JOIN departments d ON d.id = e.department_id LEFT JOIN v_open_shifts o ON o.employee_id = e.id AND o.work_date = $2::date
      WHERE e.company_id = $1 AND e.status = 'active' ORDER BY e.full_name`, [u.companyId, today])).rows;
  res.json(rows);
}));

/* ------------------------------------------------------------ corrections */
const C_SQL = `SELECT k.id, k.record_id AS "recordId", r.work_date AS "date", e.full_name AS employee, k.employee_id AS "employeeId",
  r.clock_in AS "recordedIn", r.clock_out AS "recordedOut", k.requested_in AS "requestedIn", k.requested_out AS "requestedOut", k.reason, k.status,
  k.decision_note AS "decisionNote", k.decided_at AS "decidedAt", dm.full_name AS "decidedBy", k.created_at AS "createdAt"
  FROM attendance_corrections k JOIN attendance_records r ON r.id = k.record_id JOIN employees e ON e.id = k.employee_id LEFT JOIN employees dm ON dm.id = k.decided_by WHERE k.company_id = $1`;

// Ask for a fix. Times are HH:MM on the day of the record, in the company's time zone.
router.post('/corrections', wrap(async (req, res) => {
  const u = req.user, b = req.body || {};
  const recordId = v.uuid(b.recordId, 'Record'), reason = v.str(b.reason, 'Reason', { max: 1000 });
  const tin = b.requestedIn ? v.time(b.requestedIn, 'Clock in') : null, tout = b.requestedOut ? v.time(b.requestedOut, 'Clock out') : null;
  if (!tin && !tout) throw E.bad('Enter the correct clock in time, the correct clock out time, or both.');
  if (tin && tout && tout <= tin) throw E.bad('Clock out must be after clock in.');
  const id = await db.tx(async c => {
    const r = (await c.query('SELECT id FROM attendance_records WHERE id = $1 AND company_id = $2 AND employee_id = $3', [recordId, u.companyId, u.id])).rows[0];
    if (!r) throw E.notFound('Attendance record not found.');
    if ((await c.query("SELECT 1 FROM attendance_corrections WHERE record_id = $1 AND status = 'pending'", [recordId])).rowCount) throw E.conflict('There is already a pending correction for that day.', 'ALREADY_PENDING');
    const k = (await c.query(
      `INSERT INTO attendance_corrections (company_id, record_id, employee_id, requested_in, requested_out, reason)
       SELECT $1, r.id, $2, CASE WHEN $4::text IS NULL THEN NULL ELSE (r.work_date + $4::time) AT TIME ZONE co.timezone END,
              CASE WHEN $5::text IS NULL THEN NULL ELSE (r.work_date + $5::time) AT TIME ZONE co.timezone END, $6
         FROM attendance_records r JOIN companies co ON co.id = r.company_id WHERE r.id = $3 RETURNING id`, [u.companyId, u.id, recordId, tin, tout, reason])).rows[0];
    const admins = (await c.query("SELECT id FROM employees WHERE company_id = $1 AND role IN ('admin','manager') AND status = 'active' AND id <> $2", [u.companyId, u.id])).rows;
    for (const a of admins) await notify(c, u.companyId, a.id, `${u.name} asked for an attendance correction`, '/attendance');
    return k.id;
  });
  res.status(201).json((await db.query(C_SQL + ' AND k.id = $2', [u.companyId, id])).rows[0]);
}));

// Everyone sees their own requests and whether they were approved. Admins and managers can pass ?scope=all&status=pending.
router.get('/corrections', wrap(async (req, res) => {
  const u = req.user, p = [u.companyId], w = [];
  if (!(isPriv(u) && req.query.scope === 'all')) { p.push(u.id); w.push(`k.employee_id = $${p.length}`); }
  if (req.query.status) { p.push(v.oneOf(req.query.status, ['pending', 'approved', 'rejected'], 'Status')); w.push(`k.status = $${p.length}`); }
  res.json((await db.query(C_SQL + (w.length ? ' AND ' + w.join(' AND ') : '') + ' ORDER BY k.created_at DESC LIMIT 200', p)).rows);
}));

router.post('/corrections/:id/decision', requirePriv, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Correction'), u = req.user;
  const decision = v.oneOf(req.body && req.body.decision, ['approve', 'reject'], 'Decision'), note = v.str(req.body.note, 'Note', { max: 1000, optional: true });
  await db.tx(async c => {
    const k = (await c.query(
      `SELECT k.*, e.full_name, r.work_date FROM attendance_corrections k JOIN employees e ON e.id = k.employee_id JOIN attendance_records r ON r.id = k.record_id
        WHERE k.id = $1 AND k.company_id = $2 FOR UPDATE OF k`, [id, u.companyId])).rows[0];
    if (!k) throw E.notFound('Correction not found.');
    if (k.employee_id === u.id) throw E.forbidden('You cannot decide your own correction.');
    if (k.status !== 'pending') throw E.conflict('That correction has already been decided.', 'ALREADY_DECIDED');
    const status = decision === 'approve' ? 'approved' : 'rejected';
    if (status === 'approved') {
      try {
        await c.query('UPDATE attendance_records SET clock_in = coalesce($1, clock_in), clock_out = coalesce($2, clock_out) WHERE id = $3', [k.requested_in, k.requested_out, k.record_id]);
      } catch (e) { if (e.code === '23514') throw E.bad('Those times would put clock out before clock in, so the record cannot be changed.'); throw e; }
    }
    await c.query('UPDATE attendance_corrections SET status = $1, decided_by = $2, decision_note = $3, decided_at = now() WHERE id = $4', [status, u.id, note, id]);
    await notify(c, u.companyId, k.employee_id, `Your attendance correction was ${status}${note ? ': ' + note : ''}`, '/attendance');
    await audit(c, u, 'Attendance', status === 'approved' ? 'Approved correction' : 'Rejected correction', `${k.full_name}, ${String(k.work_date.toISOString ? k.work_date.toISOString().slice(0, 10) : k.work_date)}`);
  });
  res.json({ ok: true });
}));

module.exports = router;
