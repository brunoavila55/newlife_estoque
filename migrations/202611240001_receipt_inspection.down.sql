DO $$ BEGIN
    IF EXISTS (SELECT FROM receipt_items WHERE inspection IS NOT NULL) THEN
        RAISE EXCEPTION 'Existem conferências de conservação registradas';
    END IF;
END $$;
ALTER TABLE receipt_items DROP COLUMN inspection;
