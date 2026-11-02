const router = require('express').Router();
const db = require('../lib/db');
const { E, wrap, v, isPriv, audit, escapeLike } = require('../lib/util');

const STATUS = ['In use', 'In storage', 'In repair', 'Retired', 'Lost'];
const KINDS = ['Fault', 'Damage', 'Loss or theft', 'Maintenance', 'Other'];
const SEVERITY = ['Minor', 'Major', 'Critical'];

// Anyone can look. Admins, managers and people in a ticket-handling department (IT) can add and change equipment.
const canWrite = u => isPriv(u) || u.handlesTickets;
const writer = (req, res, next) => (canWrite(req.user) ? next() : next(E.forbidden('Only admins, managers and IT can change equipment records.')));

const A_SQL = `SELECT a.id, a.asset_tag AS "assetTag", t.id AS "typeId", t.name AS type, a.model, a.serial_number AS "serialNumber", a.status,
  h.id AS "holderId", h.full_name AS holder, h.job_title AS "holderTitle", l.id AS "locationId", l.name AS location,
  a.purchased_on AS "purchasedOn", a.warranty_ends_on AS "warrantyEndsOn", a.notes, a.created_at AS "addedOn",
  (SELECT count(*)::int FROM asset_incidents i WHERE i.asset_id = a.id) AS "incidentCount",
  (SELECT count(*)::int FROM asset_incidents i WHERE i.asset_id = a.id AND i.status = 'Open') AS "openIncidents"
  FROM assets a JOIN asset_types t ON t.id = a.type_id JOIN locations l ON l.id = a.location_id LEFT JOIN employees h ON h.id = a.holder_id WHERE a.company_id = $1`;

const history = (c, companyId, assetId, actorId, event) =>
  c.query('INSERT INTO asset_history (company_id, asset_id, actor_id, event) VALUES ($1,$2,$3,$4)', [companyId, assetId, actorId, event]);

/* ------------------------------------------------------------ types and locations (people can create their own) */
router.get('/asset-types', wrap(async (req, res) => {
  res.json((await db.query('SELECT id, name, id_prefix AS "idPrefix" FROM asset_types WHERE company_id = $1 ORDER BY name', [req.user.companyId])).rows);
}));
router.post('/asset-types', writer, wrap(async (req, res) => {
  const name = v.str(req.body && req.body.name, 'Type name', { max: 60 });
  let prefix = (req.body.idPrefix ? String(req.body.idPrefix) : name.replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();
  if (!/^[A-Z0-9]{2,5}$/.test(prefix)) prefix = 'EQP';
  const row = await db.tx(async c => {
    const dup = (await c.query('SELECT id, name, id_prefix AS "idPrefix" FROM asset_types WHERE company_id = $1 AND lower(name) = lower($2)', [req.user.companyId, name])).rows[0];
    if (dup) return dup;
    const r = (await c.query('INSERT INTO asset_types (company_id, name, id_prefix) VALUES ($1,$2,$3) RETURNING id, name, id_prefix AS "idPrefix"', [req.user.companyId, name, prefix])).rows[0];
    await audit(c, req.user, 'Equipment', 'Added equipment type', name);
    return r;
  });
  res.status(201).json(row);
}));
router.get('/locations', wrap(async (req, res) => {
  res.json((await db.query('SELECT id, name FROM locations WHERE company_id = $1 ORDER BY name', [req.user.companyId])).rows);
}));
router.post('/locations', writer, wrap(async (req, res) => {
  const name = v.str(req.body && req.body.name, 'Location name', { max: 80 });
  const row = await db.tx(async c => {
    const dup = (await c.query('SELECT id, name FROM locations WHERE company_id = $1 AND lower(name) = lower($2)', [req.user.companyId, name])).rows[0];
    if (dup) return dup;
    const r = (await c.query('INSERT INTO locations (company_id, name) VALUES ($1,$2) RETURNING id, name', [req.user.companyId, name])).rows[0];
    await audit(c, req.user, 'Equipment', 'Added location', name);
    return r;
  });
  res.status(201).json(row);
}));

/* ------------------------------------------------------------ equipment */
router.get('/assets', wrap(async (req, res) => {
  const q = req.query, p = [req.user.companyId], w = [];
  const add = (sql, val) => { p.push(val); w.push(sql.replace('?', `$${p.length}`)); };
  if (q.typeId) add('a.type_id = ?', v.uuid(q.typeId, 'Type'));
  if (q.locationId) add('a.location_id = ?', v.uuid(q.locationId, 'Location'));
  if (q.holderId) add('a.holder_id = ?', v.uuid(q.holderId, 'Person'));
  if (q.status) add('a.status = ?', v.oneOf(q.status, STATUS, 'Status'));
  if (q.hasOpenIncidents === '1') w.push("EXISTS (SELECT 1 FROM asset_incidents i WHERE i.asset_id = a.id AND i.status = 'Open')");
  if (q.q) { p.push('%' + escapeLike(v.str(q.q, 'Search', { max: 100 })) + '%'); w.push(`(a.asset_tag ILIKE $${p.length} OR a.model ILIKE $${p.length} OR a.serial_number ILIKE $${p.length} OR h.full_name ILIKE $${p.length})`); }
  res.json((await db.query(A_SQL + (w.length ? ' AND ' + w.join(' AND ') : '') + ' ORDER BY a.asset_tag LIMIT 500', p)).rows);
}));

// The full view: details, every incident, and the assignment and activity history.
router.get('/assets/:id', wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Equipment'), u = req.user;
  const a = (await db.query(A_SQL + ' AND a.id = $2', [u.companyId, id])).rows[0];
  if (!a) throw E.notFound('Equipment not found.');
  const incidents = (await db.query(
    `SELECT i.id, i.kind, i.severity, i.title, i.description, i.status, i.resolution, i.occurred_on AS "occurredOn", i.resolved_at AS "resolvedAt", r.full_name AS "reportedBy"
       FROM asset_incidents i LEFT JOIN employees r ON r.id = i.reported_by WHERE i.asset_id = $1 ORDER BY i.occurred_on DESC, i.created_at DESC`, [id])).rows;
  const events = (await db.query(
    `SELECT h.id, h.event, h.created_at AS "createdAt", e.full_name AS actor FROM asset_history h LEFT JOIN employees e ON e.id = h.actor_id WHERE h.asset_id = $1 ORDER BY h.created_at DESC, h.id DESC`, [id])).rows;
  res.json({ ...a, incidents, history: events });
}));

