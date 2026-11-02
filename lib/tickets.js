// Ticket logic shared by the tickets routes, leave requests and the "contact admin" form.
const { E, notify } = require('./util');

// Adds working hours (Monday to Friday, 08:00 to 17:00 in the company's time zone) to a date.
function addBusinessHours(start, hours, tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', hour: '2-digit', hourCycle: 'h23' });
  let d = new Date(start), left = hours, guard = 0;
  while (left > 0 && guard++ < 24 * 120) {
    d = new Date(d.getTime() + 3600e3);
    const p = Object.fromEntries(fmt.formatToParts(d).map(x => [x.type, x.value]));
    const h = Number(p.hour);
    if (p.weekday !== 'Sat' && p.weekday !== 'Sun' && h > 8 && h <= 17) left--;
  }
  return d;
}

async function addEvent(c, ticketId, companyId, actor, kind, body) {
  await c.query(
    'INSERT INTO ticket_events (ticket_id, company_id, actor_id, actor_label, kind, body) VALUES ($1,$2,$3,$4,$5,$6)',
    [ticketId, companyId, actor.id || null, actor.name, kind, body]
  );
}

// Only active people from the same company can be assigned.
async function checkAssignees(c, companyId, ids) {
  if (!ids.length) return [];
  const r = await c.query("SELECT id, full_name FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'", [companyId, ids]);
  if (r.rowCount !== ids.length) throw E.bad('You can only send tickets to active people in your company.');
  return r.rows;
}

// Creates one ticket with SLA due times, assignees, a "created" event and notifications. Returns { id, number }.
async function insertTicket(c, u, d, parentId = null) {
  const co = (await c.query('SELECT timezone, sla_business_hours FROM companies WHERE id = $1', [u.companyId])).rows[0];
  const sla = (await c.query('SELECT first_response_hours AS f, resolution_hours AS r FROM sla_targets WHERE company_id = $1 AND urgency = $2', [u.companyId, d.urgency])).rows[0];
  const now = new Date();
  const due = h => (co.sla_business_hours ? addBusinessHours(now, h, co.timezone) : new Date(now.getTime() + h * 3600e3));
  const number = (await c.query('SELECT next_ticket_no($1) AS n', [u.companyId])).rows[0].n;
  const t = (await c.query(
    `INSERT INTO tickets (company_id, number, subject, description, category, urgency, submitted_by, parent_id, first_response_due, resolution_due)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, number`,
    [u.companyId, number, d.subject, d.description || '', d.category, d.urgency, d.submittedBy || u.id, parentId, sla ? due(sla.f) : null, sla ? due(sla.r) : null]
  )).rows[0];
  const people = await checkAssignees(c, u.companyId, d.assigneeIds || []);
  for (const p of people) {
    await c.query('INSERT INTO ticket_assignees (ticket_id, employee_id, company_id) VALUES ($1,$2,$3)', [t.id, p.id, u.companyId]);
    if (d.notifyAssignees !== false && p.id !== u.id) {
      await notify(c, u.companyId, p.id, `Ticket #${t.number} was assigned to you: ${d.subject}`, `/tickets.html?ticket=${t.id}`);
    }
  }
  if (d.notifyAll !== false) {
    const all = (await c.query(
      `SELECT e.id FROM employees e JOIN employee_preferences p ON p.employee_id = e.id
        WHERE e.company_id = $1 AND e.status = 'active' AND p.prefs->>'ticketNotifications' = 'all'`,
      [u.companyId]
    )).rows;
    const assigned = new Set(people.map(person => person.id));
    for (const person of all) {
      if (!assigned.has(person.id)) await notify(c, u.companyId, person.id, `New ticket #${t.number}: ${d.subject}`, `/tickets.html?ticket=${t.id}`);
    }
  }
  await addEvent(c, t.id, u.companyId, u, 'created', d.createdNote || 'created this ticket');
  return t;
}

