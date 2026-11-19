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
CREATE TABLE IF NOT EXISTS usage_daily (
  slug TEXT NOT NULL,
  day DATE NOT NULL,
  api_requests BIGINT NOT NULL DEFAULT 0,
  storage_bytes BIGINT NOT NULL DEFAULT 0,
  running_samples INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (slug, day)
);
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS cpu_percent_sum DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS stat_samples INTEGER NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS mem_bytes_sum DOUBLE PRECISION NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS mem_peak_bytes BIGINT NOT NULL DEFAULT 0;
ALTER TABLE usage_daily ADD COLUMN IF NOT EXISTS network_bytes BIGINT NOT NULL DEFAULT 0;
CREATE TABLE IF NOT EXISTS pricing_rules (
  key TEXT PRIMARY KEY,
  value NUMERIC NOT NULL CHECK (value >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by TEXT
);
CREATE TABLE IF NOT EXISTS aws_cost_records (
  period_month TEXT NOT NULL,
  service TEXT NOT NULL,
  amount_usd NUMERIC NOT NULL,
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (period_month, service)
);
CREATE TABLE IF NOT EXISTS aws_sync_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  status TEXT NOT NULL,
  message TEXT,
  last_attempt TIMESTAMPTZ,
  last_success TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS billing_summaries (
  slug TEXT NOT NULL REFERENCES tenants(slug),
  month TEXT NOT NULL,
  usage_charges NUMERIC NOT NULL,
  allocated_aws NUMERIC NOT NULL,
  platform_fee NUMERIC NOT NULL,
  total NUMERIC NOT NULL,
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, month)
);
