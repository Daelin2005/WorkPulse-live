const db = require('../lib/db');
const { employeeUsername } = require('../lib/identity');

async function migrate() {
  await db.tx(async c => {
    // 1. Helper trigger function
    await c.query(`
      CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN NEW.updated_at = now(); RETURN NEW; END $$;
    `);

    // 2. Companies table
    await c.query(`
      CREATE TABLE IF NOT EXISTS companies (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        public_id text NOT NULL UNIQUE DEFAULT ('cmp_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
        name text NOT NULL CHECK (length(trim(name)) > 0),
        domain text NOT NULL UNIQUE CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
        tier text NOT NULL DEFAULT 'Starter' CHECK (tier IN ('Starter','Business','Enterprise')),
        seats integer NOT NULL DEFAULT 10 CHECK (seats > 0),
        renews_on date,
        logo text,
        timezone text NOT NULL DEFAULT 'UTC',
        employee_prefix text NOT NULL DEFAULT 'EMP',
        employee_seq integer NOT NULL DEFAULT 0,
        ticket_seq integer NOT NULL DEFAULT 1000,
        leave_year_start integer NOT NULL DEFAULT 1 CHECK (leave_year_start BETWEEN 1 AND 12),
        staffing_warn_at integer NOT NULL DEFAULT 1 CHECK (staffing_warn_at >= 1),
        sla_business_hours boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    // 3. Departments table
    await c.query(`
      CREATE TABLE IF NOT EXISTS departments (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) > 0),
        head_id uuid,
        handles_tickets boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (company_id, name),
        UNIQUE (company_id, id)
      )
    `);

    // 4. Employees table base creation
    await c.query(`
      CREATE TABLE IF NOT EXISTS employees (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        email text NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (company_id, id),
        UNIQUE (company_id, email)
      )
    `);

    // Ensure all required columns exist even if table was already created
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS employee_no text NOT NULL DEFAULT \'\'');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS username text');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS full_name text NOT NULL DEFAULT \'\'');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS department_id uuid');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS job_title text NOT NULL DEFAULT \'\'');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT \'employee\'');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT \'invited\'');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS start_date date');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS avatar text');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS password_hash text');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS invite_token_hash text');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS invite_expires_at timestamptz');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS last_login_at timestamptz');
    await c.query('ALTER TABLE employees ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now()');

    // Populate usernames for missing employees
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
    await c.query('CREATE UNIQUE INDEX IF NOT EXISTS employees_email_uq ON employees (email)');

    // 5. Additional Core Tables
    await c.query(`
      CREATE TABLE IF NOT EXISTS employee_preferences (
        employee_id uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
        prefs jsonb NOT NULL DEFAULT '{}'::jsonb,
        work_mode text NOT NULL DEFAULT 'Office' CHECK (work_mode IN ('Office','Remote','On site')),
        default_status text NOT NULL DEFAULT 'Online' CHECK (default_status IN ('Online','Away')),
        status_message text NOT NULL DEFAULT ''
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        employee_id uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        token_hash text NOT NULL UNIQUE,
        user_agent text,
        ip text,
        created_at timestamptz NOT NULL DEFAULT now(),
        last_seen_at timestamptz NOT NULL DEFAULT now(),
        expires_at timestamptz NOT NULL,
        revoked_at timestamptz
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS leave_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) > 0),
        days_per_year integer NOT NULL DEFAULT 0,
        carry_over_days integer NOT NULL DEFAULT 0,
        requires_approval boolean NOT NULL DEFAULT true,
        min_notice_days integer NOT NULL DEFAULT 0,
        certificate_after_days integer NOT NULL DEFAULT 0,
        enabled boolean NOT NULL DEFAULT true,
        is_core boolean NOT NULL DEFAULT false,
        UNIQUE (company_id, name),
        UNIQUE (company_id, id)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS sla_targets (
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        urgency text NOT NULL CHECK (urgency IN ('Low','Medium','High','Critical')),
        first_response_hours integer NOT NULL CHECK (first_response_hours > 0),
        resolution_hours integer NOT NULL CHECK (resolution_hours > 0),
        PRIMARY KEY (company_id, urgency)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS asset_types (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) > 0),
        id_prefix text NOT NULL,
        UNIQUE (company_id, name),
        UNIQUE (company_id, id)
      )
    `);

    await c.query(`
      CREATE TABLE IF NOT EXISTS locations (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) > 0),
        UNIQUE (company_id, name),
        UNIQUE (company_id, id)
      )
    `);

    // 6. Chat tables
    await c.query(`
      CREATE TABLE IF NOT EXISTS chat_groups (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        name text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
        direct_key text,
        created_by uuid NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (company_id, id),
        FOREIGN KEY (company_id, created_by) REFERENCES employees (company_id, id) ON DELETE CASCADE
      )
    `);
    
    await c.query('CREATE UNIQUE INDEX IF NOT EXISTS chat_groups_direct_key_uq ON chat_groups (company_id, direct_key) WHERE direct_key IS NOT NULL');

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

    // 7. Audit Log table
    await c.query(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id bigserial PRIMARY KEY,
        company_id uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
        actor_id uuid,
        actor_name text NOT NULL,
        category text NOT NULL,
        action text NOT NULL,
        details text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await c.query('CREATE INDEX IF NOT EXISTS audit_company_idx ON audit_log (company_id, created_at DESC)');

    // 8. Essential Database Functions
    await c.query(`
      CREATE OR REPLACE FUNCTION next_ticket_no(p_company uuid) RETURNS integer LANGUAGE sql AS $$
        UPDATE companies SET ticket_seq = ticket_seq + 1 WHERE id = p_company RETURNING ticket_seq $$;
    `);

    await c.query(`
      CREATE OR REPLACE FUNCTION next_employee_no(p_company uuid) RETURNS text LANGUAGE sql AS $$
        UPDATE companies SET employee_seq = employee_seq + 1 WHERE id = p_company
        RETURNING employee_prefix || '-' || lpad(employee_seq::text, 4, '0') $$;
    `);

    await c.query(`
      CREATE OR REPLACE FUNCTION seed_company_defaults(p_company uuid) RETURNS uuid LANGUAGE plpgsql AS $$
      DECLARE v_it uuid;
      BEGIN
        INSERT INTO departments (company_id, name, handles_tickets) VALUES (p_company, 'IT', true) RETURNING id INTO v_it;

        INSERT INTO leave_types (company_id, name, days_per_year, carry_over_days, requires_approval, min_notice_days, certificate_after_days, is_core) VALUES
          (p_company, 'Annual', 21, 5, true, 3, 0, true),
          (p_company, 'Sick', 10, 0, false, 0, 2, true),
          (p_company, 'Family responsibility', 3, 0, true, 1, 0, true),
          (p_company, 'Unpaid', 0, 0, true, 7, 0, true);

        INSERT INTO sla_targets (company_id, urgency, first_response_hours, resolution_hours) VALUES
          (p_company, 'Critical', 1, 8), (p_company, 'High', 4, 24), (p_company, 'Medium', 8, 72), (p_company, 'Low', 24, 120);

        INSERT INTO asset_types (company_id, name, id_prefix) VALUES
          (p_company, 'Desktop', 'DSK'), (p_company, 'Laptop', 'LAP'), (p_company, 'Monitor', 'MON'), (p_company, 'Keyboard', 'KEY'),
          (p_company, 'Mouse', 'MOU'), (p_company, 'Printer', 'PRT'), (p_company, 'Docking station', 'DOC'), (p_company, 'Phone', 'PHN'),
          (p_company, 'Tablet', 'TAB'), (p_company, 'Headset', 'HDS');

        INSERT INTO locations (company_id, name) VALUES (p_company, 'Office'), (p_company, 'Remote (home)'), (p_company, 'Storage room');
        RETURN v_it;
      END $$;
    `);
  });
}

module.exports = migrate;