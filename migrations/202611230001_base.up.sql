CREATE TABLE users (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 120),
    login text NOT NULL UNIQUE CHECK (login ~ '^[a-z0-9_.-]{3,64}$'),
    password_hash text NOT NULL,
    role text NOT NULL CHECK (role IN ('technician', 'warehouse_clerk', 'administrator')),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
    token_hash bytea PRIMARY KEY CHECK (octet_length(token_hash) = 32),
    refresh_hash bytea NOT NULL UNIQUE CHECK (octet_length(refresh_hash) = 32),
    user_id uuid NOT NULL REFERENCES users,
    expires_at timestamptz NOT NULL,
    renew_until timestamptz NOT NULL CHECK (renew_until >= expires_at)
);
CREATE INDEX sessions_user_idx ON sessions (user_id);
CREATE INDEX sessions_renew_until_idx ON sessions (renew_until);

CREATE TABLE locations (
    id uuid PRIMARY KEY,
    name text NOT NULL UNIQUE
);
INSERT INTO locations (id, name)
VALUES ('00000000-0000-4000-8000-000000000001', 'Depósito piloto');

CREATE TABLE equipment (
    id uuid PRIMARY KEY,
    technician_id uuid REFERENCES users,
    warehouse_id uuid REFERENCES locations,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(technician_id, warehouse_id) = 1)
);
CREATE INDEX equipment_technician_idx ON equipment (technician_id, id);

CREATE TABLE equipment_identifiers (
    equipment_id uuid NOT NULL REFERENCES equipment,
    kind text NOT NULL CHECK (kind IN ('SERIAL', 'MAC', 'BARCODE')),
    raw_value text NOT NULL,
    normalized_value text NOT NULL CHECK (length(normalized_value) BETWEEN 1 AND 128),
    verified_by uuid NOT NULL REFERENCES users,
    verified_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (equipment_id, kind, normalized_value),
    CHECK (kind <> 'MAC' OR normalized_value ~ '^[0-9A-F]{12}$')
);
CREATE INDEX equipment_identifier_lookup_idx ON equipment_identifiers (kind, normalized_value);

CREATE TABLE captures (
    id uuid PRIMARY KEY,
    client_capture_id uuid NOT NULL,
    technician_id uuid NOT NULL REFERENCES users,
    equipment_id uuid REFERENCES equipment,
    image_object_key text NOT NULL UNIQUE,
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    captured_at_device timestamptz NOT NULL,
    received_at_server timestamptz NOT NULL DEFAULT now(),
    review_issue jsonb,
    validated_identifiers jsonb,
    status text NOT NULL DEFAULT 'RECEIVED'
        CHECK (status IN ('RECEIVED', 'OCR_PENDING', 'OCR_PROCESSING', 'NEEDS_REVIEW', 'OCR_FAILED', 'IDENTIFIED')),
    UNIQUE (technician_id, client_capture_id),
    UNIQUE (id, equipment_id, technician_id),
    CHECK ((status = 'IDENTIFIED') = (equipment_id IS NOT NULL)),
    CHECK ((status = 'IDENTIFIED') = (validated_identifiers IS NOT NULL)),
    CHECK (review_issue IS NULL OR status = 'NEEDS_REVIEW')
);

CREATE TABLE custody_movements (
    id uuid PRIMARY KEY,
    equipment_id uuid NOT NULL REFERENCES equipment,
    from_technician_id uuid REFERENCES users,
    from_warehouse_id uuid REFERENCES locations,
    to_technician_id uuid REFERENCES users,
    to_warehouse_id uuid REFERENCES locations,
    capture_id uuid UNIQUE REFERENCES captures,
    actor_id uuid NOT NULL REFERENCES users,
    movement_type text NOT NULL CHECK (movement_type = 'COLLECTION_VALIDATED'),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    FOREIGN KEY (capture_id, equipment_id, to_technician_id)
        REFERENCES captures (id, equipment_id, technician_id) DEFERRABLE INITIALLY DEFERRED,
    CHECK (num_nonnulls(to_technician_id, to_warehouse_id) = 1),
    CHECK (from_technician_id IS NULL AND from_warehouse_id IS NULL
        AND to_technician_id IS NOT NULL AND capture_id IS NOT NULL)
);
CREATE UNIQUE INDEX custody_initial_idx ON custody_movements (equipment_id)
    WHERE movement_type = 'COLLECTION_VALIDATED';

CREATE TABLE audit_events (
    id uuid PRIMARY KEY,
    actor_id uuid NOT NULL REFERENCES users,
    action text NOT NULL,
    entity_type text NOT NULL,
    entity_id uuid NOT NULL,
    before_json jsonb,
    after_json jsonb,
    request_id uuid NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_entity_idx ON audit_events (entity_type, entity_id, created_at);

CREATE FUNCTION reject_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'O histórico de custódia e auditoria é permanente';
END;
$$;
CREATE TRIGGER protect_custody_history BEFORE UPDATE OR DELETE OR TRUNCATE ON custody_movements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER protect_audit_history BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_events
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();

CREATE FUNCTION check_current_custody() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE CONSTRAINT TRIGGER equipment_custody_consistency
    AFTER INSERT OR UPDATE ON equipment DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_current_custody();
CREATE CONSTRAINT TRIGGER movement_custody_consistency
    AFTER INSERT ON custody_movements DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_current_custody();
