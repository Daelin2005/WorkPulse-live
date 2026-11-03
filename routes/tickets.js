const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, isPriv, audit, notify, escapeLike } = require('../lib/util');
const { addEvent, checkAssignees, insertTicket, applyRules, recomputeParent } = require('../lib/tickets');

const CATS = ['Hardware Issue', 'Software/Access', 'Network/Wi-Fi', 'HR Inquiry', 'General Support'];
const URG = ['Low', 'Medium', 'High', 'Critical'];
const STAT = ['Open', 'Pending Response', 'In Progress', 'Resolved', 'Closed'];
const DONE = ['Resolved', 'Closed'];

// Who can see a ticket: admins and managers see everything. Everyone else sees tickets they sent or are assigned to.
// People in a ticket-handling department (IT) also see the unassigned queue.
const visible = (u, uid = '$2') => (isPriv(u) ? `(${uid}::uuid IS NOT NULL)`
  : `(t.submitted_by = ${uid} OR EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id = t.id AND ta.employee_id = ${uid})`
    + (u.handlesTickets ? ' OR NOT EXISTS (SELECT 1 FROM ticket_assignees tb WHERE tb.ticket_id = t.id)' : '') + ')');

const T_COLS = `t.id, t.number, t.subject, t.description, t.category, t.urgency, t.status, t.parent_id AS "parentId",
  t.created_at AS "createdAt", t.updated_at AS "updatedAt", t.first_response_due AS "firstResponseDue", t.resolution_due AS "resolutionDue",
  t.first_response_at AS "firstResponseAt", t.resolved_at AS "resolvedAt", s.id AS "submittedById", s.full_name AS "submittedBy",
  coalesce((SELECT json_agg(json_build_object('id', x.id, 'name', x.full_name) ORDER BY x.full_name)
            FROM ticket_assignees ta JOIN employees x ON x.id = ta.employee_id WHERE ta.ticket_id = t.id), '[]') AS assignees,
  (SELECT count(*)::int FROM tickets k WHERE k.parent_id = t.id) AS "subTicketCount",
  (SELECT number FROM tickets pt WHERE pt.id = t.parent_id) AS "parentNumber"`;
const T_FROM = 'FROM tickets t JOIN employees s ON s.id = t.submitted_by';

