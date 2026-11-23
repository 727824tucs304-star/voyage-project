-- Idempotent schema applied on every container start (CREATE ... IF NOT EXISTS).
-- Future schema changes must be additive, or move to a migration version table.
CREATE TABLE IF NOT EXISTS company (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS destinations (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS trips (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  destination_id INTEGER REFERENCES destinations(id) ON DELETE SET NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL CHECK (end_date >= start_date),
  budget NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (budget >= 0),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','ongoing','completed','cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS itinerary_events (
  id SERIAL PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  location TEXT,
  event_date DATE NOT NULL,
  event_time TIME,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'activity' CHECK (category IN ('transport','accommodation','activity','meal','other')),
  estimated_cost NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (estimated_cost >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS expenses (
  id SERIAL PRIMARY KEY,
  trip_id INTEGER REFERENCES trips(id) ON DELETE SET NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('transport','accommodation','food','activities','shopping','other')),
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  expense_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_trip ON itinerary_events (trip_id, event_date, event_time);
CREATE INDEX IF NOT EXISTS idx_expenses_trip ON expenses (trip_id);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS settings_history (
  id SERIAL PRIMARY KEY,
  setting_key TEXT NOT NULL,
  old_value TEXT,
  new_value TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS release_notes (
  id SERIAL PRIMARY KEY,
  version TEXT NOT NULL,
  kind TEXT NOT NULL,
  commit_hash TEXT,
  message TEXT NOT NULL,
  released_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS usage_daily (
  day DATE PRIMARY KEY,
  api_requests INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS trip_details (
  id SERIAL PRIMARY KEY,
  trip_id INTEGER NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('stay','transport','contact','note')),
  title TEXT NOT NULL,
  reference TEXT,
  starts_on DATE,
  ends_on DATE,
  time_text TEXT,
  phone TEXT,
  amount NUMERIC(12,2) CHECK (amount >= 0),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_trip_details_trip ON trip_details (trip_id, kind);
CREATE TABLE IF NOT EXISTS meetings (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT,
  category TEXT NOT NULL DEFAULT 'other'
    CHECK (category IN ('legal_intake','internal_case','client_call','board','other')),
  meeting_date DATE NOT NULL,
  participants JSONB NOT NULL DEFAULT '[]'::jsonb,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','uploaded','queued','transcribing','analysing','completed','failed')),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS recordings (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  content_type TEXT NOT NULL,
  storage_key TEXT NOT NULL,
  bytes BIGINT NOT NULL CHECK (bytes > 0),
  duration_seconds NUMERIC(10,2),
  uploaded_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS processing_jobs (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK (state IN ('queued','transcribing','analysing','completed','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_meetings_date ON meetings (meeting_date);
CREATE INDEX IF NOT EXISTS idx_jobs_meeting ON processing_jobs (meeting_id, state);
ALTER TABLE meetings DROP CONSTRAINT IF EXISTS meetings_status_check;
ALTER TABLE meetings ADD CONSTRAINT meetings_status_check
  CHECK (status IN ('draft','uploaded','queued','transcribing','transcribed','analysing','completed','failed'));
CREATE TABLE IF NOT EXISTS transcript_segments (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  speaker TEXT,
  start_sec NUMERIC(10,2) NOT NULL,
  end_sec NUMERIC(10,2) NOT NULL,
  text TEXT NOT NULL,
  UNIQUE (meeting_id, seq)
);
ALTER TABLE processing_jobs ADD COLUMN IF NOT EXISTS stage TEXT NOT NULL DEFAULT 'transcribe';
CREATE TABLE IF NOT EXISTS meeting_analysis (
  meeting_id INTEGER PRIMARY KEY REFERENCES meetings(id) ON DELETE CASCADE,
  executive_summary TEXT,
  detailed_summary TEXT,
  key_points JSONB NOT NULL DEFAULT '[]'::jsonb,
  decisions JSONB NOT NULL DEFAULT '[]'::jsonb,
  follow_ups JSONB NOT NULL DEFAULT '[]'::jsonb,
  open_questions JSONB NOT NULL DEFAULT '[]'::jsonb,
  risks JSONB NOT NULL DEFAULT '[]'::jsonb,
  legal JSONB,
  provider TEXT,
  model TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS action_items (
  id SERIAL PRIMARY KEY,
  meeting_id INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  description TEXT NOT NULL,
  owner TEXT,
  due_text TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  origin TEXT NOT NULL DEFAULT 'ai' CHECK (origin IN ('ai','manual')),
  source_seq INTEGER,
  source_start NUMERIC(10,2),
  source_end NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items (meeting_id);
ALTER TABLE meetings ADD COLUMN IF NOT EXISTS sector TEXT;
ALTER TABLE meeting_analysis ADD COLUMN IF NOT EXISTS sector TEXT;
ALTER TABLE meeting_analysis ADD COLUMN IF NOT EXISTS sector_fields JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE meeting_analysis ADD COLUMN IF NOT EXISTS flags JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE meeting_analysis ADD COLUMN IF NOT EXISTS review_notes JSONB NOT NULL DEFAULT '[]'::jsonb;

DO $$
DECLARE c record;
BEGIN
  FOR c IN SELECT conname FROM pg_constraint
           WHERE conrelid = 'meetings'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%legal_intake%'
  LOOP
    EXECUTE format('ALTER TABLE meetings DROP CONSTRAINT %I', c.conname);
  END LOOP;
  ALTER TABLE meetings ADD CONSTRAINT meetings_category_check
    CHECK (category IN ('legal_intake','internal_case','client_call','board','other','healthcare','financial','hr'));
END $$;
