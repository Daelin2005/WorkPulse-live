-- WorkPulse database schema (PostgreSQL 15 or newer)
--
-- Multi-tenancy: every business table carries company_id. Child tables use composite
-- foreign keys (company_id, id), so a row can never point at another company's data.
-- Run once:  psql "$DATABASE_URL" -f database.sql
-- Safe to re-run on an empty database only (it does not use IF NOT EXISTS on every object).

BEGIN;

-- ---------------------------------------------------------------- helpers
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------- companies
CREATE TABLE companies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  public_id           text NOT NULL UNIQUE DEFAULT ('cmp_' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)), -- the "CompanyID" shown to admins
  name                text NOT NULL CHECK (length(trim(name)) > 0),
  domain              text NOT NULL UNIQUE CHECK (domain = lower(domain) AND domain ~ '^[a-z0-9-]+(\.[a-z0-9-]+)+$'),
  tier                text NOT NULL DEFAULT 'Starter' CHECK (tier IN ('Starter','Business','Enterprise')),
  seats               integer NOT NULL DEFAULT 10 CHECK (seats > 0),
  renews_on           date,
  logo                text,                                   -- data URL for now; move to object storage later
  timezone            text NOT NULL DEFAULT 'UTC',            -- used to decide what "today" means for attendance
  employee_prefix     text NOT NULL DEFAULT 'EMP',
  employee_seq        integer NOT NULL DEFAULT 0,
  ticket_seq          integer NOT NULL DEFAULT 1000,
  leave_year_start    integer NOT NULL DEFAULT 1 CHECK (leave_year_start BETWEEN 1 AND 12),
  staffing_warn_at    integer NOT NULL DEFAULT 1 CHECK (staffing_warn_at >= 1),
  sla_business_hours  boolean NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER companies_updated BEFORE UPDATE ON companies FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE departments (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name             text NOT NULL CHECK (length(trim(name)) > 0),
  head_id          uuid,                                       -- FK added below (employees comes later)
  handles_tickets  boolean NOT NULL DEFAULT false,             -- people here see the unassigned ticket queue (IT)
  created_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);

-- ---------------------------------------------------------------- people
CREATE TABLE employees (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id         uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_no        text NOT NULL,                            -- "AL-0001", used for records and payroll
  username           text NOT NULL,
  full_name          text NOT NULL CHECK (length(trim(full_name)) > 0),
  email              text NOT NULL CHECK (email = lower(email)),
  department_id      uuid NOT NULL,
  job_title          text NOT NULL DEFAULT '',
  role               text NOT NULL DEFAULT 'employee' CHECK (role IN ('admin','manager','employee')),
  status             text NOT NULL DEFAULT 'invited' CHECK (status IN ('invited','active','deactivated')),
  start_date         date,
  phone              text,
  avatar             text,                                     -- data URL for now
  password_hash      text,                                     -- bcrypt; null until the invite is accepted
  invite_token_hash  text,                                     -- sha-256 of the emailed invite token
  invite_expires_at  timestamptz,
  last_login_at      timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_no),
  UNIQUE (company_id, username),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, department_id) REFERENCES departments (company_id, id)
);
CREATE UNIQUE INDEX employees_email_uq ON employees (email);   -- one account per email, across the platform
CREATE INDEX employees_company_idx ON employees (company_id, status);
CREATE TRIGGER employees_updated BEFORE UPDATE ON employees FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE departments ADD FOREIGN KEY (company_id, head_id) REFERENCES employees (company_id, id) ON DELETE SET NULL (head_id);

CREATE TABLE employee_preferences (
  employee_id     uuid PRIMARY KEY REFERENCES employees(id) ON DELETE CASCADE,
  prefs           jsonb NOT NULL DEFAULT '{}'::jsonb,           -- alerts, table density, colours, time zone, formats
  work_mode       text NOT NULL DEFAULT 'Office' CHECK (work_mode IN ('Office','Remote','On site')),
  default_status  text NOT NULL DEFAULT 'Online' CHECK (default_status IN ('Online','Away')),
  status_message  text NOT NULL DEFAULT ''
);