// $1 = company, $2 = the signed-in person
router.get('/', wrap(async (req, res) => {
  const u = req.user, q = req.query, p = [u.companyId, u.id], w = ['t.company_id = $1', visible(u)];
  const add = (sql, val) => { p.push(val); w.push(sql.replace('?', `$${p.length}`)); };
  if (q.status) add('t.status = ?', v.oneOf(q.status, STAT, 'Status'));
  if (q.urgency) add('t.urgency = ?', v.oneOf(q.urgency, URG, 'Urgency'));
  if (q.category) add('t.category = ?', v.oneOf(q.category, CATS, 'Category'));
  if (q.scope === 'mine') w.push('EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id = t.id AND ta.employee_id = $2)');
  if (q.scope === 'sent') w.push('t.submitted_by = $2');
  if (q.q) {
    const text = v.str(q.q, 'Search', { max: 100 });
    if (/^#?\d{1,9}$/.test(text)) add('t.number = ?', Number(text.replace('#', '')));
    else { p.push('%' + escapeLike(text) + '%'); w.push(`(t.subject ILIKE $${p.length} OR t.description ILIKE $${p.length} OR s.full_name ILIKE $${p.length})`); }
  }
  const limit = Math.min(Number(q.limit) || 100, 200), offset = Math.max(Number(q.offset) || 0, 0);
  p.push(limit, offset);
  const rows = (await db.query(`SELECT ${T_COLS} ${T_FROM} WHERE ${w.join(' AND ')} ORDER BY coalesce(t.parent_id, t.id) DESC, t.number LIMIT $${p.length - 1} OFFSET $${p.length}`, p)).rows;
  res.json(rows);
}));

// The numbers on the dashboard's ticket overview.
router.get('/stats', wrap(async (req, res) => {
  const u = req.user;
  const r = (await db.query(
    `SELECT count(*) FILTER (WHERE t.status = 'Open')::int AS open,
            count(*) FILTER (WHERE t.status = 'Pending Response')::int AS "pendingResponse",
            count(*) FILTER (WHERE t.status = 'In Progress')::int AS "inProgress",
            count(*) FILTER (WHERE t.status = 'Resolved')::int AS resolved,
            count(*) FILTER (WHERE t.urgency IN ('High','Critical') AND t.status NOT IN ('Resolved','Closed'))::int AS urgent,
            count(*) FILTER (WHERE t.status NOT IN ('Resolved','Closed') AND EXISTS (SELECT 1 FROM ticket_assignees ta WHERE ta.ticket_id = t.id AND ta.employee_id = $2))::int AS mine,
            count(*) FILTER (WHERE t.status NOT IN ('Resolved','Closed') AND NOT EXISTS (SELECT 1 FROM ticket_assignees tb WHERE tb.ticket_id = t.id))::int AS unassigned,
            count(*)::int AS total
       FROM tickets t WHERE t.company_id = $1 AND ${visible(u)}`, [u.companyId, u.id])).rows[0];
  res.json(r);
}));

async function loadVisible(c, u, id) {
  const t = (await c.query(`SELECT ${T_COLS} ${T_FROM} WHERE t.id = $3 AND t.company_id = $1 AND ${visible(u)}`, [u.companyId, u.id, id])).rows[0];
  if (!t) throw E.notFound('Ticket not found.');
  return t;
}

router.get('/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Ticket');
  const t = await loadVisible(db, req.user, id);
  const events = (await db.query('SELECT id, actor_label AS "actor", kind, body, created_at AS "createdAt" FROM ticket_events WHERE ticket_id = $1 ORDER BY created_at, id', [id])).rows;
  const subTickets = (await db.query(
    `SELECT t.id, t.number, t.subject, t.status, t.urgency,
            coalesce((SELECT json_agg(json_build_object('id', x.id, 'name', x.full_name)) FROM ticket_assignees ta JOIN employees x ON x.id = ta.employee_id WHERE ta.ticket_id = t.id), '[]') AS assignees
       FROM tickets t WHERE t.parent_id = $1 AND t.company_id = $2 ORDER BY t.number`, [id, req.user.companyId])).rows;
  const parent = t.parentId ? (await db.query('SELECT id, number, subject FROM tickets WHERE id = $1', [t.parentId])).rows[0] : null;
  const attachments = (await db.query('SELECT id, filename, mime_type AS "mimeType", size_bytes AS "sizeBytes", created_at AS "createdAt" FROM ticket_attachments WHERE ticket_id = $1 ORDER BY created_at', [id])).rows;
  res.json({ ...t, events, subTickets, parent, attachments });
}));

// Create a ticket. With splitIntoSubTickets and two or more people, one parent ticket is made plus one sub-ticket per person.
router.post('/', wrap(async (req, res) => {
  const b = req.body || {}, u = req.user;
  const d = {
    subject: v.str(b.subject, 'Subject', { max: 150 }),
    description: v.str(b.description, 'Description', { max: 5000, optional: true }),
    category: v.oneOf(b.category || 'General Support', CATS, 'Category'),
    urgency: v.oneOf(b.urgency || 'Medium', URG, 'Urgency'),
    assigneeIds: v.uuidList(b.assigneeIds, 'Send to')
  };
  const split = v.bool(b.splitIntoSubTickets) && d.assigneeIds.length > 1;
  const out = await db.tx(async c => {
    if (!split) {
      const t = await insertTicket(c, u, d);
      if (!d.assigneeIds.length) await applyRules(c, u, t, d);
      return t;
    }
    const people = await checkAssignees(c, u.companyId, d.assigneeIds);
    const parent = await insertTicket(c, u, { ...d, assigneeIds: [] });
    for (const p of people) {
      await insertTicket(c, u, { ...d, subject: `${d.subject} (${p.full_name.split(' ')[0]})`, assigneeIds: [p.id] }, parent.id);
    }
    await addEvent(c, parent.id, u.companyId, u, 'system', `split into ${people.length} sub-tickets`);
    return parent;
  });
  res.status(201).json(await loadVisible(db, u, out.id));
}));

