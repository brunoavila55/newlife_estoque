CREATE INDEX custody_technician_deliveries_idx
    ON custody_movements (from_technician_id, occurred_at DESC, id DESC)
    WHERE movement_type = 'WAREHOUSE_RECEIVED';
