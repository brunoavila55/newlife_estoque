#!/bin/sh
set -eu
psql --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" --set ON_ERROR_STOP=1 <<'SQL'
\getenv runtime_password STOCK_DB_APP_PASSWORD
SELECT format('CREATE ROLE stock_runtime LOGIN PASSWORD %L', :'runtime_password') \gexec
GRANT CONNECT ON DATABASE stock TO stock_runtime;
GRANT USAGE ON SCHEMA public TO stock_runtime;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO stock_runtime;
SQL