// Change status, urgency, assignees, subject or description.
router.patch('/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Ticket'), u = req.user, b = req.body || {};
  const updates = [];
  await db.tx(async c => {
    const t = await loadVisible(c, u, id);
    const assigned = t.assignees.some(a => a.id === u.id);
    const handler = isPriv(u) || assigned || (u.handlesTickets && !t.assignees.length);
    if (b.status !== undefined) {
      const status = v.oneOf(b.status, STAT, 'Status');
      if (!handler && !(t.submittedById === u.id && status === 'Closed')) throw E.forbidden('Only the people working on this ticket can change its status.');
      if (status !== t.status) {
        await c.query(
          `UPDATE tickets SET status = $1, resolved_at = CASE WHEN $1 IN ('Resolved','Closed') THEN coalesce(resolved_at, now()) ELSE NULL END,
                  first_response_at = CASE WHEN $3 AND first_response_at IS NULL THEN now() ELSE first_response_at END WHERE id = $2`,
          [status, id, t.submittedById !== u.id]);
        await addEvent(c, id, u.companyId, u, 'status', `changed the status from ${t.status} to ${status}`);
        await recomputeParent(c, u.companyId, t.parentId);
        updates.push(`status changed to ${status}`);
        if (DONE.includes(status)) await audit(c, u, 'Tickets', `Ticket ${status.toLowerCase()}`, `#${t.number} ${t.subject}`);
      }
    }
    if (b.urgency !== undefined || b.subject !== undefined || b.description !== undefined || b.category !== undefined) {
      if (!handler) throw E.forbidden('Only the people working on this ticket can edit it.');
      const urgency = b.urgency !== undefined ? v.oneOf(b.urgency, URG, 'Urgency') : t.urgency;
      const subject = b.subject !== undefined ? v.str(b.subject, 'Subject', { max: 150 }) : t.subject;
      const description = b.description !== undefined ? v.str(b.description, 'Description', { max: 5000, optional: true }) : t.description;
      const category = b.category !== undefined ? v.oneOf(b.category, CATS, 'Category') : t.category;
      await c.query('UPDATE tickets SET urgency = $1, subject = $2, description = $3, category = $4 WHERE id = $5',
        [urgency, subject, description, category, id]);
      if (urgency !== t.urgency) await addEvent(c, id, u.companyId, u, 'system', `changed the urgency from ${t.urgency} to ${urgency}`);
      if (category !== t.category) await addEvent(c, id, u.companyId, u, 'system', `changed the category from ${t.category} to ${category}`);
      if (subject !== t.subject || description !== t.description) await addEvent(c, id, u.companyId, u, 'system', 'edited the ticket details');
      if (urgency !== t.urgency || category !== t.category || subject !== t.subject || description !== t.description) {
        updates.push('details were updated');
      }
    }
    if (b.assigneeIds !== undefined) {
      if (!(isPriv(u) || assigned || u.handlesTickets)) throw E.forbidden('Only the people working on this ticket can change who it is assigned to.');
      const want = v.uuidList(b.assigneeIds, 'Assigned to'), people = await checkAssignees(c, u.companyId, want), have = t.assignees.map(a => a.id);
      const changed = want.length !== have.length || want.some(employeeId => !have.includes(employeeId));
      if (assigned && !isPriv(u) && t.submittedById !== u.id && !want.includes(u.id)) {
        throw E.forbidden('Ask an admin or manager to transfer a ticket away from your account.');
      }
      for (const p of people.filter(p => !have.includes(p.id))) {
        await c.query('INSERT INTO ticket_assignees (ticket_id, employee_id, company_id) VALUES ($1,$2,$3)', [id, p.id, u.companyId]);
        await addEvent(c, id, u.companyId, u, 'assignment', `assigned this to ${p.full_name}`);
        if (p.id !== u.id) await notify(c, u.companyId, p.id, `Ticket #${t.number} was assigned to you: ${t.subject}`, `/tickets.html?ticket=${id}`);
      }
      for (const a of t.assignees.filter(a => !want.includes(a.id))) {
        await c.query('DELETE FROM ticket_assignees WHERE ticket_id = $1 AND employee_id = $2', [id, a.id]);
        await addEvent(c, id, u.companyId, u, 'assignment', `removed ${a.name} from this ticket`);
      }
      if (changed) updates.push('assignees were updated');
    }
    if (updates.length) {
      const participants = new Set([t.submittedById, ...t.assignees.map(a => a.id)]);
      for (const employeeId of participants) {
        if (employeeId !== u.id) {
          await notify(c, u.companyId, employeeId,
            `Ticket #${t.number} ${updates.join(' and ')}: ${t.subject}`, `/tickets.html?ticket=${id}`);
        }
      }
    }
  });
  res.json(await loadVisible(db, u, id));
}));

