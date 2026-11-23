ALTER TABLE captures ADD COLUMN barcode_evidence jsonb;

CREATE TABLE capture_uploads (
    id uuid PRIMARY KEY,
    client_capture_id uuid NOT NULL,
    technician_id uuid NOT NULL REFERENCES users,
    image_object_key text NOT NULL UNIQUE,
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    barcode_evidence jsonb,
    byte_length integer NOT NULL CHECK (byte_length BETWEEN 1 AND 12582912),
    captured_at_device timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (technician_id, client_capture_id)
);

CREATE TABLE jobs (
    id uuid PRIMARY KEY,
    kind text NOT NULL CHECK (kind = 'LABEL_RECOGNITION'),
    capture_id uuid NOT NULL REFERENCES captures,
    status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED')),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_run_at timestamptz NOT NULL DEFAULT now(),
    locked_at timestamptz,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (kind, capture_id)
);
CREATE INDEX jobs_reservation_idx ON jobs (next_run_at, id) WHERE status = 'PENDING';
