CREATE TABLE IF NOT EXISTS tenants (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  company_name TEXT NOT NULL,
  admin_name TEXT NOT NULL,
  admin_email TEXT NOT NULL,
  admin_password_hash TEXT,              -- only held until the first successful provisioning, then cleared
  domain TEXT NOT NULL UNIQUE,
  db_name TEXT NOT NULL UNIQUE,
  db_user TEXT NOT NULL UNIQUE,
  container_name TEXT NOT NULL UNIQUE,
  version TEXT NOT NULL,
  previous_version TEXT,
  status TEXT NOT NULL CHECK (status IN ('provisioning','ready','updating','failed')),
  current_step TEXT,
  error_message TEXT,
  provisioning_log JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (admin_email, company_name)
);
CREATE TABLE IF NOT EXISTS builds (
  id BIGSERIAL PRIMARY KEY,
  version TEXT NOT NULL UNIQUE,
  commit_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
  log TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS deployments (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('deploy','rollback')),
  from_version TEXT,
  to_version TEXT NOT NULL,
  commit_hash TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','rolled_back')),
  detail TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_message TEXT NOT NULL DEFAULT '';
ALTER TABLE builds ADD COLUMN IF NOT EXISTS commit_date TEXT NOT NULL DEFAULT '';
