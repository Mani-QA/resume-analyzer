-- Migration: create candidates table
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  name TEXT,
  date_of_birth TEXT,
  email TEXT,
  phone TEXT,
  address TEXT,
  education TEXT,
  work_experience TEXT,
  responsibilities TEXT,
  achievements TEXT,
  skills TEXT,
  certifications TEXT,
  r2_object_key TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_candidates_email ON candidates(email);