CREATE TABLE sessions (                                          -- also powers "Active sessions" on the profile page
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  company_id    uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,                            -- sha-256 of the cookie value; the raw token is never stored
  user_agent    text,
  ip            text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz
);
CREATE INDEX sessions_employee_idx ON sessions (employee_id) WHERE revoked_at IS NULL;

CREATE TABLE password_resets (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  token_hash    text NOT NULL UNIQUE,
  expires_at    timestamptz NOT NULL,
  used_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- announcements
CREATE TABLE announcements (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id               uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title                    text NOT NULL CHECK (length(trim(title)) > 0),
  body                     text NOT NULL CHECK (length(trim(body)) > 0),
  audience_department_id   uuid,                                 -- null = everyone
  pinned                   boolean NOT NULL DEFAULT false,
  status                   text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published')),
  published_on             date,
  expires_on               date,
  created_by               uuid,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT pinned OR status = 'published'),
  FOREIGN KEY (company_id, audience_department_id) REFERENCES departments (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, created_by) REFERENCES employees (company_id, id) ON DELETE SET NULL (created_by)
);
CREATE UNIQUE INDEX announcements_one_pinned ON announcements (company_id) WHERE pinned;
CREATE TRIGGER announcements_updated BEFORE UPDATE ON announcements FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------- leave policy
CREATE TABLE leave_types (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name                    text NOT NULL CHECK (length(trim(name)) > 0),
  days_per_year           integer NOT NULL DEFAULT 0 CHECK (days_per_year >= 0),   -- 0 means no cap
  carry_over_days         integer NOT NULL DEFAULT 0 CHECK (carry_over_days >= 0),
  requires_approval       boolean NOT NULL DEFAULT true,
  min_notice_days         integer NOT NULL DEFAULT 0 CHECK (min_notice_days >= 0),
  certificate_after_days  integer NOT NULL DEFAULT 0 CHECK (certificate_after_days >= 0), -- 0 means never
  enabled                 boolean NOT NULL DEFAULT true,
  is_core                 boolean NOT NULL DEFAULT false,
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);

-- ---------------------------------------------------------------- tickets
CREATE TABLE sla_targets (
  company_id            uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  urgency               text NOT NULL CHECK (urgency IN ('Low','Medium','High','Critical')),
  first_response_hours  integer NOT NULL CHECK (first_response_hours > 0),
  resolution_hours      integer NOT NULL CHECK (resolution_hours > 0),
  PRIMARY KEY (company_id, urgency),
  CHECK (resolution_hours >= first_response_hours)
);

CREATE TABLE ticket_rules (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(trim(name)) > 0),
  category     text,                                              -- null = any category
  urgency      text CHECK (urgency IN ('Low','Medium','High','Critical')),   -- null = any urgency
  action       text NOT NULL CHECK (action IN ('assign','notify','escalate')),
  target_id    uuid,                                              -- the person to assign, notify or escalate to
  enabled      boolean NOT NULL DEFAULT true,
  position     integer NOT NULL DEFAULT 0,
  FOREIGN KEY (company_id, target_id) REFERENCES employees (company_id, id) ON DELETE SET NULL (target_id)
);

