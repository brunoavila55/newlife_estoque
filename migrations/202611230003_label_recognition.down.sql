DROP TABLE ocr_results;
DROP INDEX captures_review_queue_idx;
DROP INDEX jobs_recovery_idx;
ALTER TABLE jobs DROP COLUMN run_id;
