-- ============================================================================
-- KKI Biometric Attendance & Payroll System - Relational PostgreSQL Schema
-- Target: Supabase PostgreSQL (Works for both 'public' and 'demo' schemas)
-- Safe & Idempotent: Uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS (ZERO DATA LOSS)
-- ============================================================================

-- To deploy into an isolated schema (e.g., 'demo'), uncomment:
-- CREATE SCHEMA IF NOT EXISTS demo;
-- SET search_path TO demo, public;

-- 1. Application Settings (Key-Value Store)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  description TEXT
);

-- 2. Workers / Employees Master Table
CREATE TABLE IF NOT EXISTS workers (
  id SERIAL PRIMARY KEY,
  staff_no TEXT NOT NULL UNIQUE,
  staff_name TEXT NOT NULL,
  department TEXT DEFAULT 'WORKER',
  monthly_salary NUMERIC DEFAULT 15000,
  housing_allowance NUMERIC DEFAULT 0,
  food_allowance NUMERIC DEFAULT 0,
  other_allowance NUMERIC DEFAULT 0,
  salary_type TEXT DEFAULT 'monthly',
  assigned_shift TEXT DEFAULT 'auto',
  is_exception INTEGER DEFAULT 0,
  exception_reason TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 3. Raw Biometric Punches
CREATE TABLE IF NOT EXISTS raw_punches (
  id SERIAL PRIMARY KEY,
  staff_no TEXT NOT NULL,
  date TEXT NOT NULL,
  weekday TEXT,
  swipe_record TEXT,
  machine_work_time TEXT,
  batch_id TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (staff_no, date)
);

-- 4. Computed Daily Attendance Records
CREATE TABLE IF NOT EXISTS daily_attendance (
  id SERIAL PRIMARY KEY,
  staff_no TEXT NOT NULL,
  date TEXT NOT NULL,
  weekday TEXT,
  raw_swipes TEXT,
  original_raw_swipes TEXT DEFAULT '',
  manual_punches TEXT DEFAULT '',
  effective_in TEXT,
  effective_out TEXT,
  regular_hours NUMERIC DEFAULT 0,
  ot_hours NUMERIC DEFAULT 0,
  sunday_ot_hours NUMERIC DEFAULT 0,
  total_hours NUMERIC DEFAULT 0,
  late_minutes INTEGER DEFAULT 0,
  status TEXT NOT NULL,
  shift TEXT DEFAULT '08:00',
  is_manual_override INTEGER DEFAULT 0,
  override_reason TEXT DEFAULT '',
  forfeiture_reason TEXT DEFAULT '',
  updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (staff_no, date)
);

ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS forfeiture_reason TEXT DEFAULT '';
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS override_reason TEXT DEFAULT '';
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS original_raw_swipes TEXT DEFAULT '';
ALTER TABLE daily_attendance ADD COLUMN IF NOT EXISTS manual_punches TEXT DEFAULT '';

-- 5. Salary Advances
CREATE TABLE IF NOT EXISTS advances (
  id SERIAL PRIMARY KEY,
  staff_no TEXT NOT NULL,
  date TEXT NOT NULL,
  amount NUMERIC NOT NULL,
  note TEXT,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 6. Immutable Audit Logs
CREATE TABLE IF NOT EXISTS audit_logs (
  id SERIAL PRIMARY KEY,
  staff_no TEXT NOT NULL,
  date TEXT NOT NULL,
  field_changed TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT,
  edited_by TEXT DEFAULT 'Admin',
  reason TEXT,
  action TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 7. Attendance Rule Profiles
CREATE TABLE IF NOT EXISTS rule_profiles (
  id SERIAL PRIMARY KEY,
  profile_name TEXT NOT NULL UNIQUE,
  is_default INTEGER DEFAULT 0,
  shift_start TEXT DEFAULT '08:30',
  shift_end TEXT DEFAULT '16:30',
  grace_slab_minutes INTEGER DEFAULT 30,
  ot_multiplier NUMERIC DEFAULT 1.5,
  ot_rounding TEXT DEFAULT 'minutes',
  short_hours_threshold NUMERIC DEFAULT 4.0,
  weekly_off_day TEXT DEFAULT 'Sun',
  forfeiture_absent_threshold INTEGER DEFAULT 2,
  standard_month_days TEXT DEFAULT 'calendar',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 8. Custom Attendance Rules
CREATE TABLE IF NOT EXISTS custom_rules (
  id SERIAL PRIMARY KEY,
  rule_name TEXT NOT NULL,
  rule_type TEXT NOT NULL,
  target_staff_no TEXT DEFAULT 'all',
  exemption_type TEXT DEFAULT '',
  start_time TEXT DEFAULT '',
  end_time TEXT DEFAULT '',
  threshold_mins INTEGER DEFAULT 0,
  deduction_mins INTEGER DEFAULT 0,
  deduction_amount NUMERIC DEFAULT 0,
  valid_from TEXT DEFAULT '',
  valid_to TEXT DEFAULT '',
  max_allowed_days INTEGER DEFAULT 0,
  grace_allowed_mins INTEGER DEFAULT 30,
  is_active INTEGER DEFAULT 1,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 9. Custom Salary Rules
CREATE TABLE IF NOT EXISTS custom_salary_rules (
  id SERIAL PRIMARY KEY,
  rule_name TEXT NOT NULL,
  rule_type TEXT NOT NULL DEFAULT 'bonus',
  condition_type TEXT DEFAULT 'always',
  condition_value TEXT DEFAULT '0',
  action_type TEXT DEFAULT 'add_fixed',
  action_value NUMERIC DEFAULT 0,
  applies_to_day TEXT DEFAULT 'all',
  description TEXT,
  source TEXT DEFAULT 'manual',
  ai_original_prompt TEXT,
  is_active INTEGER DEFAULT 1,
  target_staff_no TEXT DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 10. Paid Holidays
CREATE TABLE IF NOT EXISTS paid_holidays (
  id SERIAL PRIMARY KEY,
  holiday_date TEXT NOT NULL UNIQUE,
  holiday_name TEXT NOT NULL,
  is_recurring INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 11. Factory Calendar Overrides (Working Sundays / Substitute Offs / Holidays)
CREATE TABLE IF NOT EXISTS factory_calendar (
  id SERIAL PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  day_type TEXT NOT NULL DEFAULT 'holiday',
  title TEXT NOT NULL,
  notes TEXT DEFAULT '',
  is_recurring INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- 12. Authenticated User Sessions (with RBAC role)
CREATE TABLE IF NOT EXISTS user_sessions (
  token TEXT PRIMARY KEY,
  role TEXT NOT NULL DEFAULT 'admin',
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMPTZ NOT NULL,
  last_activity_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE user_sessions ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'admin';

-- ============================================================================
-- Performance Indexes
-- ============================================================================
CREATE INDEX IF NOT EXISTS idx_da_date ON daily_attendance (date);
CREATE INDEX IF NOT EXISTS idx_da_staff_date ON daily_attendance (staff_no, date);
CREATE INDEX IF NOT EXISTS idx_rp_staff_date ON raw_punches (staff_no, date);
CREATE INDEX IF NOT EXISTS idx_adv_staff_date ON advances (staff_no, date);
CREATE INDEX IF NOT EXISTS idx_audit_staff_date ON audit_logs (staff_no, date);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON user_sessions (expires_at);

-- ============================================================================
-- Atomic @supabase/supabase-js RPC Helpers (Restricted strictly to service_role)
-- Allows direct atomic PostgreSQL queries & multi-statement transactions via
-- supabase.rpc('exec_attendance_sql', ...) and supabase.rpc('exec_attendance_batch', ...)
-- ============================================================================
CREATE OR REPLACE FUNCTION exec_attendance_sql(query_text TEXT, target_schema TEXT DEFAULT 'public')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result_rows JSONB;
  trimmed_sql TEXT;
BEGIN
  IF target_schema IS NOT NULL AND target_schema <> '' AND target_schema ~ '^[a-zA-Z0-9_]+$' THEN
    EXECUTE format('SET LOCAL search_path TO %I, public', target_schema);
  END IF;

  trimmed_sql := btrim(regexp_replace(query_text, ';\s*$', ''));

  IF trimmed_sql ~* '^\s*(SELECT|WITH|SHOW|VALUES)\b' OR trimmed_sql ~* '\bRETURNING\b' THEN
    EXECUTE format('SELECT COALESCE(jsonb_agg(row_to_json(t)), ''[]''::jsonb) FROM (%s) t', trimmed_sql)
      INTO result_rows;
    RETURN COALESCE(result_rows, '[]'::jsonb);
  ELSE
    EXECUTE trimmed_sql;
    RETURN '[]'::jsonb;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION exec_attendance_batch(queries TEXT[], target_schema TEXT DEFAULT 'public')
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  q TEXT;
  executed_count INTEGER := 0;
BEGIN
  IF target_schema IS NOT NULL AND target_schema <> '' AND target_schema ~ '^[a-zA-Z0-9_]+$' THEN
    EXECUTE format('SET LOCAL search_path TO %I, public', target_schema);
  END IF;

  -- Entire PL/pgSQL function executes inside a single atomic PostgreSQL transaction.
  -- Any error rolls back all statements automatically.
  FOREACH q IN ARRAY queries LOOP
    IF btrim(q) <> '' THEN
      EXECUTE q;
      executed_count := executed_count + 1;
    END IF;
  END LOOP;

  RETURN jsonb_build_object('executed', executed_count);
END;
$$;

-- Lock down RPC execution strictly to Supabase service_role (never anon or authenticated)
REVOKE ALL ON FUNCTION exec_attendance_sql(TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION exec_attendance_batch(TEXT[], TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION exec_attendance_sql(TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION exec_attendance_batch(TEXT[], TEXT) TO service_role;