CREATE TABLE tickets (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id          uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number              integer NOT NULL,                           -- the visible ticket number, per company (#1001, #1002 ...)
  subject             text NOT NULL CHECK (length(trim(subject)) > 0),
  description         text NOT NULL DEFAULT '',
  category            text NOT NULL CHECK (category IN ('Hardware Issue','Software/Access','Network/Wi-Fi','HR Inquiry','General Support')),
  urgency             text NOT NULL DEFAULT 'Medium' CHECK (urgency IN ('Low','Medium','High','Critical')),
  status              text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Pending Response','In Progress','Resolved','Closed')),
  submitted_by        uuid NOT NULL,
  parent_id           uuid,                                       -- set on sub-tickets
  first_response_due  timestamptz,
  resolution_due      timestamptz,
  first_response_at   timestamptz,
  resolved_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, number),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, submitted_by) REFERENCES employees (company_id, id),
  FOREIGN KEY (company_id, parent_id) REFERENCES tickets (company_id, id) ON DELETE CASCADE
);
CREATE INDEX tickets_company_status_idx ON tickets (company_id, status, created_at DESC);
CREATE INDEX tickets_parent_idx ON tickets (parent_id) WHERE parent_id IS NOT NULL;
CREATE TRIGGER tickets_updated BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_assignees (
  ticket_id    uuid NOT NULL,
  employee_id  uuid NOT NULL,
  company_id   uuid NOT NULL,
  PRIMARY KEY (ticket_id, employee_id),
  FOREIGN KEY (company_id, ticket_id) REFERENCES tickets (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_assignees_employee_idx ON ticket_assignees (employee_id);

CREATE TABLE ticket_events (                                      -- the activity and discussion timeline
  id           bigserial PRIMARY KEY,
  ticket_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  actor_id     uuid,
  actor_label  text NOT NULL,                                     -- kept so the timeline survives if a person is removed
  kind         text NOT NULL CHECK (kind IN ('created','comment','status','assignment','rule','system')),
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, ticket_id) REFERENCES tickets (company_id, id) ON DELETE CASCADE
);
CREATE INDEX ticket_events_ticket_idx ON ticket_events (ticket_id, created_at);

CREATE TABLE ticket_attachments (                                  -- metadata only; store the bytes in object storage or on disk
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id    uuid NOT NULL,
  company_id   uuid NOT NULL,
  filename     text NOT NULL,
  mime_type    text NOT NULL,
  size_bytes   bigint NOT NULL CHECK (size_bytes >= 0),
  storage_key  text NOT NULL,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, ticket_id) REFERENCES tickets (company_id, id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------- leave requests
CREATE TABLE leave_requests (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id    uuid NOT NULL,
  leave_type_id  uuid NOT NULL,
  start_date     date NOT NULL,
  end_date       date NOT NULL,
  day_part       text NOT NULL DEFAULT 'full' CHECK (day_part IN ('full','am','pm')),
  days           numeric(4,1) NOT NULL CHECK (days > 0),
  reason         text NOT NULL DEFAULT '',
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by     uuid,
  decision_note  text NOT NULL DEFAULT '',
  decided_at     timestamptz,
  ticket_id      uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, leave_type_id) REFERENCES leave_types (company_id, id),
  FOREIGN KEY (company_id, decided_by) REFERENCES employees (company_id, id) ON DELETE SET NULL (decided_by),
  FOREIGN KEY (company_id, ticket_id) REFERENCES tickets (company_id, id) ON DELETE SET NULL (ticket_id)
);
CREATE INDEX leave_company_dates_idx ON leave_requests (company_id, start_date, end_date);
CREATE INDEX leave_employee_idx ON leave_requests (employee_id, status);

-- ---------------------------------------------------------------- attendance
CREATE TABLE attendance_records (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id       uuid NOT NULL,
  work_date         date NOT NULL,                                 -- the day in the company's time zone
  clock_in          timestamptz NOT NULL,
  clock_out         timestamptz,
  break_minutes     integer NOT NULL DEFAULT 0 CHECK (break_minutes >= 0),
  break_started_at  timestamptz,
  location          text NOT NULL DEFAULT 'Office' CHECK (location IN ('Office','Remote','On site')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, employee_id, work_date),
  UNIQUE (company_id, id),
  CHECK (clock_out IS NULL OR clock_out >= clock_in),
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE
);
CREATE INDEX attendance_company_date_idx ON attendance_records (company_id, work_date);
CREATE TRIGGER attendance_updated BEFORE UPDATE ON attendance_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE attendance_corrections (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id     uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  record_id      uuid NOT NULL,
  employee_id    uuid NOT NULL,
  requested_in   timestamptz,
  requested_out  timestamptz,
  reason         text NOT NULL CHECK (length(trim(reason)) > 0),
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by     uuid,
  decision_note  text NOT NULL DEFAULT '',
  decided_at     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CHECK (requested_in IS NOT NULL OR requested_out IS NOT NULL),
  FOREIGN KEY (company_id, record_id) REFERENCES attendance_records (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, decided_by) REFERENCES employees (company_id, id) ON DELETE SET NULL (decided_by)
);
CREATE INDEX corrections_company_status_idx ON attendance_corrections (company_id, status);

-- who is clocked in or on a break right now (people without a row are absent)
CREATE VIEW v_open_shifts AS
  SELECT company_id, employee_id, work_date, clock_in, break_started_at, location,
         CASE WHEN break_started_at IS NOT NULL THEN 'break' ELSE 'in' END AS state
  FROM attendance_records WHERE clock_out IS NULL;

-- ---------------------------------------------------------------- equipment
CREATE TABLE asset_types (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  id_prefix   text NOT NULL CHECK (id_prefix ~ '^[A-Z0-9]{2,5}$'),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);
CREATE TABLE locations (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) > 0),
  UNIQUE (company_id, name),
  UNIQUE (company_id, id)
);
CREATE TABLE assets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  asset_tag         text NOT NULL CHECK (length(trim(asset_tag)) > 0),     -- the ID on the device (or one the user created)
  type_id           uuid NOT NULL,
  model             text NOT NULL CHECK (length(trim(model)) > 0),         -- the whole model name
  serial_number     text NOT NULL DEFAULT '',
  holder_id         uuid,                                                  -- who has it now
  location_id       uuid NOT NULL,
  status            text NOT NULL DEFAULT 'In storage' CHECK (status IN ('In use','In storage','In repair','Retired','Lost')),
  purchased_on      date,
  warranty_ends_on  date,
  notes             text NOT NULL DEFAULT '',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  CHECK (warranty_ends_on IS NULL OR purchased_on IS NULL OR warranty_ends_on >= purchased_on),
  FOREIGN KEY (company_id, type_id) REFERENCES asset_types (company_id, id),
  FOREIGN KEY (company_id, location_id) REFERENCES locations (company_id, id),
  FOREIGN KEY (company_id, holder_id) REFERENCES employees (company_id, id) ON DELETE SET NULL (holder_id)
);
CREATE UNIQUE INDEX assets_tag_uq ON assets (company_id, lower(asset_tag));
CREATE INDEX assets_holder_idx ON assets (holder_id);
CREATE TRIGGER assets_updated BEFORE UPDATE ON assets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE asset_incidents (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL,
  asset_id     uuid NOT NULL,
  kind         text NOT NULL CHECK (kind IN ('Fault','Damage','Loss or theft','Maintenance','Other')),
  severity     text NOT NULL CHECK (severity IN ('Minor','Major','Critical')),
  title        text NOT NULL CHECK (length(trim(title)) > 0),
  description  text NOT NULL,
  reported_by  uuid,
  status       text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open','Resolved')),
  resolution   text NOT NULL DEFAULT '',
  occurred_on  date NOT NULL DEFAULT current_date,
  resolved_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, asset_id) REFERENCES assets (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, reported_by) REFERENCES employees (company_id, id) ON DELETE SET NULL (reported_by)
);
CREATE INDEX asset_incidents_asset_idx ON asset_incidents (asset_id, occurred_on DESC);

