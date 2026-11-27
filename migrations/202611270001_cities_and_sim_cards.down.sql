-- A reversão só é possível enquanto não houver chips nem registros nas novas cidades.
DROP TABLE sim_movements;
DROP TABLE sim_transfers;
DROP TABLE sim_cards;
DROP TABLE sim_imports;
DROP FUNCTION protect_sim_card();
DROP FUNCTION check_sim_custody();
DROP FUNCTION check_sim_movement_chain();

DROP INDEX users_location_idx;
ALTER TABLE users DROP CONSTRAINT users_location_required;
ALTER TABLE users DROP COLUMN location_id;

DELETE FROM locations WHERE id IN
    ('00000000-0000-4000-8000-000000000002', '00000000-0000-4000-8000-000000000003');
UPDATE locations SET name = 'Depósito piloto' WHERE id = '00000000-0000-4000-8000-000000000001';
