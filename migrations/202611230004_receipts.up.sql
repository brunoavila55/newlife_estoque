CREATE TABLE receipt_sessions (
    id uuid PRIMARY KEY,
    technician_id uuid NOT NULL REFERENCES users,
    warehouse_id uuid NOT NULL REFERENCES locations,
    clerk_id uuid NOT NULL REFERENCES users,
    opened_at timestamptz NOT NULL DEFAULT now(),
    closed_at timestamptz,
    closing_reason text CHECK (length(closing_reason) BETWEEN 1 AND 500),
    UNIQUE (id, technician_id, warehouse_id, clerk_id),
    CHECK (closing_reason IS NULL OR closed_at IS NOT NULL)
);
CREATE INDEX receipt_sessions_clerk_idx ON receipt_sessions (clerk_id, opened_at DESC, id DESC);

CREATE TABLE receipt_items (
    session_id uuid NOT NULL REFERENCES receipt_sessions,
    equipment_id uuid NOT NULL REFERENCES equipment,
    confirmed_scan_id uuid,
    confirmed_at timestamptz,
    PRIMARY KEY (session_id, equipment_id),
    UNIQUE (session_id, equipment_id, confirmed_scan_id),
    CHECK (num_nonnulls(confirmed_scan_id, confirmed_at) IN (0, 2))
);

CREATE TABLE receipt_scans (
    session_id uuid NOT NULL REFERENCES receipt_sessions,
    id uuid NOT NULL,
    equipment_id uuid,
    value text NOT NULL CHECK (length(value) BETWEEN 1 AND 128),
    secondary_value text CHECK (length(secondary_value) BETWEEN 1 AND 128),
    result text NOT NULL CHECK (result IN (
        'MATCHED', 'DUPLICATE_SCAN', 'UNKNOWN', 'AMBIGUOUS', 'OTHER_TECHNICIAN',
        'ALREADY_RECEIVED', 'NOT_IN_SESSION', 'IDENTIFIER_MISMATCH'
    )),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (session_id, id),
    UNIQUE (session_id, equipment_id, id),
    FOREIGN KEY (session_id, equipment_id) REFERENCES receipt_items,
    CHECK ((equipment_id IS NOT NULL) = (result IN ('MATCHED', 'DUPLICATE_SCAN')))
);
CREATE UNIQUE INDEX receipt_scans_match_idx ON receipt_scans (session_id, equipment_id) WHERE result = 'MATCHED';
CREATE INDEX receipt_scans_history_idx ON receipt_scans (session_id, created_at DESC, id DESC);
CREATE INDEX captures_receipt_photo_idx ON captures (equipment_id, technician_id, received_at_server DESC, id DESC)
    WHERE status = 'IDENTIFIED';
CREATE TRIGGER protect_receipt_scans BEFORE UPDATE OR DELETE OR TRUNCATE ON receipt_scans
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();

ALTER TABLE receipt_items ADD CONSTRAINT receipt_items_scan_fk
    FOREIGN KEY (session_id, equipment_id, confirmed_scan_id) REFERENCES receipt_scans (session_id, equipment_id, id);

ALTER TABLE custody_movements
    DROP CONSTRAINT custody_movements_movement_type_check,
    DROP CONSTRAINT custody_movements_check1,
    ADD COLUMN receipt_session_id uuid,
    ADD COLUMN receipt_scan_id uuid,
    ADD CONSTRAINT custody_movement_shape CHECK (
        (movement_type = 'COLLECTION_VALIDATED'
            AND from_technician_id IS NULL AND from_warehouse_id IS NULL
            AND to_technician_id IS NOT NULL AND capture_id IS NOT NULL
            AND receipt_session_id IS NULL AND receipt_scan_id IS NULL)
        OR
        (movement_type = 'WAREHOUSE_RECEIVED'
            AND from_technician_id IS NOT NULL AND from_warehouse_id IS NULL
            AND to_warehouse_id IS NOT NULL AND capture_id IS NULL
            AND receipt_session_id IS NOT NULL AND receipt_scan_id IS NOT NULL)
    ),
    ADD CONSTRAINT custody_movement_receipt_session_fk
        FOREIGN KEY (receipt_session_id, from_technician_id, to_warehouse_id, actor_id)
        REFERENCES receipt_sessions (id, technician_id, warehouse_id, clerk_id),
    ADD CONSTRAINT custody_movement_receipt_item_fk
        FOREIGN KEY (receipt_session_id, equipment_id, receipt_scan_id)
        REFERENCES receipt_items (session_id, equipment_id, confirmed_scan_id)
        DEFERRABLE INITIALLY DEFERRED;
CREATE UNIQUE INDEX custody_receipt_idx ON custody_movements (equipment_id) WHERE movement_type = 'WAREHOUSE_RECEIVED';

