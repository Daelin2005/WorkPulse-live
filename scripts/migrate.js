const db = require('../lib/db');
const { employeeUsername } = require('../lib/identity');

async function migrate() {
  await db.tx(async c => {
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS username text');
    const missing = (await c.query(
      'SELECT id, company_id, email FROM employees WHERE username IS NULL ORDER BY company_id, created_at, id'
    )).rows;
    for (const employee of missing) {
      const base = employeeUsername(undefined, employee.email);
      let username = base;
      let suffix = 2;
      while ((await c.query('SELECT 1 FROM employees WHERE company_id = $1 AND username = $2', [employee.company_id, username])).rowCount) {
        const ending = `-${suffix++}`;
        if (ending.length >= 32) throw new Error(`Could not create a unique username for employee ${employee.id}.`);
        username = `${base.slice(0, 32 - ending.length)}${ending}`;
      }
      await c.query('UPDATE employees SET username = $1 WHERE id = $2', [username, employee.id]);
    }
    await c.query('ALTER TABLE employees ALTER COLUMN username SET NOT NULL');
    await c.query('CREATE UNIQUE INDEX IF NOT EXISTS employees_company_username_uq ON employees (company_id, username)');

    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (company_id, id),
        FOREIGN KEY (company_id, created_by) REFERENCES employees (company_id, id) ON DELETE CASCADE
      )
    `);
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_group_members (
        company_id uuid NOT NULL,
        group_id uuid NOT NULL,
        employee_id uuid NOT NULL,
        added_by uuid NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        removed_at timestamptz,
        PRIMARY KEY (group_id, employee_id),
        FOREIGN KEY (company_id, group_id) REFERENCES chat_groups (company_id, id) ON DELETE CASCADE,
        FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE,
        FOREIGN KEY (company_id, added_by) REFERENCES employees (company_id, id) ON DELETE CASCADE
      )
    `);
    await c.query('CREATE INDEX IF NOT EXISTS chat_group_members_employee_idx ON chat_group_members (employee_id, group_id) WHERE removed_at IS NULL');
    await c.query('ALTER TABLE chat_groups ADD COLUMN IF NOT EXISTS direct_key text');
    await c.query('CREATE UNIQUE INDEX IF NOT EXISTS chat_groups_direct_key_uq ON chat_groups (company_id, direct_key) WHERE direct_key IS NOT NULL');
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_messages (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL,
        group_id uuid NOT NULL,
        sender_id uuid NOT NULL,
        body text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
        created_at timestamptz NOT NULL DEFAULT now(),
        FOREIGN KEY (company_id, group_id) REFERENCES chat_groups (company_id, id) ON DELETE CASCADE,
        FOREIGN KEY (company_id, sender_id) REFERENCES employees (company_id, id) ON DELETE CASCADE
      )
    `);
    await c.query('CREATE INDEX IF NOT EXISTS chat_messages_group_idx ON chat_messages (group_id, created_at DESC, id DESC)');
  });
}

module.exports = migrate;
