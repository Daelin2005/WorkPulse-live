const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, audit } = require('../lib/util');

async function member(c, companyId, groupId, employeeId) {
  const result = await c.query(
    `SELECT g.id, g.name, g.created_by AS "createdBy"
       FROM chat_groups g JOIN chat_group_members m ON m.group_id = g.id AND m.company_id = g.company_id
      WHERE g.id = $1 AND g.company_id = $2 AND m.employee_id = $3 AND m.removed_at IS NULL`,
    [groupId, companyId, employeeId]
  );
  if (!result.rowCount) throw E.notFound('Discussion group not found.');
  return result.rows[0];
}

async function addMembers(c, companyId, groupId, actorId, ids) {
  if (!ids.length) return;
  const employees = await c.query(
    "SELECT id FROM employees WHERE company_id = $1 AND id = ANY($2::uuid[]) AND status = 'active'",
    [companyId, ids]
  );
  if (employees.rowCount !== ids.length) throw E.bad('Choose active employees from your company.');
  for (const employee of employees.rows) {
    await c.query(
      `INSERT INTO chat_group_members (company_id, group_id, employee_id, added_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (group_id, employee_id) DO UPDATE SET added_by = EXCLUDED.added_by, joined_at = now(), removed_at = NULL`,
      [companyId, groupId, employee.id, actorId]
    );
  }
}

router.post('/direct/:employeeId', wrap(async (req, res) => {
  const peerId = v.uuid(req.params.employeeId, 'Employee');
  if (peerId === req.user.id) throw E.bad('Choose another coworker to start a direct chat.');
  const direct = await db.tx(async c => {
    const peer = (await c.query(
      "SELECT id, full_name AS name FROM employees WHERE id = $1 AND company_id = $2 AND status = 'active'",
      [peerId, req.user.companyId]
    )).rows[0];
    if (!peer) throw E.notFound('Coworker not found.');
    const directKey = [req.user.id, peerId].sort().join(':');
    let group = (await c.query(
      `INSERT INTO chat_groups (company_id, name, direct_key, created_by)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (company_id, direct_key) WHERE direct_key IS NOT NULL DO NOTHING
       RETURNING id, created_by AS "createdBy"`,
      [req.user.companyId, 'Direct chat', directKey, req.user.id]
    )).rows[0];
    if (!group) {
      group = (await c.query(
        'SELECT id, created_by AS "createdBy" FROM chat_groups WHERE company_id = $1 AND direct_key = $2',
        [req.user.companyId, directKey]
      )).rows[0];
    }
    await addMembers(c, req.user.companyId, group.id, req.user.id, [req.user.id, peerId]);
    return { id: group.id, createdBy: group.createdBy, name: peer.name, peerId };
  });
  res.json(direct);
}));

router.get('/groups', wrap(async (req, res) => {
  const rows = (await db.query(
    `SELECT g.id, g.name, g.created_by AS "createdBy", g.created_at AS "createdAt",
            (SELECT count(*)::int FROM chat_group_members cm WHERE cm.group_id = g.id AND cm.removed_at IS NULL) AS "memberCount",
            last.body AS "lastMessage", last.created_at AS "lastMessageAt"
       FROM chat_groups g
       JOIN chat_group_members mine ON mine.group_id = g.id AND mine.company_id = g.company_id
         AND mine.employee_id = $2 AND mine.removed_at IS NULL
       LEFT JOIN LATERAL (
         SELECT body, created_at FROM chat_messages WHERE group_id = g.id ORDER BY created_at DESC, id DESC LIMIT 1
       ) last ON true
      WHERE g.company_id = $1 AND g.direct_key IS NULL ORDER BY last.created_at DESC NULLS LAST, g.created_at DESC`,
    [req.user.companyId, req.user.id]
  )).rows;
  res.json(rows);
}));

router.post('/groups', wrap(async (req, res) => {
  const name = v.str(req.body && req.body.name, 'Group name', { max: 80 });
  const invited = v.uuidList(req.body && req.body.memberIds, 'Members').filter(id => id !== req.user.id);
  if (!invited.length) throw E.bad('Choose at least one other employee for the group.');
  const group = await db.tx(async c => {
    const row = (await c.query(
      'INSERT INTO chat_groups (company_id, name, created_by) VALUES ($1,$2,$3) RETURNING id',
      [req.user.companyId, name, req.user.id]
    )).rows[0];
    await addMembers(c, req.user.companyId, row.id, req.user.id, [...invited, req.user.id]);
    await audit(c, req.user, 'Chat', 'Created discussion group', name);
    return row;
  });
  res.status(201).json((await db.query(
    'SELECT id, name, created_by AS "createdBy", created_at AS "createdAt" FROM chat_groups WHERE id = $1 AND company_id = $2',
    [group.id, req.user.companyId]
  )).rows[0]);
}));

router.get('/groups/:id/messages', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Group');
  await member(db, req.user.companyId, id, req.user.id);
  const rows = (await db.query(
    `SELECT id, sender_id AS "senderId", sender_name AS "senderName", body, created_at AS "createdAt"
       FROM (
         SELECT m.id, m.sender_id, e.full_name AS sender_name, m.body, m.created_at
           FROM chat_messages m JOIN employees e ON e.id = m.sender_id
          WHERE m.group_id = $1 AND m.company_id = $2
          ORDER BY m.created_at DESC, m.id DESC LIMIT 100
       ) recent ORDER BY created_at, id`,
    [id, req.user.companyId]
  )).rows;
  res.json(rows);
}));

router.post('/groups/:id/messages', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Group');
  const body = v.str(req.body && req.body.body, 'Message', { max: 4000 });
  const message = await db.tx(async c => {
    await member(c, req.user.companyId, id, req.user.id);
    return (await c.query(
      `INSERT INTO chat_messages (company_id, group_id, sender_id, body)
       VALUES ($1,$2,$3,$4) RETURNING id, sender_id AS "senderId", body, created_at AS "createdAt"`,
      [req.user.companyId, id, req.user.id, body]
    )).rows[0];
  });
  res.status(201).json({ ...message, senderName: req.user.name });
}));

router.post('/groups/:id/members', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Group');
  const ids = v.uuidList(req.body && req.body.memberIds, 'Members');
  await db.tx(async c => {
    const group = await member(c, req.user.companyId, id, req.user.id);
    if (group.createdBy !== req.user.id && req.user.role !== 'admin') throw E.forbidden('Only the group creator or a company admin can add members.');
    await addMembers(c, req.user.companyId, id, req.user.id, ids);
    if (ids.length) await audit(c, req.user, 'Chat', 'Added discussion group members', group.name);
  });
  res.json({ ok: true });
}));

router.get('/groups/:id/members', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Group');
  await member(db, req.user.companyId, id, req.user.id);
  const rows = (await db.query(
    `SELECT e.id, e.full_name AS name, e.username, e.role, d.name AS department
       FROM chat_group_members m JOIN employees e ON e.id = m.employee_id
       JOIN departments d ON d.id = e.department_id
      WHERE m.group_id = $1 AND m.company_id = $2 AND m.removed_at IS NULL
      ORDER BY e.full_name`,
    [id, req.user.companyId]
  )).rows;
  res.json(rows);
}));

module.exports = router;
