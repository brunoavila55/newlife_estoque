ALTER TABLE ocr_results ADD COLUMN duration_ms bigint CHECK (duration_ms >= 0);
CREATE INDEX audit_events_recent_idx ON audit_events (created_at DESC, id DESC);
