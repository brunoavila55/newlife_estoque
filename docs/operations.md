# Operação e recuperação

## Produção

- Sirva o PWA e os endpoints `/api` na mesma origem HTTPS. Mantenha o processo Axum atrás do proxy. Configure limite de requisições nas rotas `/api/v1/auth/login` e `/api/v1/auth/web/login`, preservando o retorno HTTP 429. O proxy precisa aceitar requisições de imagem de até 12 MiB.
- Configure `S3_ALLOW_HTTP=false` e um endpoint HTTPS que o navegador consiga acessar para URLs temporárias. Use bucket privado, criptografia em repouso e credenciais limitadas ao bucket. A prontidão usa permissão de listagem no bucket. O worker precisa ler as imagens.
- Configure `DATABASE_URL` com `sslmode=verify-full` e a CA do servidor. Use credenciais de administração para executar `stock-api migrate` e `bootstrap-admin`. Defina `API_AUTO_MIGRATE=false` na API e no worker e use contas PostgreSQL sem privilégios de DDL na operação regular, com leitura de `_sqlx_migrations` para a prontidão.
- Mantenha as credenciais da API, do worker, dos backups e do coletor em armazenamento de segredos. Após uma restauração para produção, aplique novamente as permissões PostgreSQL e do storage segundo o ambiente de destino.
- Use encerramento gracioso no supervisor. A API aguarda requisições em curso e a reserva de OCR interrompida volta a ficar disponível após expirar.

## Saúde, métricas e auditoria

`GET /health` verifica o processo. `GET /ready` compara as migrations aplicadas e testa a listagem S3 e responde 503 quando uma dependência falha. Para liberar `GET /metrics`, defina `METRICS_TOKEN` com um token próprio de no mínimo 32 caracteres e configure o coletor para enviá-lo como `Authorization: Bearer`. Mantenha a rota acessível pela rede do coletor. [Configuração HTTP do Prometheus](https://prometheus.io/docs/prometheus/latest/configuration/configuration/#http_config)

| Métrica | Significado |
| --- | --- |
| `stock_uploads_pending` | Uploads iniciados na API que ainda carecem de confirmação. Fotos apenas no IndexedDB ficam visíveis no PWA de origem. |
| `stock_upload_failures_total` | Respostas de falha do envio da imagem e da conclusão. É reiniciado com o processo. |
| `stock_jobs_overdue` | Jobs prontos há mais de um minuto ou com reserva expirada. |
| `stock_ocr_recognized_captures` | Capturas com ao menos uma leitura bem-sucedida. |
| `stock_ocr_reviewed_captures` | Entre as capturas lidas pelo OCR, as que tiveram validação ou pendência registrada por administrador. Divida pelo total de reconhecidas para acompanhar a taxa. |
| `stock_ocr_duration_seconds_count` e `stock_ocr_duration_seconds_sum` | Contagem e duração de tentativas com medição. Abrange a leitura do objeto e o OCR. |
| `stock_receipt_divergences_total` | Leituras divergentes registradas nas sessões. Leituras duplicadas são contabilizadas no relatório de recebimento. |

O administrador pode consultar `GET /api/v1/audit-events` por `entity_id` e paginar a resposta. Relacione o `request_id` do evento ou da resposta HTTP com o log do servidor. O relatório de retenção em `GET /api/v1/admin/retention-report?older_than_days=30` conta uploads incompletos e capturas confirmadas mais antigas que a janela escolhida. A janela é um filtro de relatório. Use os volumes e as obrigações aplicáveis à operação para aprovar prazos de retenção antes de implantar exclusões. As fotos confirmadas e os registros de custódia permanecem preservados. A cópia local segue a política do PWA.

## Backup

Use `pg_dump` e `pg_restore` compatíveis com a versão do servidor. Os comandos abaixo usam `DATABASE_URL` com host, usuário e banco explícitos, além da configuração S3 usual. Execute no ambiente confiável do operador e use diretórios com armazenamento criptografado e acesso restrito. [Documentação do pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html)

```sh
cargo run --locked -p stock-api -- backup /caminho/protegido/backup-001
```

O comando usa um snapshot consistente para o dump e o manifesto de capturas e verifica os hashes antes de publicar o diretório de backup. O conjunto inclui auditoria, resultados OCR, movimentos e fotos confirmadas. A fila de uploads incompletos permanece no banco e os dispositivos conservam as fotos sem confirmação para retomar o envio. O arquivo inclui dados operacionais e hashes de senhas. O dump omite sessões ativas.

Copie o diretório concluído para armazenamento criptografado fora do host e com acesso independente do ambiente de produção. Defina frequência e retenção conforme os objetivos de perda de dados e recuperação do piloto. Registre a execução, a transferência externa e o resultado do teste periódico de restauração.

## Ensaio de restauração

1. Provisione um banco PostgreSQL vazio e um bucket S3 vazio e privado em ambiente isolado, com suporte a gravação condicional. Aponte `DATABASE_URL`, `S3_ENDPOINT` e `S3_BUCKET` para esses destinos. Mantenha API e worker desligados nesse ambiente durante o ensaio.
2. Use uma cópia confiável do backup com o manifesto original. Execute `restore` e depois `verify-backup`.

   ```sh
   cargo run --locked -p stock-api -- restore /caminho/protegido/backup-001
   cargo run --locked -p stock-api -- verify-backup /caminho/protegido/backup-001
   ```
3. Registre o tempo total e confirme o número de fotos. Inspecione uma captura, o OCR bruto, a identificação validada, a custódia e o movimento na instância de teste.
4. Se o processo falhar após começar a escrever no destino, revise a causa e use um novo banco e bucket vazios. Verifique o resultado antes de promover qualquer destino restaurado.

O dump é restaurado em uma transação SQL, e o bucket é preenchido depois. A verificação final é o ponto de decisão para usar o destino. Restrinja o acesso a backups autênticos, pois um dump PostgreSQL pode conter comandos executáveis. [Documentação do pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html)
