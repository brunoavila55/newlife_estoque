DROP TABLE delivery_batch_items;
DROP TABLE delivery_batches;
DROP FUNCTION protect_delivery_batch_item();
DROP FUNCTION protect_delivery_batch();
ALTER TABLE receipt_sessions DROP CONSTRAINT receipt_sessions_id_technician_key;
ALTER TABLE captures DROP CONSTRAINT captures_id_technician_key;
