-- D1 schema for Resume Analyzer candidates
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  name TEXT,
  date_of_birth TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  education TEXT,          -- JSON array
  work_experience TEXT,    -- JSON array
  responsibilities TEXT,   -- JSON array
  achievements TEXT,       -- JSON array
  skills TEXT,             -- JSON array
  certifications TEXT,     -- JSON array
  r2_object_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed',
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_r2_key ON candidates(r2_object_key);
CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