async function refs(c, companyId, b) {
  const type = (await c.query('SELECT id, name, id_prefix FROM asset_types WHERE id = $1 AND company_id = $2', [v.uuid(b.typeId, 'Type'), companyId])).rows[0];
  if (!type) throw E.bad('That equipment type does not exist.');
  if (!(await c.query('SELECT 1 FROM locations WHERE id = $1 AND company_id = $2', [v.uuid(b.locationId, 'Location'), companyId])).rowCount) throw E.bad('That location does not exist.');
  let holder = null;
  if (b.holderId) {
    holder = v.uuid(b.holderId, 'Held by');
    if (!(await c.query("SELECT 1 FROM employees WHERE id = $1 AND company_id = $2 AND status = 'active'", [holder, companyId])).rowCount) throw E.bad('Choose an active person in your company.');
  }
  return { type, holder };
}
// next free tag like LAP-0007 for the type
async function nextTag(c, companyId, prefix) {
  await c.query('SELECT pg_advisory_xact_lock(hashtext($1))', [companyId + ':assets']);
  const r = await c.query("SELECT coalesce(max(substring(asset_tag FROM '([0-9]+)$')::int), 0) + 1 AS n FROM assets WHERE company_id = $1 AND asset_tag ~* $2", [companyId, '^' + prefix + '-[0-9]+$']);
  return `${prefix}-${String(r.rows[0].n).padStart(4, '0')}`;
}

