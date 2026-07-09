-- Add processing status for bulk R2 scan
ALTER TABLE candidates ADD COLUMN status TEXT NOT NULL DEFAULT 'completed';
ALTER TABLE candidates ADD COLUMN error_message TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_candidates_r2_key ON candidates(r2_object_key);
CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