CREATE OR REPLACE FUNCTION check_current_custody() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    current_equipment equipment%ROWTYPE;
    collecting_technician uuid;
    receipt custody_movements%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'equipment' THEN
        SELECT * INTO STRICT current_equipment FROM equipment WHERE id = NEW.id;
    ELSE
        SELECT * INTO STRICT current_equipment FROM equipment WHERE id = NEW.equipment_id;
    END IF;
    SELECT to_technician_id INTO collecting_technician FROM custody_movements
        WHERE equipment_id = current_equipment.id AND movement_type = 'COLLECTION_VALIDATED';
    SELECT * INTO receipt FROM custody_movements
        WHERE equipment_id = current_equipment.id AND movement_type = 'WAREHOUSE_RECEIVED';
    IF receipt.id IS NOT NULL THEN
        IF collecting_technician IS DISTINCT FROM receipt.from_technician_id
            OR current_equipment.technician_id IS NOT NULL
            OR current_equipment.warehouse_id IS DISTINCT FROM receipt.to_warehouse_id THEN
            RAISE EXCEPTION 'A custódia atual precisa corresponder ao recebimento e à coleta';
        END IF;
    ELSIF current_equipment.technician_id IS DISTINCT FROM collecting_technician THEN
        RAISE EXCEPTION 'A custódia atual precisa corresponder ao movimento de coleta';
    END IF;
    RETURN NULL;
END;
$$;

CREATE FUNCTION check_receipt_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.confirmed_scan_id IS NOT NULL AND (
        NOT EXISTS (SELECT 1 FROM receipt_scans s
            WHERE s.session_id = NEW.session_id AND s.id = NEW.confirmed_scan_id AND s.result = 'MATCHED')
        OR NOT EXISTS (SELECT 1 FROM custody_movements m
            WHERE m.receipt_session_id = NEW.session_id AND m.equipment_id = NEW.equipment_id
                AND m.receipt_scan_id = NEW.confirmed_scan_id AND m.movement_type = 'WAREHOUSE_RECEIVED')
    ) THEN
        RAISE EXCEPTION 'A confirmação exige uma leitura válida e um movimento de custódia';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER receipt_confirmation_consistency
    AFTER INSERT OR UPDATE ON receipt_items DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_receipt_confirmation();

CREATE FUNCTION protect_receipt_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.closed_at IS NOT NULL OR
        (NEW.id, NEW.technician_id, NEW.warehouse_id, NEW.clerk_id, NEW.opened_at)
        IS DISTINCT FROM (OLD.id, OLD.technician_id, OLD.warehouse_id, OLD.clerk_id, OLD.opened_at) THEN
        RAISE EXCEPTION 'O escopo e o encerramento da sessão são permanentes';
    END IF;
    IF NEW.closed_at IS NOT NULL AND COALESCE(NEW.closing_reason, '') !~ '[^[:space:]]' AND (
        EXISTS (SELECT 1 FROM receipt_items WHERE session_id = NEW.id AND confirmed_at IS NULL)
        OR EXISTS (SELECT 1 FROM receipt_scans WHERE session_id = NEW.id
            AND result NOT IN ('MATCHED', 'DUPLICATE_SCAN'))
    ) THEN
        RAISE EXCEPTION 'O encerramento com pendências exige justificativa';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_receipt_closure BEFORE UPDATE ON receipt_sessions
    FOR EACH ROW EXECUTE FUNCTION protect_receipt_closure();
CREATE TRIGGER protect_receipt_history BEFORE DELETE OR TRUNCATE ON receipt_sessions
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();

CREATE FUNCTION require_open_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    closure timestamptz;
BEGIN
    SELECT closed_at INTO STRICT closure FROM receipt_sessions WHERE id = NEW.session_id FOR SHARE;
    IF closure IS NOT NULL THEN
        RAISE EXCEPTION 'A sessão já está encerrada';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF OLD.confirmed_at IS NOT NULL OR NEW.confirmed_at IS NULL
            OR (NEW.session_id, NEW.equipment_id) IS DISTINCT FROM (OLD.session_id, OLD.equipment_id) THEN
            RAISE EXCEPTION 'O item previsto admite apenas a primeira confirmação';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER require_open_receipt_item BEFORE INSERT OR UPDATE ON receipt_items
    FOR EACH ROW EXECUTE FUNCTION require_open_receipt();
CREATE TRIGGER require_open_receipt_scan BEFORE INSERT ON receipt_scans
    FOR EACH ROW EXECUTE FUNCTION require_open_receipt();
CREATE TRIGGER protect_receipt_items BEFORE DELETE OR TRUNCATE ON receipt_items
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
