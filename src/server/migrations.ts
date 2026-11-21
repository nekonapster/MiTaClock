export interface SqlMigration {
  id: string;
  sql: string;
}

export const PG_MIGRATIONS: SqlMigration[] = [
  {
    id: '001_initial_schema',
    sql: `
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        role TEXT NOT NULL CHECK (role IN ('employee', 'admin')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        is_demo BOOLEAN NOT NULL DEFAULT FALSE,
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS employees (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL UNIQUE REFERENCES users(id),
        external_ref TEXT,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS break_types (
        id TEXT PRIMARY KEY,
        code TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        is_paid BOOLEAN NOT NULL DEFAULT FALSE,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS clock_events (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        type TEXT NOT NULL CHECK (type IN ('shift_start', 'shift_end', 'break_start', 'break_end', 'event_void')),
        break_type_id TEXT REFERENCES break_types(id),
        received_at TIMESTAMPTZ NOT NULL,
        device_declared_at TIMESTAMPTZ NOT NULL,
        device_offset_ms INTEGER NOT NULL DEFAULT 0,
        time_source TEXT NOT NULL CHECK (time_source IN ('server', 'device_declared')),
        source TEXT NOT NULL DEFAULT 'employee' CHECK (source IN ('employee', 'admin')),
        corrects_event_id TEXT REFERENCES clock_events(id),
        correction_id TEXT,
        assignment_ref TEXT,
        project_ref TEXT,
        facility_ref TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_clock_events_emp_time
        ON clock_events(employee_id, device_declared_at);
      CREATE INDEX IF NOT EXISTS idx_clock_events_corrects
        ON clock_events(corrects_event_id);

      CREATE OR REPLACE FUNCTION prevent_clock_events_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'clock_events es append-only: % prohibido', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_clock_events_update_delete ON clock_events;
      CREATE TRIGGER trg_prevent_clock_events_update_delete
      BEFORE UPDATE OR DELETE ON clock_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_clock_events_mutation();

      CREATE TABLE IF NOT EXISTS sync_acknowledgements (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE REFERENCES clock_events(id),
        mita_ack_ref TEXT NOT NULL,
        confirmed_at TIMESTAMPTZ NOT NULL
      );

      CREATE OR REPLACE FUNCTION prevent_sync_ack_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'sync_acknowledgements es append-only: % prohibido', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_sync_ack_update_delete ON sync_acknowledgements;
      CREATE TRIGGER trg_prevent_sync_ack_update_delete
      BEFORE UPDATE OR DELETE ON sync_acknowledgements
      FOR EACH ROW
      EXECUTE FUNCTION prevent_sync_ack_mutation();
    `,
  },
  {
    id: '002_corrections_sessions_audit_outbox',
    sql: `
      CREATE TABLE IF NOT EXISTS corrections (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        target_event_id TEXT REFERENCES clock_events(id),
        kind TEXT NOT NULL CHECK (kind IN ('void_event', 'change_time', 'add_event')),
        requested_by TEXT NOT NULL REFERENCES users(id),
        reason TEXT NOT NULL,
        proposed_change_json TEXT NOT NULL,
        preview_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
        resolved_by TEXT REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        resolution_note TEXT,
        idempotency_key TEXT UNIQUE,
        approval_idempotency_key TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_corrections_emp_status
        ON corrections(employee_id, status, created_at);

      CREATE OR REPLACE FUNCTION prevent_corrections_delete_fn()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'corrections no permite DELETE: las correcciones son trazables';
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_corrections_delete ON corrections;
      CREATE TRIGGER trg_prevent_corrections_delete
      BEFORE DELETE ON corrections
      FOR EACH ROW
      EXECUTE FUNCTION prevent_corrections_delete_fn();

      CREATE OR REPLACE FUNCTION prevent_resolved_correction_update_fn()
      RETURNS TRIGGER AS $$
      BEGIN
        IF OLD.status <> 'pending' THEN
          RAISE EXCEPTION 'Una corrección resuelta no puede modificarse ni revertirse';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_resolved_correction_update ON corrections;
      CREATE TRIGGER trg_prevent_resolved_correction_update
      BEFORE UPDATE ON corrections
      FOR EACH ROW
      EXECUTE FUNCTION prevent_resolved_correction_update_fn();

      CREATE TABLE IF NOT EXISTS work_sessions (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        madrid_date TEXT NOT NULL,
        start_utc TIMESTAMPTZ NOT NULL,
        end_utc TIMESTAMPTZ,
        status TEXT NOT NULL CHECK (status IN ('open', 'flagged', 'closed', 'incomplete', 'voided')),
        worked_minutes INTEGER NOT NULL,
        raw_worked_minutes INTEGER NOT NULL DEFAULT 0,
        planned_minutes INTEGER NOT NULL,
        delta_minutes INTEGER NOT NULL,
        break_minutes INTEGER NOT NULL,
        planned_shift_id TEXT,
        planned_end_utc TIMESTAMPTZ,
        is_provisional_cap BOOLEAN NOT NULL DEFAULT FALSE,
        overrun_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
        overrun_reason TEXT,
        overrun_acknowledged_at TIMESTAMPTZ,
        anomaly_flags_json TEXT NOT NULL,
        has_pending_correction BOOLEAN NOT NULL DEFAULT FALSE,
        has_approved_correction BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_work_sessions_emp_date
        ON work_sessions(employee_id, madrid_date);

      CREATE TABLE IF NOT EXISTS audit_log (
        id TEXT PRIMARY KEY,
        actor_user_id TEXT NOT NULL REFERENCES users(id),
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details_json TEXT NOT NULL,
        ip_address TEXT NOT NULL,
        user_agent TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE OR REPLACE FUNCTION prevent_audit_log_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'audit_log es append-only: % prohibido', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_audit_log_update_delete ON audit_log;
      CREATE TRIGGER trg_prevent_audit_log_update_delete
      BEFORE UPDATE OR DELETE ON audit_log
      FOR EACH ROW
      EXECUTE FUNCTION prevent_audit_log_mutation();

      CREATE TABLE IF NOT EXISTS mita_outbox (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        kind TEXT NOT NULL CHECK (kind IN ('correction')),
        correction_id TEXT NOT NULL REFERENCES corrections(id),
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        external_ack_ref TEXT,
        created_at TIMESTAMPTZ NOT NULL,
        sent_at TIMESTAMPTZ
      );
    `,
  },
  {
    id: '003_planning_policies_incidents',
    sql: `
      CREATE TABLE IF NOT EXISTS planned_shifts (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        madrid_date TEXT NOT NULL,
        start_utc TIMESTAMPTZ NOT NULL,
        end_utc TIMESTAMPTZ NOT NULL,
        planned_break_minutes INTEGER NOT NULL DEFAULT 0,
        planned_minutes INTEGER NOT NULL,
        project_ref TEXT,
        facility_ref TEXT,
        assignment_ref TEXT,
        source TEXT NOT NULL DEFAULT 'local' CHECK (source IN ('local', 'mita')),
        template_id TEXT,
        label TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_planned_shifts_emp_date
        ON planned_shifts(employee_id, madrid_date);

      CREATE TABLE IF NOT EXISTS shift_templates (
        id TEXT PRIMARY KEY,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        name TEXT NOT NULL,
        weekdays_json TEXT NOT NULL,
        start_time_madrid TEXT NOT NULL,
        end_time_madrid TEXT NOT NULL,
        crosses_midnight BOOLEAN NOT NULL DEFAULT FALSE,
        planned_break_minutes INTEGER NOT NULL DEFAULT 0,
        project_ref TEXT,
        facility_ref TEXT,
        valid_from TEXT NOT NULL,
        valid_to TEXT,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS day_offs (
        id TEXT PRIMARY KEY,
        employee_id TEXT REFERENCES employees(id),
        madrid_date TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('free', 'holiday', 'absence')),
        note TEXT,
        created_at TIMESTAMPTZ NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_day_offs_date_emp
        ON day_offs(madrid_date, employee_id);

      CREATE TABLE IF NOT EXISTS clock_policies (
        id TEXT PRIMARY KEY,
        past_planned_end_minutes INTEGER NOT NULL DEFAULT 15,
        flag_after_end_minutes INTEGER NOT NULL DEFAULT 120,
        max_open_hours INTEGER NOT NULL DEFAULT 12,
        max_daily_minutes INTEGER NOT NULL DEFAULT 720,
        schedule_tolerance_minutes INTEGER NOT NULL DEFAULT 30,
        overrun_policy TEXT NOT NULL DEFAULT 'flag_only' CHECK (overrun_policy IN ('flag_only', 'cap_provisional')),
        require_planned_shift BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_incidents (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        employee_id TEXT NOT NULL REFERENCES employees(id),
        kind TEXT NOT NULL CHECK (kind IN ('flagged_overrun', 'incomplete_shift')),
        status TEXT NOT NULL CHECK (status IN ('open', 'acknowledged', 'resolved')),
        madrid_date TEXT NOT NULL,
        shift_start_utc TIMESTAMPTZ NOT NULL,
        planned_end_utc TIMESTAMPTZ,
        detected_at TIMESTAMPTZ NOT NULL,
        acknowledged_at TIMESTAMPTZ,
        acknowledged_by TEXT REFERENCES users(id),
        resolved_at TIMESTAMPTZ,
        resolved_by_correction_id TEXT REFERENCES corrections(id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_incidents_status
        ON session_incidents(status, employee_id);

      CREATE TABLE IF NOT EXISTS mita_simulated_corrections (
        id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        correction_id TEXT NOT NULL,
        session_id TEXT,
        payload_json TEXT NOT NULL,
        ack_ref TEXT NOT NULL,
        received_at TIMESTAMPTZ NOT NULL
      );
    `,
  },
  {
    id: '004_ensure_pg_triggers_and_first_login',
    sql: `
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

      CREATE OR REPLACE FUNCTION prevent_clock_events_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'clock_events es append-only: % prohibido', TG_OP;
      END;
      $$ LANGUAGE plpgsql;

      DROP TRIGGER IF EXISTS trg_prevent_clock_events_update_delete ON clock_events;
      CREATE TRIGGER trg_prevent_clock_events_update_delete
      BEFORE UPDATE OR DELETE ON clock_events
      FOR EACH ROW
      EXECUTE FUNCTION prevent_clock_events_mutation();
    `,
  },
  {
    id: '005_add_void_day_correction_kind',
    sql: `
      DO $$
      DECLARE
        c RECORD;
      BEGIN
        FOR c IN
          SELECT conname
          FROM pg_constraint
          WHERE conrelid = 'corrections'::regclass
            AND contype = 'c'
            AND pg_get_constraintdef(oid) LIKE '%kind%'
        LOOP
          EXECUTE format('ALTER TABLE corrections DROP CONSTRAINT %I', c.conname);
        END LOOP;
      END $$;

      ALTER TABLE corrections
        ADD CONSTRAINT corrections_kind_check
        CHECK (kind IN ('void_event', 'change_time', 'add_event', 'void_day'));
    `,
  },
];