router.post('/assets', writer, wrap(async (req, res) => {
  const b = req.body || {}, u = req.user;
  const model = v.str(b.model, 'Model', { max: 160 });
  const status = v.oneOf(b.status || (b.holderId ? 'In use' : 'In storage'), STATUS, 'Status');
  const bought = b.purchasedOn ? v.date(b.purchasedOn, 'Purchase date') : null, warranty = b.warrantyEndsOn ? v.date(b.warrantyEndsOn, 'Warranty date') : null;
  if (bought && warranty && warranty < bought) throw E.bad('The warranty cannot expire before the purchase date.');
  const id = await db.tx(async c => {
    const { type, holder } = await refs(c, u.companyId, b);
    const tag = b.assetTag ? v.str(b.assetTag, 'Asset ID', { max: 40 }) : await nextTag(c, u.companyId, type.id_prefix);   // no ID on the device: create one
    if ((await c.query('SELECT 1 FROM assets WHERE company_id = $1 AND lower(asset_tag) = lower($2)', [u.companyId, tag])).rowCount) throw E.conflict('That asset ID is already in use.', 'TAG_TAKEN');
    const a = (await c.query(
      `INSERT INTO assets (company_id, asset_tag, type_id, model, serial_number, holder_id, location_id, status, purchased_on, warranty_ends_on, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [u.companyId, tag, type.id, model, v.str(b.serialNumber, 'Serial number', { max: 80, optional: true }), holder, b.locationId, status, bought, warranty, v.str(b.notes, 'Notes', { max: 2000, optional: true })])).rows[0];
    await history(c, u.companyId, a.id, u.id, 'Added to the register');
    if (holder) await history(c, u.companyId, a.id, u.id, `Assigned to ${(await c.query('SELECT full_name FROM employees WHERE id = $1', [holder])).rows[0].full_name}`);
    await audit(c, u, 'Equipment', 'Added equipment', `${tag} ${model}`);
    return a.id;
  });
  res.status(201).json((await db.query(A_SQL + ' AND a.id = $2', [u.companyId, id])).rows[0]);
}));

router.patch('/assets/:id', writer, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Equipment'), u = req.user, b = req.body || {};
  await db.tx(async c => {
    const cur = (await c.query(
      `SELECT a.*, h.full_name AS holder_name, l.name AS loc_name FROM assets a LEFT JOIN employees h ON h.id = a.holder_id JOIN locations l ON l.id = a.location_id
        WHERE a.id = $1 AND a.company_id = $2 FOR UPDATE OF a`, [id, u.companyId])).rows[0];
    if (!cur) throw E.notFound('Equipment not found.');
    const merged = {
      typeId: b.typeId !== undefined ? b.typeId : cur.type_id, locationId: b.locationId !== undefined ? b.locationId : cur.location_id,
      holderId: b.holderId !== undefined ? b.holderId : cur.holder_id
    };
    const { type, holder } = await refs(c, u.companyId, merged);
    const tag = b.assetTag !== undefined ? v.str(b.assetTag, 'Asset ID', { max: 40 }) : cur.asset_tag;
    if (tag.toLowerCase() !== cur.asset_tag.toLowerCase() && (await c.query('SELECT 1 FROM assets WHERE company_id = $1 AND lower(asset_tag) = lower($2) AND id <> $3', [u.companyId, tag, id])).rowCount) throw E.conflict('That asset ID is already in use.', 'TAG_TAKEN');
    const status = b.status !== undefined ? v.oneOf(b.status, STATUS, 'Status') : cur.status;
    const bought = b.purchasedOn !== undefined ? (b.purchasedOn ? v.date(b.purchasedOn, 'Purchase date') : null) : cur.purchased_on;
    const warranty = b.warrantyEndsOn !== undefined ? (b.warrantyEndsOn ? v.date(b.warrantyEndsOn, 'Warranty date') : null) : cur.warranty_ends_on;
    if (bought && warranty && warranty < bought) throw E.bad('The warranty cannot expire before the purchase date.');
    await c.query(
      `UPDATE assets SET asset_tag=$1, type_id=$2, model=$3, serial_number=$4, holder_id=$5, location_id=$6, status=$7, purchased_on=$8, warranty_ends_on=$9, notes=$10 WHERE id=$11`,
      [tag, type.id, b.model !== undefined ? v.str(b.model, 'Model', { max: 160 }) : cur.model, b.serialNumber !== undefined ? v.str(b.serialNumber, 'Serial number', { max: 80, optional: true }) : cur.serial_number,
       holder, merged.locationId, status, bought, warranty, b.notes !== undefined ? v.str(b.notes, 'Notes', { max: 2000, optional: true }) : cur.notes, id]);
    const name = async pid => (pid ? (await c.query('SELECT full_name FROM employees WHERE id = $1', [pid])).rows[0].full_name : null);
    if ((holder || null) !== (cur.holder_id || null)) {
      const to = await name(holder);
      await history(c, u.companyId, id, u.id, to ? (cur.holder_name ? `Reassigned from ${cur.holder_name} to ${to}` : `Assigned to ${to}`) : `Returned by ${cur.holder_name} and now unassigned`);
    }
    if (merged.locationId !== cur.location_id) await history(c, u.companyId, id, u.id, `Moved from ${cur.loc_name} to ${(await c.query('SELECT name FROM locations WHERE id = $1', [merged.locationId])).rows[0].name}`);
    if (status !== cur.status) await history(c, u.companyId, id, u.id, `Status changed from ${cur.status} to ${status}`);
    if (tag !== cur.asset_tag) await history(c, u.companyId, id, u.id, `Asset ID changed from ${cur.asset_tag} to ${tag}`);
    await audit(c, u, 'Equipment', 'Edited equipment', `${tag}`);
  });
  res.json((await db.query(A_SQL + ' AND a.id = $2', [u.companyId, id])).rows[0]);
}));

/* ------------------------------------------------------------ incidents */
router.post('/assets/:id/incidents', writer, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Equipment'), u = req.user, b = req.body || {};
  const status = v.oneOf(b.status || 'Open', ['Open', 'Resolved'], 'Status');
  const out = await db.tx(async c => {
    const a = (await c.query('SELECT asset_tag FROM assets WHERE id = $1 AND company_id = $2', [id, u.companyId])).rows[0];
    if (!a) throw E.notFound('Equipment not found.');
    const title = v.str(b.title, 'Title', { max: 150 });
    const r = (await c.query(
      `INSERT INTO asset_incidents (company_id, asset_id, kind, severity, title, description, reported_by, status, resolution, resolved_at, occurred_on)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, CASE WHEN $8 = 'Resolved' THEN now() END, coalesce($10::date, current_date)) RETURNING id`,
      [u.companyId, id, v.oneOf(b.kind || 'Fault', KINDS, 'Kind'), v.oneOf(b.severity || 'Minor', SEVERITY, 'Severity'), title, v.str(b.description, 'Description', { max: 3000 }), u.id, status, v.str(b.resolution, 'Resolution', { max: 2000, optional: true }), b.occurredOn ? v.date(b.occurredOn, 'Date') : null])).rows[0];
    await history(c, u.companyId, id, u.id, `Incident logged: ${title}`);
    await audit(c, u, 'Equipment', 'Logged incident', `${a.asset_tag}: ${title}`);
    return r.id;
  });
  res.status(201).json({ id: out });
}));

router.patch('/assets/:id/incidents/:iid', writer, wrap(async (req, res) => {
  const id = v.uuid(req.params.id, 'Equipment'), iid = v.uuid(req.params.iid, 'Incident'), u = req.user;
  await db.tx(async c => {
    const i = (await c.query('SELECT title, status FROM asset_incidents WHERE id = $1 AND asset_id = $2 AND company_id = $3 FOR UPDATE', [iid, id, u.companyId])).rows[0];
    if (!i) throw E.notFound('Incident not found.');
    if (i.status === 'Resolved') throw E.conflict('That incident is already resolved.', 'ALREADY_RESOLVED');
    await c.query("UPDATE asset_incidents SET status = 'Resolved', resolved_at = now(), resolution = $1 WHERE id = $2", [v.str(req.body && req.body.resolution, 'Resolution', { max: 2000, optional: true }) || 'Marked as resolved', iid]);
    await history(c, u.companyId, id, u.id, `Incident resolved: ${i.title}`);
    const open = (await c.query("SELECT count(*)::int AS n FROM asset_incidents WHERE asset_id = $1 AND status = 'Open'", [id])).rows[0].n;
    const st = (await c.query('SELECT status FROM assets WHERE id = $1', [id])).rows[0].status;
    res.locals.reminder = !open && st === 'In repair' ? 'No open incidents are left. Remember to change the status from In repair.' : null;
  });
  res.json({ ok: true, reminder: res.locals.reminder });
}));

module.exports = router;
