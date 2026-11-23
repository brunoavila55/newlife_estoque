DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM receipt_sessions) THEN
        RAISE EXCEPTION 'A reversão apagaria sessões de recebimento. Preserve o histórico.';
    END IF;
END;
$$;

DROP INDEX custody_receipt_idx;
DROP INDEX captures_receipt_photo_idx;
ALTER TABLE custody_movements
    DROP CONSTRAINT custody_movement_receipt_item_fk,
    DROP CONSTRAINT custody_movement_receipt_session_fk,
    DROP CONSTRAINT custody_movement_shape,
    DROP COLUMN receipt_session_id,
    DROP COLUMN receipt_scan_id,
    ADD CONSTRAINT custody_movements_movement_type_check CHECK (movement_type = 'COLLECTION_VALIDATED'),
    ADD CONSTRAINT custody_movements_check1 CHECK (
        from_technician_id IS NULL AND from_warehouse_id IS NULL
        AND to_technician_id IS NOT NULL AND capture_id IS NOT NULL
    );

CREATE OR REPLACE FUNCTION check_current_custody() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_equipment equipment%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'equipment' THEN
        SELECT * INTO STRICT current_equipment FROM equipment WHERE id = NEW.id;
    ELSE
        SELECT * INTO STRICT current_equipment FROM equipment WHERE id = NEW.equipment_id;
    END IF;
    IF current_equipment.technician_id IS DISTINCT FROM (
        SELECT to_technician_id FROM custody_movements
        WHERE equipment_id = current_equipment.id AND movement_type = 'COLLECTION_VALIDATED'
    ) THEN
        RAISE EXCEPTION 'A custódia atual precisa corresponder ao movimento de coleta';
    END IF;
    RETURN NULL;
END;
$$;

ALTER TABLE receipt_items DROP CONSTRAINT receipt_items_scan_fk;
DROP TABLE receipt_scans, receipt_items, receipt_sessions;
DROP FUNCTION check_receipt_confirmation();
DROP FUNCTION require_open_receipt();
DROP FUNCTION protect_receipt_closure();
