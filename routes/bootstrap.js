// One call that returns what every page needs when it opens.
const router = require('express').Router();
const db = require('../lib/db');
const { wrap, isPriv } = require('../lib/util');
const { meOf } = require('../lib/auth');

router.get('/', wrap(async (req, res) => {
  const u = req.user;
  const me = await meOf(u.id);
  const [departments, directory, leaveTypes, unread] = await Promise.all([
    db.query(`SELECT d.id, d.name, d.head_id AS "headId", d.handles_tickets AS "handlesTickets" FROM departments d WHERE d.company_id = $1 ORDER BY d.name`, [u.companyId]),
    db.query(`SELECT e.id, e.full_name AS name, e.job_title AS "jobTitle", e.role, e.email, e.phone, d.name AS department FROM employees e JOIN departments d ON d.id = e.department_id
               WHERE e.company_id = $1 AND e.status = 'active' ORDER BY e.full_name`, [u.companyId]),
    db.query('SELECT id, name, days_per_year AS "daysPerYear", requires_approval AS "requiresApproval", min_notice_days AS "minNoticeDays", enabled FROM leave_types WHERE company_id = $1 AND enabled ORDER BY is_core DESC, name', [u.companyId]),
    db.query('SELECT count(*)::int AS n FROM notifications WHERE employee_id = $1 AND read_at IS NULL', [u.id])
  ]);
  res.json({ ...me, permissions: { manage: u.role === 'admin', viewReports: isPriv(u), writeEquipment: isPriv(u) || u.handlesTickets },
             departments: departments.rows, directory: directory.rows, leaveTypes: leaveTypes.rows, unreadNotifications: unread.rows[0].n });
}));

module.exports = router;
