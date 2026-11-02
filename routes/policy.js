// Leave policy, SLA targets, ticket rules, announcements, audit log and reports.
const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, isPriv, audit, escapeLike, notify } = require('../lib/util');
const { requireRole, requirePriv } = require('../lib/auth');

const admin = requireRole('admin');
const URG = ['Low', 'Medium', 'High', 'Critical'];
const CATS = ['Hardware Issue', 'Software/Access', 'Network/Wi-Fi', 'HR Inquiry', 'General Support'];

/* ------------------------------------------------------------ leave types */
const LT_SQL = `SELECT id, name, days_per_year AS "daysPerYear", carry_over_days AS "carryOverDays", requires_approval AS "requiresApproval",
  min_notice_days AS "minNoticeDays", certificate_after_days AS "certificateAfterDays", enabled, is_core AS "isCore" FROM leave_types WHERE company_id = $1`;

function leaveTypeBody(b, cur = {}) {
  return {
    name: b.name !== undefined ? v.str(b.name, 'Leave type name', { max: 60 }) : cur.name,
    days: b.daysPerYear !== undefined ? v.int(b.daysPerYear, 'Days a year', { min: 0, max: 366 }) : cur.days_per_year,
    carry: b.carryOverDays !== undefined ? v.int(b.carryOverDays, 'Carry-over', { min: 0, max: 366 }) : cur.carry_over_days,
    appr: b.requiresApproval !== undefined ? v.bool(b.requiresApproval) : cur.requires_approval,
    notice: b.minNoticeDays !== undefined ? v.int(b.minNoticeDays, 'Minimum notice', { min: 0, max: 365 }) : cur.min_notice_days,
    cert: b.certificateAfterDays !== undefined ? v.int(b.certificateAfterDays, 'Medical certificate after', { min: 0, max: 365 }) : cur.certificate_after_days,
    enabled: b.enabled !== undefined ? v.bool(b.enabled) : cur.enabled
  };
}

