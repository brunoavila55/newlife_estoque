-- Cidades: cada local de estoque passa a ser uma cidade com estoque próprio.
-- O depósito piloto vira São Gabriel, preservando o histórico já registrado.
UPDATE locations SET name = 'São Gabriel' WHERE id = '00000000-0000-4000-8000-000000000001';
INSERT INTO locations (id, name) VALUES
    ('00000000-0000-4000-8000-000000000002', 'Bagé'),
    ('00000000-0000-4000-8000-000000000003', 'Passo Fundo');

-- Técnicos e estoquistas pertencem a uma cidade. O administrador pode ter uma
-- cidade de referência, mas enxerga e opera todas.
ALTER TABLE users ADD COLUMN location_id uuid REFERENCES locations;
UPDATE users SET location_id = '00000000-0000-4000-8000-000000000001';
ALTER TABLE users ADD CONSTRAINT users_location_required
    CHECK (role = 'administrator' OR location_id IS NOT NULL);
CREATE INDEX users_location_idx ON users (location_id, role);

-- ---------------------------------------------------------------------------
-- Chips (SIM cards) da MVNO
-- ---------------------------------------------------------------------------
-- O ICCID identifica o chip. Os campos da operadora (status, assinante, rede)
-- vêm da planilha e são apenas informativos: a custódia muda somente por
-- movimento registrado (importação, entrega ao técnico ou devolução).