CREATE TABLE asset_history (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL,
  asset_id    uuid NOT NULL,
  actor_id    uuid,
  event       text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, asset_id) REFERENCES assets (company_id, id) ON DELETE CASCADE
);
CREATE INDEX asset_history_asset_idx ON asset_history (asset_id, created_at);

-- ---------------------------------------------------------------- notifications and audit
CREATE TABLE notifications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  employee_id  uuid NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  body         text NOT NULL,
  link         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz
);
CREATE INDEX notifications_employee_idx ON notifications (employee_id, created_at DESC) WHERE read_at IS NULL;

-- ---------------------------------------------------------------- group discussions
CREATE TABLE chat_groups (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name        text NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 80),
  direct_key  text,
  created_by  uuid NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, id),
  FOREIGN KEY (company_id, created_by) REFERENCES employees (company_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX chat_groups_direct_key_uq ON chat_groups (company_id, direct_key) WHERE direct_key IS NOT NULL;

CREATE TABLE chat_group_members (
  company_id  uuid NOT NULL,
  group_id    uuid NOT NULL,
  employee_id uuid NOT NULL,
  added_by    uuid NOT NULL,
  joined_at   timestamptz NOT NULL DEFAULT now(),
  removed_at  timestamptz,
  PRIMARY KEY (group_id, employee_id),
  FOREIGN KEY (company_id, group_id) REFERENCES chat_groups (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, employee_id) REFERENCES employees (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, added_by) REFERENCES employees (company_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_group_members_employee_idx ON chat_group_members (employee_id, group_id) WHERE removed_at IS NULL;

CREATE TABLE chat_messages (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id  uuid NOT NULL,
  group_id    uuid NOT NULL,
  sender_id   uuid NOT NULL,
  body        text NOT NULL CHECK (length(trim(body)) BETWEEN 1 AND 4000),
  created_at  timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (company_id, group_id) REFERENCES chat_groups (company_id, id) ON DELETE CASCADE,
  FOREIGN KEY (company_id, sender_id) REFERENCES employees (company_id, id) ON DELETE CASCADE
);
CREATE INDEX chat_messages_group_idx ON chat_messages (group_id, created_at DESC, id DESC);

CREATE TABLE audit_log (
  id          bigserial PRIMARY KEY,
  company_id  uuid NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  actor_id    uuid,
  actor_name  text NOT NULL,
  category    text NOT NULL,
  action      text NOT NULL,
  details     text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_company_idx ON audit_log (company_id, created_at DESC);
-- the audit log is append-only: nobody can edit or delete a row, not even the application
CREATE FUNCTION audit_block_changes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM companies WHERE id = OLD.company_id) THEN RETURN OLD; END IF; -- allow cascade when a whole company is removed
  RAISE EXCEPTION 'audit_log is append-only';
END $$;
CREATE TRIGGER audit_no_update BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION audit_block_changes();

-- ---------------------------------------------------------------- counters and defaults
-- next visible ticket number for a company, safe under concurrent requests
CREATE FUNCTION next_ticket_no(p_company uuid) RETURNS integer LANGUAGE sql AS $$
  UPDATE companies SET ticket_seq = ticket_seq + 1 WHERE id = p_company RETURNING ticket_seq $$;

-- next employee number like "AL-0007"
CREATE FUNCTION next_employee_no(p_company uuid) RETURNS text LANGUAGE sql AS $$
  UPDATE companies SET employee_seq = employee_seq + 1 WHERE id = p_company
  RETURNING employee_prefix || '-' || lpad(employee_seq::text, 4, '0') $$;

-- everything a brand-new company needs before its admin does anything. Returns the IT department id.
CREATE FUNCTION seed_company_defaults(p_company uuid) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_it uuid;
BEGIN
  INSERT INTO departments (company_id, name, handles_tickets) VALUES (p_company, 'IT', true) RETURNING id INTO v_it;

  INSERT INTO leave_types (company_id, name, days_per_year, carry_over_days, requires_approval, min_notice_days, certificate_after_days, is_core) VALUES
    (p_company, 'Annual',                21, 5, true,  3, 0, true),
    (p_company, 'Sick',                 10, 0, false, 0, 2, true),
    (p_company, 'Family responsibility', 3, 0, true,  1, 0, true),
    (p_company, 'Unpaid',                0, 0, true,  7, 0, true);

  INSERT INTO sla_targets (company_id, urgency, first_response_hours, resolution_hours) VALUES
    (p_company, 'Critical', 1, 8), (p_company, 'High', 4, 24), (p_company, 'Medium', 8, 72), (p_company, 'Low', 24, 120);

  INSERT INTO asset_types (company_id, name, id_prefix) VALUES
    (p_company, 'Desktop', 'DSK'), (p_company, 'Laptop', 'LAP'), (p_company, 'Monitor', 'MON'), (p_company, 'Keyboard', 'KEY'),
    (p_company, 'Mouse', 'MOU'), (p_company, 'Printer', 'PRT'), (p_company, 'Docking station', 'DOC'), (p_company, 'Phone', 'PHN'),
    (p_company, 'Tablet', 'TAB'), (p_company, 'Headset', 'HDS');

  INSERT INTO locations (company_id, name) VALUES (p_company, 'Office'), (p_company, 'Remote (home)'), (p_company, 'Storage room');
  RETURN v_it;
END $$;

COMMIT;
