ALTER TABLE users DROP CONSTRAINT users_deleted_inactive;
ALTER TABLE users DROP COLUMN deleted_at;