// Runs the company's ticket rules (top to bottom) on a new ticket.
async function applyRules(c, u, ticket, d) {
  const rules = (await c.query(
    `SELECT r.name, r.action, r.target_id, e.full_name AS target_name
       FROM ticket_rules r LEFT JOIN employees e ON e.id = r.target_id AND e.status = 'active'
      WHERE r.company_id = $1 AND r.enabled AND (r.category IS NULL OR r.category = $2) AND (r.urgency IS NULL OR r.urgency = $3)
      ORDER BY r.position, r.name`,
    [u.companyId, d.category, d.urgency]
  )).rows;
  for (const r of rules) {
    if (!r.target_id || !r.target_name) continue;
    const has = (await c.query('SELECT 1 FROM ticket_assignees WHERE ticket_id = $1 AND employee_id = $2', [ticket.id, r.target_id])).rowCount > 0;
    const anyone = (await c.query('SELECT 1 FROM ticket_assignees WHERE ticket_id = $1', [ticket.id])).rowCount > 0;
    if (r.action === 'assign' && !anyone) {
      await c.query('INSERT INTO ticket_assignees (ticket_id, employee_id, company_id) VALUES ($1,$2,$3)', [ticket.id, r.target_id, u.companyId]);
      await addEvent(c, ticket.id, u.companyId, { name: 'Ticket rules' }, 'rule', `Rule "${r.name}": assigned to ${r.target_name}`);
      const prefs = (await c.query("SELECT prefs->>'ticketNotifications' AS scope FROM employee_preferences WHERE employee_id = $1", [r.target_id])).rows[0];
      if (!prefs || prefs.scope !== 'all') await notify(c, u.companyId, r.target_id, `Ticket #${ticket.number} was assigned to you: ${d.subject}`, `/tickets.html?ticket=${ticket.id}`);
    } else if (r.action === 'escalate' && !has) {
      await c.query('INSERT INTO ticket_assignees (ticket_id, employee_id, company_id) VALUES ($1,$2,$3)', [ticket.id, r.target_id, u.companyId]);
      await addEvent(c, ticket.id, u.companyId, { name: 'Ticket rules' }, 'rule', `Rule "${r.name}": escalated to ${r.target_name}`);
      const prefs = (await c.query("SELECT prefs->>'ticketNotifications' AS scope FROM employee_preferences WHERE employee_id = $1", [r.target_id])).rows[0];
      if (!prefs || prefs.scope !== 'all') await notify(c, u.companyId, r.target_id, `Escalated ticket #${ticket.number}: ${d.subject}`, `/tickets.html?ticket=${ticket.id}`);
    } else if (r.action === 'notify') {
      await addEvent(c, ticket.id, u.companyId, { name: 'Ticket rules' }, 'rule', `Rule "${r.name}": ${r.target_name} was notified`);
      const prefs = (await c.query("SELECT prefs->>'ticketNotifications' AS scope FROM employee_preferences WHERE employee_id = $1", [r.target_id])).rows[0];
      if (!prefs || prefs.scope !== 'all') await notify(c, u.companyId, r.target_id, `New ticket #${ticket.number}: ${d.subject}`, `/tickets.html?ticket=${ticket.id}`);
    }
  }
}

// A parent ticket follows its sub-tickets: all done means resolved, any movement means in progress.
async function recomputeParent(c, companyId, parentId) {
  if (!parentId) return;
  const kids = (await c.query('SELECT status FROM tickets WHERE parent_id = $1', [parentId])).rows.map(r => r.status);
  const parent = (await c.query('SELECT id, status FROM tickets WHERE id = $1 AND company_id = $2', [parentId, companyId])).rows[0];
  if (!kids.length || !parent) return;
  const done = kids.every(s => s === 'Resolved' || s === 'Closed');
  const next = done ? 'Resolved' : kids.some(s => s !== 'Open') ? 'In Progress' : parent.status;
  if (next !== parent.status && parent.status !== 'Closed') {
    await c.query("UPDATE tickets SET status = $1, resolved_at = CASE WHEN $1 = 'Resolved' THEN now() ELSE NULL END WHERE id = $2", [next, parentId]);
    await addEvent(c, parentId, companyId, { name: 'Sub-tickets' }, 'status', `Status moved to ${next} because of its sub-tickets`);
  }
}

module.exports = { addBusinessHours, addEvent, checkAssignees, insertTicket, applyRules, recomputeParent };
