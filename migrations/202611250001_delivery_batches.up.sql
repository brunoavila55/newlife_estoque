-- Lotes de devolução montados pelo técnico e conferidos pelo estoque.
-- O lote declara a intenção de entrega; a custódia só muda pela confirmação
-- item a item da sessão de recebimento vinculada.

ALTER TABLE captures ADD CONSTRAINT captures_id_technician_key UNIQUE (id, technician_id);
ALTER TABLE receipt_sessions ADD CONSTRAINT receipt_sessions_id_technician_key UNIQUE (id, technician_id);

CREATE TABLE delivery_batches (
    id uuid PRIMARY KEY,
    number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    technician_id uuid NOT NULL REFERENCES users,
    status text NOT NULL DEFAULT 'SUBMITTED'
        CHECK (status IN ('SUBMITTED', 'RECEIVING', 'CLOSED', 'CANCELLED')),
    notes text CHECK (length(notes) BETWEEN 1 AND 500),
    receipt_session_id uuid UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE (id, technician_id),
    FOREIGN KEY (receipt_session_id, technician_id) REFERENCES receipt_sessions (id, technician_id),
    CHECK ((status IN ('RECEIVING', 'CLOSED')) = (receipt_session_id IS NOT NULL)),
    CHECK ((status IN ('CLOSED', 'CANCELLED')) = (finished_at IS NOT NULL))
);
CREATE INDEX delivery_batches_technician_idx ON delivery_batches (technician_id, created_at DESC, id DESC);
CREATE INDEX delivery_batches_status_idx ON delivery_batches (status, created_at, id);

CREATE TABLE delivery_batch_items (
    batch_id uuid NOT NULL,
    technician_id uuid NOT NULL,
    capture_id uuid NOT NULL,
    active boolean NOT NULL DEFAULT true,
    added_by uuid NOT NULL REFERENCES users,
    added_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (batch_id, capture_id),
    FOREIGN KEY (batch_id, technician_id) REFERENCES delivery_batches (id, technician_id),
    FOREIGN KEY (capture_id, technician_id) REFERENCES captures (id, technician_id)
);
-- Uma coleta só pode estar em um lote ainda não encerrado.
CREATE UNIQUE INDEX delivery_batch_items_active_idx ON delivery_batch_items (capture_id) WHERE active;

CREATE FUNCTION protect_delivery_batch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.number, NEW.technician_id, NEW.notes, NEW.created_at)
        IS DISTINCT FROM (OLD.id, OLD.number, OLD.technician_id, OLD.notes, OLD.created_at)
        OR OLD.status IN ('CLOSED', 'CANCELLED')
        OR (OLD.receipt_session_id IS NOT NULL AND NEW.receipt_session_id IS DISTINCT FROM OLD.receipt_session_id)
        OR NOT ((OLD.status, NEW.status) IN (
            ('SUBMITTED', 'SUBMITTED'), ('SUBMITTED', 'RECEIVING'), ('SUBMITTED', 'CANCELLED'),
            ('RECEIVING', 'RECEIVING'), ('RECEIVING', 'CLOSED'))) THEN
        RAISE EXCEPTION 'Transição de lote não permitida';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_delivery_batch BEFORE UPDATE ON delivery_batches
    FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch();

CREATE FUNCTION protect_delivery_batch_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    batch_status text;
BEGIN
    SELECT status INTO STRICT batch_status FROM delivery_batches WHERE id = NEW.batch_id FOR SHARE;
    IF TG_OP = 'INSERT' THEN
        IF batch_status NOT IN ('SUBMITTED', 'RECEIVING') OR NOT NEW.active THEN
            RAISE EXCEPTION 'O lote não aceita novos itens';
        END IF;
    ELSIF (NEW.batch_id, NEW.technician_id, NEW.capture_id, NEW.added_by, NEW.added_at)
            IS DISTINCT FROM (OLD.batch_id, OLD.technician_id, OLD.capture_id, OLD.added_by, OLD.added_at)
        OR (NEW.active AND NOT OLD.active) THEN
        RAISE EXCEPTION 'O item do lote admite apenas a liberação ao encerrar';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_delivery_batch_item BEFORE INSERT OR UPDATE ON delivery_batch_items
    FOR EACH ROW EXECUTE FUNCTION protect_delivery_batch_item();

CREATE TRIGGER protect_delivery_batch_history BEFORE DELETE OR TRUNCATE ON delivery_batches
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER protect_delivery_batch_item_history BEFORE DELETE OR TRUNCATE ON delivery_batch_items
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