router.delete('/:id', wrap(async (req, res) => {
  if (req.user.role !== 'admin') throw E.forbidden('Only a company admin can delete tickets.');
  const id = v.uuid(req.params.id, 'Ticket'), u = req.user;
  await db.tx(async c => {
    const ticket = (await c.query(
      'SELECT number, subject FROM tickets WHERE id = $1 AND company_id = $2 FOR UPDATE',
      [id, u.companyId]
    )).rows[0];
    if (!ticket) throw E.notFound('Ticket not found.');
    await audit(c, u, 'Tickets', 'Deleted ticket', `#${ticket.number} ${ticket.subject}`);
    await c.query('DELETE FROM tickets WHERE id = $1 AND company_id = $2', [id, u.companyId]);
  });
  res.json({ ok: true });
}));

router.post('/:id/comments', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Ticket'), u = req.user;
  const body = v.str(req.body && req.body.body, 'Message', { max: 4000 });
  await db.tx(async c => {
    const t = await loadVisible(c, u, id);
    await addEvent(c, id, u.companyId, u, 'comment', body);
    const fromSender = t.submittedById === u.id;
    if (!fromSender) await c.query('UPDATE tickets SET first_response_at = coalesce(first_response_at, now()) WHERE id = $1', [id]);
    if (fromSender && t.status === 'Pending Response') {
      await c.query("UPDATE tickets SET status = 'In Progress' WHERE id = $1", [id]);
      await addEvent(c, id, u.companyId, u, 'status', 'replied, so the ticket is back to In Progress');
    }
    const others = fromSender ? t.assignees.map(a => a.id) : [t.submittedById, ...t.assignees.map(a => a.id)];
    for (const o of new Set(others)) if (o !== u.id) await notify(c, u.companyId, o, `${u.name} replied on ticket #${t.number}`, `/tickets.html?ticket=${id}`);
  });
  res.status(201).json({ ok: true });
}));

// Add a sub-ticket to a big ticket, for one more person.
router.post('/:id/subtickets', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Ticket'), u = req.user, b = req.body || {};
  const out = await db.tx(async c => {
    const t = await loadVisible(c, u, id);
    if (t.parentId) throw E.bad('A sub-ticket cannot have its own sub-tickets.');
    const assigned = t.assignees.some(a => a.id === u.id);
    if (!(isPriv(u) || assigned || t.submittedById === u.id || u.handlesTickets)) throw E.forbidden();
    const sub = await insertTicket(c, u, {
      subject: v.str(b.subject, 'Subject', { max: 150 }), description: v.str(b.description, 'Description', { max: 5000, optional: true }) || `Part of #${t.number}: ${t.subject}`,
      category: t.category, urgency: t.urgency, assigneeIds: b.assigneeId ? [v.uuid(b.assigneeId, 'Person')] : []
    }, id);
    await addEvent(c, id, u.companyId, u, 'system', `added sub-ticket #${sub.number}`);
    await recomputeParent(c, u.companyId, id);
    return sub;
  });
  res.status(201).json(await loadVisible(db, u, out.id));
}));

module.exports = router;