router.get('/leave-types', wrap(async (req, res) => {
  res.json((await db.query(LT_SQL + ' ORDER BY is_core DESC, name', [req.user.companyId])).rows);
}));
router.post('/leave-types', admin, wrap(async (req, res) => {
  const t = leaveTypeBody({ enabled: true, requiresApproval: true, daysPerYear: 0, carryOverDays: 0, minNoticeDays: 0, certificateAfterDays: 0, ...req.body });
  const id = await db.tx(async c => {
    const r = await c.query('INSERT INTO leave_types (company_id, name, days_per_year, carry_over_days, requires_approval, min_notice_days, certificate_after_days, enabled) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [req.user.companyId, t.name, t.days, t.carry, t.appr, t.notice, t.cert, t.enabled]);
    await audit(c, req.user, 'Leave policy', 'Added leave type', t.name);
    return r.rows[0].id;
  });
  res.status(201).json((await db.query(LT_SQL + ' AND id = $2', [req.user.companyId, id])).rows[0]);
}));
router.patch('/leave-types/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Leave type');
  await db.tx(async c => {
    const cur = (await c.query('SELECT * FROM leave_types WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, req.user.companyId])).rows[0];
    if (!cur) throw E.notFound('Leave type not found.');
    if (cur.is_core && req.body.name !== undefined && req.body.name !== cur.name) throw E.bad('Standard leave types keep their name.');
    const t = leaveTypeBody(req.body || {}, cur);
    await c.query('UPDATE leave_types SET name=$1, days_per_year=$2, carry_over_days=$3, requires_approval=$4, min_notice_days=$5, certificate_after_days=$6, enabled=$7 WHERE id=$8',
      [t.name, t.days, t.carry, t.appr, t.notice, t.cert, t.enabled, id]);
    await audit(c, req.user, 'Leave policy', 'Updated leave type', t.name);
  });
  res.json((await db.query(LT_SQL + ' AND id = $2', [req.user.companyId, id])).rows[0]);
}));
router.delete('/leave-types/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Leave type');
  await db.tx(async c => {
    const t = (await c.query('SELECT name, is_core FROM leave_types WHERE id = $1 AND company_id = $2', [id, req.user.companyId])).rows[0];
    if (!t) throw E.notFound('Leave type not found.');
    if (t.is_core) throw E.bad('Standard leave types can be turned off but not deleted.');
    if ((await c.query('SELECT 1 FROM leave_requests WHERE leave_type_id = $1 LIMIT 1', [id])).rowCount) throw E.conflict('Requests already use this leave type. Turn it off instead of deleting it.', 'IN_USE');
    await c.query('DELETE FROM leave_types WHERE id = $1', [id]);
    await audit(c, req.user, 'Leave policy', 'Deleted leave type', t.name);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ SLA targets */
router.get('/sla-targets', wrap(async (req, res) => {
  res.json((await db.query(
    `SELECT urgency, first_response_hours AS "firstResponseHours", resolution_hours AS "resolutionHours" FROM sla_targets WHERE company_id = $1
      ORDER BY array_position(ARRAY['Critical','High','Medium','Low'], urgency)`, [req.user.companyId])).rows);
}));
router.put('/sla-targets', admin, wrap(async (req, res) => {
  const list = req.body && req.body.targets;
  if (!Array.isArray(list) || !list.length || list.length > 4) throw E.bad('Send the targets to change.');
  await db.tx(async c => {
    for (const t of list) {
      const u = v.oneOf(t.urgency, URG, 'Urgency'), f = v.int(t.firstResponseHours, 'First response hours', { min: 1, max: 2000 }), r = v.int(t.resolutionHours, 'Resolution hours', { min: 1, max: 5000 });
      if (r < f) throw E.bad('Resolution time cannot be shorter than the first response time.');
      await c.query('UPDATE sla_targets SET first_response_hours = $3, resolution_hours = $4 WHERE company_id = $1 AND urgency = $2', [req.user.companyId, u, f, r]);
      await audit(c, req.user, 'SLAs', 'Changed SLA', `${u}: first response ${f}h, resolution ${r}h`);
    }
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ ticket rules */
const RULE_SQL = `SELECT r.id, r.name, r.category, r.urgency, r.action, r.target_id AS "targetId", e.full_name AS "targetName", r.enabled, r.position
  FROM ticket_rules r LEFT JOIN employees e ON e.id = r.target_id WHERE r.company_id = $1`;

async function ruleBody(c, companyId, b) {
  const category = b.category ? v.oneOf(b.category, CATS, 'Category') : null;
  const urgency = b.urgency ? v.oneOf(b.urgency, URG, 'Urgency') : null;
  const action = v.oneOf(b.action, ['assign', 'notify', 'escalate'], 'Action');
  let target = null;
  if (b.targetId) {
    target = v.uuid(b.targetId, 'Person');
    if (!(await c.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND status = 'active'", [target, companyId])).rowCount) throw E.bad('Choose an active person in your company.');
  }
  return { name: v.str(b.name, 'Rule name', { max: 100 }), category, urgency, action, target, enabled: b.enabled === undefined ? true : v.bool(b.enabled) };
}
router.get('/ticket-rules', requirePriv, wrap(async (req, res) => {
  res.json((await db.query(RULE_SQL + ' ORDER BY r.position, r.name', [req.user.companyId])).rows);
}));
router.post('/ticket-rules', admin, wrap(async (req, res) => {
  const id = await db.tx(async c => {
    const r = await ruleBody(c, req.user.companyId, req.body || {});
    const pos = (await c.query('SELECT coalesce(max(position), 0) + 1 AS p FROM ticket_rules WHERE company_id = $1', [req.user.companyId])).rows[0].p;
    const out = await c.query('INSERT INTO ticket_rules (company_id, name, category, urgency, action, target_id, enabled, position) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id',
      [req.user.companyId, r.name, r.category, r.urgency, r.action, r.target, r.enabled, pos]);
    await audit(c, req.user, 'SLAs', 'Created ticket rule', r.name);
    return out.rows[0].id;
  });
  res.status(201).json((await db.query(RULE_SQL + ' AND r.id = $2', [req.user.companyId, id])).rows[0]);
}));
router.patch('/ticket-rules/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Rule');
  await db.tx(async c => {
    const cur = (await c.query('SELECT * FROM ticket_rules WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, req.user.companyId])).rows[0];
    if (!cur) throw E.notFound('Rule not found.');
    const b = req.body || {};
    const r = await ruleBody(c, req.user.companyId, {
      name: b.name !== undefined ? b.name : cur.name, category: b.category !== undefined ? b.category : cur.category, urgency: b.urgency !== undefined ? b.urgency : cur.urgency,
      action: b.action !== undefined ? b.action : cur.action, targetId: b.targetId !== undefined ? b.targetId : cur.target_id, enabled: b.enabled !== undefined ? b.enabled : cur.enabled
    });
    await c.query('UPDATE ticket_rules SET name=$1, category=$2, urgency=$3, action=$4, target_id=$5, enabled=$6 WHERE id=$7', [r.name, r.category, r.urgency, r.action, r.target, r.enabled, id]);
    await audit(c, req.user, 'SLAs', b.enabled !== undefined && Object.keys(b).length === 1 ? `Turned rule ${r.enabled ? 'on' : 'off'}` : 'Edited ticket rule', r.name);
  });
  res.json((await db.query(RULE_SQL + ' AND r.id = $2', [req.user.companyId, id])).rows[0]);
}));
router.delete('/ticket-rules/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Rule');
  await db.tx(async c => {
    const r = await c.query('DELETE FROM ticket_rules WHERE id = $1 AND company_id = $2 RETURNING name', [id, req.user.companyId]);
    if (!r.rowCount) throw E.notFound('Rule not found.');
    await audit(c, req.user, 'SLAs', 'Deleted ticket rule', r.rows[0].name);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ announcements */
const ANN_SQL = `SELECT a.id, a.title, a.body, a.audience_department_id AS "audienceDepartmentId", coalesce(d.name, 'Everyone') AS audience, a.pinned, a.status,
  a.published_on AS "publishedOn", a.expires_on AS "expiresOn", p.full_name AS "createdBy"
  FROM announcements a LEFT JOIN departments d ON d.id = a.audience_department_id LEFT JOIN employees p ON p.id = a.created_by WHERE a.company_id = $1`;

// People see published, unexpired announcements for everyone or their own department. Admins and managers can add ?all=1 to see drafts too.
router.get('/announcements', wrap(async (req, res) => {
  const all = isPriv(req.user) && req.query.all === '1';
  const sql = ANN_SQL + (all ? '' : ` AND a.status = 'published' AND (a.expires_on IS NULL OR a.expires_on >= (now() AT TIME ZONE (SELECT timezone FROM companies WHERE id = $1))::date)
    AND (a.audience_department_id IS NULL OR a.audience_department_id = $2)`) + ' ORDER BY a.pinned DESC, a.published_on DESC NULLS LAST, a.created_at DESC';
  res.json((await db.query(sql, all ? [req.user.companyId] : [req.user.companyId, req.user.departmentId])).rows);
}));

async function annBody(c, companyId, b, cur = {}) {
  const status = b.status !== undefined ? v.oneOf(b.status, ['draft', 'published'], 'Status') : cur.status || 'published';
  const pinned = b.pinned !== undefined ? v.bool(b.pinned) : !!cur.pinned;
  if (pinned && status !== 'published') throw E.bad('Only a published announcement can be pinned.');
  let aud = b.audienceDepartmentId !== undefined ? b.audienceDepartmentId : cur.audience_department_id || null;
  if (aud) { v.uuid(aud, 'Audience'); if (!(await c.query('SELECT 1 FROM departments WHERE id = $1 AND company_id = $2', [aud, companyId])).rowCount) throw E.bad('That department does not exist.'); }
  return {
    title: b.title !== undefined ? v.str(b.title, 'Title', { max: 150 }) : cur.title,
    body: b.body !== undefined ? v.str(b.body, 'Message', { max: 4000 }) : cur.body,
    status, pinned, aud: aud || null,
    expires: b.expiresOn !== undefined ? (b.expiresOn ? v.date(b.expiresOn, 'Expiry date') : null) : cur.expires_on || null
  };
}
router.post('/announcements', admin, wrap(async (req, res) => {
  const id = await db.tx(async c => {
    const a = await annBody(c, req.user.companyId, { status: 'published', ...req.body });
    if (a.pinned) await c.query('UPDATE announcements SET pinned = false WHERE company_id = $1 AND pinned', [req.user.companyId]);
    const r = await c.query(`INSERT INTO announcements (company_id, title, body, audience_department_id, pinned, status, published_on, expires_on, created_by)
      VALUES ($1,$2,$3,$4,$5,$6, CASE WHEN $6 = 'published' THEN current_date END, $7, $8) RETURNING id`,
      [req.user.companyId, a.title, a.body, a.aud, a.pinned, a.status, a.expires, req.user.id]);
    if (a.status === 'published') {
      const recipients = (await c.query(
        `SELECT id FROM employees WHERE company_id = $1 AND status = 'active' AND id <> $3
          AND ($2::uuid IS NULL OR department_id = $2)`,
        [req.user.companyId, a.aud, req.user.id]
      )).rows;
      for (const recipient of recipients) {
        await notify(c, req.user.companyId, recipient.id, `New announcement: ${a.title}`, '/home.html#announcements');
      }
    }
    await audit(c, req.user, 'Announcements', a.status === 'published' ? 'Published announcement' : 'Saved draft', a.title);
    return r.rows[0].id;
  });
  res.status(201).json((await db.query(ANN_SQL + ' AND a.id = $2', [req.user.companyId, id])).rows[0]);
}));
router.patch('/announcements/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Announcement');
  await db.tx(async c => {
    const cur = (await c.query('SELECT * FROM announcements WHERE id = $1 AND company_id = $2 FOR UPDATE', [id, req.user.companyId])).rows[0];
    if (!cur) throw E.notFound('Announcement not found.');
    const b = req.body || {};
    if (b.status === 'draft' && b.pinned === undefined) b.pinned = false;      // unpublishing also unpins
    const a = await annBody(c, req.user.companyId, b, cur);
    if (a.pinned && !cur.pinned) await c.query('UPDATE announcements SET pinned = false WHERE company_id = $1 AND pinned', [req.user.companyId]);
    await c.query(`UPDATE announcements SET title=$1, body=$2, audience_department_id=$3, pinned=$4, status=$5, expires_on=$6,
      published_on = CASE WHEN $5 = 'published' AND published_on IS NULL THEN current_date ELSE published_on END WHERE id = $7`,
      [a.title, a.body, a.aud, a.pinned, a.status, a.expires, id]);
    if (cur.status !== 'published' && a.status === 'published') {
      const recipients = (await c.query(
        `SELECT id FROM employees WHERE company_id = $1 AND status = 'active' AND id <> $3
          AND ($2::uuid IS NULL OR department_id = $2)`,
        [req.user.companyId, a.aud, req.user.id]
      )).rows;
      for (const recipient of recipients) {
        await notify(c, req.user.companyId, recipient.id, `New announcement: ${a.title}`, '/home.html#announcements');
      }
    }
    await audit(c, req.user, 'Announcements', a.pinned !== cur.pinned ? (a.pinned ? 'Pinned announcement' : 'Unpinned announcement') : a.status !== cur.status ? (a.status === 'published' ? 'Published announcement' : 'Unpublished announcement') : 'Edited announcement', a.title);
  });
  res.json((await db.query(ANN_SQL + ' AND a.id = $2', [req.user.companyId, id])).rows[0]);
}));
router.delete('/announcements/:id', admin, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Announcement');
  await db.tx(async c => {
    const r = await c.query('DELETE FROM announcements WHERE id = $1 AND company_id = $2 RETURNING title', [id, req.user.companyId]);
    if (!r.rowCount) throw E.notFound('Announcement not found.');
    await audit(c, req.user, 'Announcements', 'Deleted announcement', r.rows[0].title);
  });
  res.json({ ok: true });
}));

/* ------------------------------------------------------------ audit log (read only) */
router.get('/audit', requirePriv, wrap(async (req, res) => {
  const p = [req.user.companyId], w = ['company_id = $1'], q = req.query;
  if (q.category) { p.push(v.str(q.category, 'Category', { max: 40 })); w.push(`category = $${p.length}`); }
  if (q.q) { p.push('%' + escapeLike(v.str(q.q, 'Search', { max: 100 })) + '%'); w.push(`(actor_name ILIKE $${p.length} OR action ILIKE $${p.length} OR details ILIKE $${p.length})`); }
  if (q.before) { p.push(v.int(q.before, 'Before', { min: 1, max: 9e15 })); w.push(`id < $${p.length}`); }
  p.push(Math.min(Number(q.limit) || 100, 200));
  const rows = (await db.query(`SELECT id, actor_name AS "actorName", category, action, details, created_at AS "createdAt" FROM audit_log WHERE ${w.join(' AND ')} ORDER BY id DESC LIMIT $${p.length}`, p)).rows;
  res.json(rows);
}));

/* ------------------------------------------------------------ reports (admins and managers) */
const REPORTS = {
  headcount: `SELECT d.name AS department,
      count(*) FILTER (WHERE e.status = 'active')::int AS people, count(*) FILTER (WHERE e.role = 'manager' AND e.status = 'active')::int AS managers,
      count(*) FILTER (WHERE e.role = 'admin' AND e.status = 'active')::int AS admins, count(*) FILTER (WHERE e.status = 'invited')::int AS invited
    FROM departments d LEFT JOIN employees e ON e.department_id = d.id WHERE d.company_id = $1 GROUP BY d.name ORDER BY d.name`,
  'leave-summary': `SELECT e.full_name AS employee, lt.name AS "leaveType", sum(lr.days)::float AS days
    FROM leave_requests lr JOIN employees e ON e.id = lr.employee_id JOIN leave_types lt ON lt.id = lr.leave_type_id
    WHERE lr.company_id = $1 AND lr.status = 'approved' AND lr.start_date >= date_trunc('year', now())::date GROUP BY e.full_name, lt.name ORDER BY e.full_name, lt.name`,
  'ticket-sla': `SELECT s.urgency, count(t.id)::int AS tickets, count(t.id) FILTER (WHERE t.status NOT IN ('Resolved','Closed'))::int AS open,
      count(t.id) FILTER (WHERE t.status IN ('Resolved','Closed'))::int AS "resolvedOrClosed",
      round(100.0 * count(t.id) FILTER (WHERE t.first_response_at IS NOT NULL AND t.first_response_at <= t.first_response_due) / NULLIF(count(t.id) FILTER (WHERE t.first_response_at IS NOT NULL), 0))::int AS "firstResponseMetPercent",
      round(100.0 * count(t.id) FILTER (WHERE t.resolved_at IS NOT NULL AND t.resolved_at <= t.resolution_due) / NULLIF(count(t.id) FILTER (WHERE t.resolved_at IS NOT NULL), 0))::int AS "resolutionMetPercent",
      s.first_response_hours AS "firstResponseTargetHours", s.resolution_hours AS "resolutionTargetHours"
    FROM sla_targets s LEFT JOIN tickets t ON t.company_id = s.company_id AND t.urgency = s.urgency WHERE s.company_id = $1
    GROUP BY s.urgency, s.first_response_hours, s.resolution_hours ORDER BY array_position(ARRAY['Critical','High','Medium','Low'], s.urgency)`,
  attendance: `SELECT e.full_name AS employee, count(*)::int AS days,
      round(sum(GREATEST(0, extract(epoch FROM (coalesce(r.clock_out, now()) - r.clock_in)) / 60 - r.break_minutes)) / 60.0, 1)::float AS hours,
      round(sum(GREATEST(0, extract(epoch FROM (coalesce(r.clock_out, now()) - r.clock_in)) / 60 - r.break_minutes - 480)) / 60.0, 1)::float AS "overtimeHours",
      count(*) FILTER (WHERE (r.clock_in AT TIME ZONE c.timezone)::time > time '08:05')::int AS "lateArrivals",
      round(100.0 * count(*) FILTER (WHERE (r.clock_in AT TIME ZONE c.timezone)::time <= time '08:05') / count(*))::int AS "punctualityPercent"
    FROM attendance_records r JOIN employees e ON e.id = r.employee_id JOIN companies c ON c.id = r.company_id
    WHERE r.company_id = $1 AND r.work_date >= date_trunc('month', now() AT TIME ZONE c.timezone)::date GROUP BY e.full_name ORDER BY e.full_name`
};
router.get('/reports/:name', requirePriv, wrap(async (req, res) => {
  const sql = REPORTS[req.params.name];
  if (!sql) throw E.notFound('Unknown report.');
  res.json({ report: req.params.name, generatedAt: new Date().toISOString(), rows: (await db.query(sql, [req.user.companyId])).rows });
}));

module.exports = router;
