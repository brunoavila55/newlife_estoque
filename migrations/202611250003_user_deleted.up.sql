-- Exclusão de usuário com histórico: a conta sai das listas e não entra mais,
-- mas a linha permanece para preservar a cadeia de custódia e a auditoria.
-- Contas sem nenhum vínculo são apagadas de verdade pela API.
ALTER TABLE users ADD COLUMN deleted_at timestamptz;
ALTER TABLE users ADD CONSTRAINT users_deleted_inactive CHECK (deleted_at IS NULL OR NOT active);
