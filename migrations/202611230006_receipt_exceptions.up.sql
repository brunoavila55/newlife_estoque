CREATE TABLE receipt_exceptions (
    clerk_id uuid NOT NULL REFERENCES users,
    warehouse_id uuid NOT NULL REFERENCES locations,
    value text NOT NULL CHECK (length(value) BETWEEN 1 AND 128),
    result text NOT NULL CHECK (result IN ('AMBIGUOUS', 'UNKNOWN')),
    seen_at timestamptz NOT NULL DEFAULT now(),
    resolved_at timestamptz,
    PRIMARY KEY (clerk_id, warehouse_id, value)
);
