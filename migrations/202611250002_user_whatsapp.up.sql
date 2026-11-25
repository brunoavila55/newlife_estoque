-- WhatsApp para envio do comprovante de devolução em texto (sem papel).
-- Guardado só com dígitos, com código do país (ex.: 5511987654321).
ALTER TABLE users ADD COLUMN whatsapp text
    CHECK (whatsapp ~ '^[1-9][0-9]{11,14}$');