CREATE TABLE sim_imports (
    id uuid PRIMARY KEY,
    location_id uuid NOT NULL REFERENCES locations,
    actor_id uuid NOT NULL REFERENCES users,
    file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
    summary jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sim_imports_location_idx ON sim_imports (location_id, created_at DESC, id DESC);

CREATE TABLE sim_cards (
    id uuid PRIMARY KEY,
    iccid text NOT NULL UNIQUE CHECK (iccid ~ '^[0-9]{19,20}$'),
    carrier text CHECK (length(carrier) BETWEEN 1 AND 60),
    mvno_display text CHECK (length(mvno_display) BETWEEN 1 AND 60),
    operator_status text CHECK (length(operator_status) BETWEEN 1 AND 60),
    subscriber text CHECK (length(subscriber) BETWEEN 1 AND 200),
    location_id uuid REFERENCES locations,
    technician_id uuid REFERENCES users,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (num_nonnulls(location_id, technician_id) = 1)
);
CREATE INDEX sim_cards_location_idx ON sim_cards (location_id, iccid) WHERE location_id IS NOT NULL;
CREATE INDEX sim_cards_technician_idx ON sim_cards (technician_id, iccid) WHERE technician_id IS NOT NULL;
-- Leitores que omitem o dígito verificador entregam só os 19 primeiros dígitos.
CREATE INDEX sim_cards_iccid_prefix_idx ON sim_cards (left(iccid, 19));

-- Entrega do estoque ao técnico ou devolução do técnico ao estoque.
CREATE TABLE sim_transfers (
    id uuid PRIMARY KEY,
    number bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    kind text NOT NULL CHECK (kind IN ('DELIVERY', 'RETURN')),
    location_id uuid NOT NULL REFERENCES locations,
    technician_id uuid NOT NULL REFERENCES users,
    clerk_id uuid NOT NULL REFERENCES users,
    notes text CHECK (length(notes) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (id, kind, location_id, technician_id, clerk_id)
);
CREATE INDEX sim_transfers_location_idx ON sim_transfers (location_id, created_at DESC, id DESC);
CREATE INDEX sim_transfers_technician_idx ON sim_transfers (technician_id, created_at DESC, id DESC);

CREATE TABLE sim_movements (
    id uuid PRIMARY KEY,
    seq bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
    sim_card_id uuid NOT NULL REFERENCES sim_cards,
    movement_type text NOT NULL CHECK (movement_type IN ('IMPORTED', 'DELIVERED', 'RETURNED')),
    from_location_id uuid REFERENCES locations,
    from_technician_id uuid REFERENCES users,
    to_location_id uuid REFERENCES locations,
    to_technician_id uuid REFERENCES users,
    import_id uuid REFERENCES sim_imports,
    transfer_id uuid,
    transfer_kind text,
    actor_id uuid NOT NULL REFERENCES users,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT sim_movement_shape CHECK (
        (movement_type = 'IMPORTED'
            AND from_location_id IS NULL AND from_technician_id IS NULL
            AND to_location_id IS NOT NULL AND to_technician_id IS NULL
            AND import_id IS NOT NULL AND transfer_id IS NULL AND transfer_kind IS NULL)
        OR
        (movement_type = 'DELIVERED'
            AND from_location_id IS NOT NULL AND from_technician_id IS NULL
            AND to_location_id IS NULL AND to_technician_id IS NOT NULL
            AND import_id IS NULL AND transfer_id IS NOT NULL AND transfer_kind = 'DELIVERY')
        OR
        (movement_type = 'RETURNED'
            AND from_location_id IS NULL AND from_technician_id IS NOT NULL
            AND to_location_id IS NOT NULL AND to_technician_id IS NULL
            AND import_id IS NULL AND transfer_id IS NOT NULL AND transfer_kind = 'RETURN')
    ),
    -- O movimento herda cidade, técnico e operador da própria entrega/devolução.
    CONSTRAINT sim_movement_transfer_fk
        FOREIGN KEY (transfer_id, transfer_kind, from_location_id, to_technician_id, actor_id)
        REFERENCES sim_transfers (id, kind, location_id, technician_id, clerk_id),
    CONSTRAINT sim_movement_return_fk
        FOREIGN KEY (transfer_id, transfer_kind, to_location_id, from_technician_id, actor_id)
        REFERENCES sim_transfers (id, kind, location_id, technician_id, clerk_id)
);
-- A FK composta só é verificada quando todas as colunas estão preenchidas:
-- a entrega usa a primeira (from_location/to_technician) e a devolução a segunda.
CREATE UNIQUE INDEX sim_movements_import_idx ON sim_movements (sim_card_id) WHERE movement_type = 'IMPORTED';
CREATE UNIQUE INDEX sim_movements_transfer_idx ON sim_movements (transfer_id, sim_card_id) WHERE transfer_id IS NOT NULL;
CREATE INDEX sim_movements_card_idx ON sim_movements (sim_card_id, seq DESC);

-- Cada movimento parte de onde o anterior terminou; o primeiro é a importação.
CREATE FUNCTION check_sim_movement_chain() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    previous sim_movements%ROWTYPE;
BEGIN
    PERFORM 1 FROM sim_cards WHERE id = NEW.sim_card_id FOR UPDATE;
    SELECT * INTO previous FROM sim_movements WHERE sim_card_id = NEW.sim_card_id ORDER BY seq DESC LIMIT 1;
    IF previous.id IS NULL THEN
        IF NEW.movement_type <> 'IMPORTED' THEN
            RAISE EXCEPTION 'O primeiro movimento do chip precisa ser a importação';
        END IF;
    ELSIF NEW.movement_type = 'IMPORTED'
        OR (NEW.from_location_id, NEW.from_technician_id)
            IS DISTINCT FROM (previous.to_location_id, previous.to_technician_id) THEN
        RAISE EXCEPTION 'O movimento do chip precisa partir da custódia atual';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER sim_movement_chain BEFORE INSERT ON sim_movements
    FOR EACH ROW EXECUTE FUNCTION check_sim_movement_chain();

-- A custódia materializada no chip precisa corresponder ao último movimento.
CREATE FUNCTION check_sim_custody() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    card sim_cards%ROWTYPE;
    latest sim_movements%ROWTYPE;
BEGIN
    IF TG_TABLE_NAME = 'sim_cards' THEN
        SELECT * INTO STRICT card FROM sim_cards WHERE id = NEW.id;
    ELSE
        SELECT * INTO STRICT card FROM sim_cards WHERE id = NEW.sim_card_id;
    END IF;
    SELECT * INTO latest FROM sim_movements WHERE sim_card_id = card.id ORDER BY seq DESC LIMIT 1;
    IF latest.id IS NULL OR (card.location_id, card.technician_id)
        IS DISTINCT FROM (latest.to_location_id, latest.to_technician_id) THEN
        RAISE EXCEPTION 'A custódia atual do chip precisa corresponder ao último movimento';
    END IF;
    RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER sim_card_custody_consistency
    AFTER INSERT OR UPDATE ON sim_cards DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_sim_custody();
CREATE CONSTRAINT TRIGGER sim_movement_custody_consistency
    AFTER INSERT ON sim_movements DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION check_sim_custody();

CREATE FUNCTION protect_sim_card() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.id, NEW.iccid, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.iccid, OLD.created_at) THEN
        RAISE EXCEPTION 'O ICCID e a origem do chip são permanentes';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER protect_sim_card BEFORE UPDATE ON sim_cards
    FOR EACH ROW EXECUTE FUNCTION protect_sim_card();

CREATE TRIGGER protect_sim_card_history BEFORE DELETE OR TRUNCATE ON sim_cards
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER protect_sim_movement_history BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_movements
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER protect_sim_transfer_history BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_transfers
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
CREATE TRIGGER protect_sim_import_history BEFORE UPDATE OR DELETE OR TRUNCATE ON sim_imports
    FOR EACH STATEMENT EXECUTE FUNCTION reject_history_change();
