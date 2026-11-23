ALTER TABLE jobs ADD COLUMN run_id uuid;
CREATE INDEX jobs_recovery_idx ON jobs (locked_at, id) WHERE status = 'RUNNING';
CREATE INDEX captures_review_queue_idx ON captures (received_at_server DESC, id DESC);

CREATE TABLE ocr_results (
    id uuid PRIMARY KEY,
    capture_id uuid NOT NULL REFERENCES captures,
    provider text NOT NULL,
    model_version text NOT NULL,
    status text NOT NULL CHECK (status IN ('RECOGNIZED', 'FAILED')),
    raw_tsv text,
    suggestions jsonb NOT NULL,
    warnings jsonb NOT NULL,
    failure_code text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'RECOGNIZED') = (raw_tsv IS NOT NULL)),
    CHECK ((status = 'FAILED') = (failure_code IS NOT NULL))
);

CREATE INDEX ocr_results_capture_idx ON ocr_results (capture_id, created_at DESC, id DESC);
CREATE TRIGGER protect_ocr_history BEFORE UPDATE OR DELETE OR TRUNCATE ON ocr_results
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
