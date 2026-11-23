# AGENTS.md — Controle de Recolhimento e Devolução de Equipamentos

> Instruções para agentes de programação e colaboradores deste repositório.
> Idioma de produto, documentação e interface: português brasileiro (pt-BR). Nomes de código, tabelas e endpoints: inglês, de forma consistente.

## 1. Objetivo

Construir um sistema de rastreabilidade de roteadores e outros equipamentos recolhidos em campo. O técnico fotografa a etiqueta do equipamento pelo PWA instalável no celular, mesmo sem internet. Quando houver conexão, as imagens são enviadas ao servidor; um processo de IA/OCR extrai serial (SN) e endereços MAC, e cria ou atualiza um registro **pendente de validação** no estoque sob responsabilidade do técnico. O estoquista recebe fisicamente os equipamentos e os confere com um leitor de código de barras conectado à interface web. Somente uma conferência válida e autorizada transfere a custódia do técnico para o estoque.

**Regra fundamental:** OCR é uma sugestão, nunca prova definitiva de identidade ou devolução. A leitura do código de barras também deve ser validada contra o registro, sem autorizar baixa silenciosa de itens ambíguos.

## 2. Princípios inegociáveis

1. Rastreabilidade: toda mudança de custódia gera evento de auditoria permanente com ator, horário e origem.
2. Consistência: não perder nem duplicar equipamentos durante sincronizações, reenvios ou conferência concorrente.
3. Offline-first: capturas funcionam sem conexão; persistir imagens e metadados localmente até confirmação do servidor.
4. Segurança: autenticação e autorização por função e escopo; arquivos privados e acesso por URLs temporárias.
5. Revisão humana: OCR de baixa confiança, duplicidades ou divergências exigem revisão explícita.
6. Simplicidade: priorizar monólito modular e worker assíncrono; evitar microsserviços prematuros.
7. Portabilidade: storage via interface compatível com S3; não acoplar a implementação a um fornecedor.
8. Idempotência: repetir upload, processamento ou solicitação de conferência não pode criar duas baixas.
9. História preservada: corrigir dados através de eventos/versões auditáveis, sem apagar registros de movimentação.
10. Testes das regras críticas antes de otimização ou polimento visual.

## 3. Stack técnica sugerida

### Backend e infraestrutura
- Rust (versão estável), Axum, Tokio, Serde, SQLx e tracing.
- PostgreSQL como fonte de verdade transacional.
- Worker Rust para processamento assíncrono de imagens; fila inicial implementada com jobs em PostgreSQL e reserva concorrente com `FOR UPDATE SKIP LOCKED`. Reavaliar fila dedicada somente quando necessário.
- Armazenamento de imagens via API S3. Preferência inicial para **SeaweedFS** em hospedagem própria; considerar Garage, Cloudflare R2 ou outro fornecedor S3 compatível conforme requisitos operacionais. Usar um adapter `ObjectStorage`.
- IA/OCR acessada por adapter `LabelRecognitionProvider` intercambiável; não presumir que um único modelo/fornecedor terá precisão suficiente.
- Docker Compose para ambiente local, migrations SQLx e CI com testes automatizados.

### Frontend único: web + PWA instalável (Android, iOS e desktop)
- **Não criar app Flutter, React Native nem aplicações nativas separadas no MVP.** Usar uma única aplicação React + TypeScript + Vite para técnicos, estoquistas e administradores, com interfaces responsivas por perfil.
- Configurar PWA com `vite-plugin-pwa` e Workbox: Web App Manifest com nome, ícones, `start_url`, `scope`, `display: standalone` e Service Worker com estratégia de cache versionada. Hospedar em HTTPS (localhost permitido para desenvolvimento).
- Tela do técnico otimizada para toque/câmera; tela do estoquista otimizada para desktop e scanner HID; interfaces acessíveis em dispositivos móveis e desktop.
- **Offline-first para capturas**: IndexedDB com Dexie.js para fotos (`Blob`), metadados, fila de upload, status e identificadores UUID. Não usar `localStorage` para imagens ou fila. Persistir Blob + registro da fila numa mesma transação IndexedDB quando suportado.
- Captura de foto via `<input type="file" accept="image/*" capture="environment">` com fallback para seletor de arquivos, e/ou `getUserMedia` quando disponível e autorizado. Não exigir suporte uniforme de API de câmera entre navegadores.
- Tentar leitura de códigos com `BarcodeDetector` somente após verificar suporte; usar fallback como ZXing e sempre permitir captura fotográfica/manual. Scanner USB/Bluetooth tipo teclado HID funciona em campo focado com sanitização do valor e sufixo configurável.
- UI apresenta estado da fila (pendente, enviando, enviada, erro, ação necessária), indicador de conectividade apenas informativo e botão **Sincronizar agora**. Tentar reenviar ao abrir/retomar o PWA, ao evento `online` e enquanto o aplicativo estiver ativo; usar backoff exponencial com jitter.
- **Não depender de Background Sync, Periodic Background Sync ou push para concluir uploads**, especialmente no iOS: a sincronização pode parar quando o PWA está fechado/suspenso. Não prometer envio automático com aplicativo encerrado.
- Tratar armazenamento do navegador como sujeito a cotas/evicção: medir uso quando disponível (`navigator.storage.estimate()`), solicitar persistência (`navigator.storage.persist()`) como melhoria sem assumir concessão, alertar pouco espaço, limitar capturas por capacidade e orientar que limpeza de dados/desinstalação pode apagar fotos pendentes.
- Proteger fotos não sincronizadas de exclusão no fluxo do próprio aplicativo. Evitar limpeza de cache que toque IndexedDB; fazer atualização do Service Worker sem invalidar a fila de fotos. Fotos offline não equivalem a backup: oferecer sinalização explícita até confirmação remota.
- Usar os mesmos endpoints da API Rust em todas as plataformas. Testar instalação, câmera, IndexedDB e retomada de envio nas versões alvo de Safari iOS e Chrome Android.

## 4. Fluxo principal

### A. Recolhimento pelo técnico
1. Técnico autenticado abre uma coleta no aplicativo.
2. Fotografa etiqueta com serial/MAC; opcionalmente faz leitura local do código de barras para elevar a precisão.
3. PWA cria `capture_id` UUID e persiste imagem, checksum, timestamp local, identificador do técnico, status e dados opcionais antes de qualquer upload.
4. Estado inicial: `LOCAL_PENDING`.
5. Ao detectar conectividade, PWA envia a foto com chave de idempotência, mantendo a cópia local até receber confirmação de persistência remota.
6. API registra imagem e trabalho OCR; o PWA passa a `UPLOADED` quando o servidor confirmar recebimento durável.
7. Worker extrai possíveis serial/MAC, etiqueta de fabricante/modelo quando viável e confiança por campo.
8. Registros ambíguos vão para `NEEDS_REVIEW`; os válidos vão para `IDENTIFIED`, ainda sob custódia do técnico.
9. O equipamento aparece no estoque particular do técnico como **em posse / aguardando devolução**. Distinguir claramente captura não identificada de equipamento identificado.

### B. Entrega e conferência pelo estoquista
1. Estoquista abre uma sessão de recebimento associada ao técnico e/ou lote de entrega.
2. Scanner lê serial ou MAC do equipamento físico. Normalizar entrada antes da busca.
3. Backend procura correspondências no escopo correto. Se não existir, se houver mais de uma, ou houver incompatibilidade, apresentar ocorrência; não liberar automaticamente.
4. Interface exibe registro encontrado e, quando necessário, foto original para inspeção.
5. Estoquista confirma **recebimento físico**; o servidor executa transação de transferência de custódia e registra `stock_movement` e `audit_event`.
6. Somente após o commit da transação o item deixa de constar como pendente do técnico e entra na custódia do estoque.
7. Sessão de recebimento mostra confirmados, faltantes, duplicados e divergentes. Fechamento não deve mascarar pendências.

## 5. Modelo de domínio inicial

Usar UUID como identificadores internos. Nomes abaixo são sugestões para evoluir com migrations.

- `users`: id, name, login, status, timestamps.
- `roles`/`user_roles`: técnico, estoquista, administrador (ou RBAC equivalente).
- `locations`: depósitos/estoques; separar localização de usuário responsável.
- `equipment`: id, serial_normalized nullable, serial_raw nullable, mac_normalized nullable, manufacturer nullable, model nullable, lifecycle_status, timestamps. Permitir múltiplos MACs por equipamento via tabela própria, se a operação exigir WAN/LAN/Wi-Fi.
- `equipment_identifiers`: equipment_id, type (SERIAL/MAC/BARCODE), raw_value, normalized_value, source, verified_at nullable; constraints/índices de unicidade conforme tipo e escopo de negócio. Não presumir unicidade universal sem validar casos legados.
- `captures`: id, client_capture_id, technician_id, equipment_id nullable, image_object_key, sha256, captured_at_device, received_at_server, upload_status, ocr_status, timestamps.
- `ocr_results`: capture_id, provider, model_version, extracted_json, confidence_by_field, processing_status, failure_reason, timestamps. Não substituir evidência original por valores corrigidos.
- `custody_movements`: id, equipment_id, from_holder_type/id, to_holder_type/id, movement_type, actor_id, receipt_session_id nullable, occurred_at, reason nullable.
- `receipt_sessions`: id, technician_id, warehouse_id, clerk_id, status, opened_at, closed_at.
- `receipt_items`: id, receipt_session_id, equipment_id, scanned_value, match_result, confirmation_status, confirmed_at, confirmed_by, divergence_reason.
- `audit_events`: id, actor_id, action, entity_type, entity_id, before_json, after_json, request_id, created_at.
- `jobs`: id, kind, payload, status, attempts, next_run_at, locked_at, last_error, timestamps.

**Importante:** o estado de custódia atual deve ser consistente com os movimentos; não manter dois estoques independentes que possam divergir. Se um campo materializado de custódia atual for necessário, atualizá-lo na **mesma transação** do movimento.

## 6. Máquina de estados

### Captura/sincronização no PWA
`LOCAL_PENDING -> UPLOADING -> UPLOADED`.

Falha recuperável: `UPLOADING -> LOCAL_PENDING` com contador de tentativas, backoff e erro visível. Captura pode ir para `ACTION_REQUIRED` em falha permanente ou necessidade de autenticação. Não apagar a foto antes da confirmação durável no servidor e política local de retenção.

### Identificação no servidor
`RECEIVED -> OCR_PENDING -> OCR_PROCESSING -> IDENTIFIED | NEEDS_REVIEW | OCR_FAILED`.

Reprocessamento controlado deve permitir novas tentativas sem criar equipamento duplicado. Revisão manual deve registrar quem alterou qual valor.

### Custódia
`WITH_TECHNICIAN -> RECEIVED_AT_WAREHOUSE`, mediante recebimento válido e confirmado.

Se existirem perdas, avarias, devolução revertida ou transferência entre técnicos, representar eventos específicos com permissões e justificativa, em vez de editar o estado diretamente.

## 7. Normalização e identificação

- Serial: remover apenas espaços e caracteres separadores comprovadamente irrelevantes; usar uppercase quando aplicável. **Não remover zeros à esquerda** e não confundir O/0 ou I/1 automaticamente.
- MAC: aceitar formatos `AA:BB:CC:DD:EE:FF`, `AA-BB-CC-DD-EE-FF` e `AABBCCDDEEFF`; normalizar para 12 caracteres hexadecimais uppercase; validar comprimento e caracteres.
- Etiquetas podem ter vários códigos; classificar por prefixos como `SN`, `S/N`, `MAC`, `WAN MAC`, `LAN MAC` sem presumir que o primeiro código é serial.
- Guardar valores brutos, normalizados, confiança e imagem original; exibir divergências para revisão.
- Não inventar números ausentes e não fazer correção automática de OCR que altere a identidade.
- Se etiqueta trouxer código de barras legível pela câmera, preferir combinar resultado de decodificador de código de barras com OCR e registrar as duas evidências.

## 8. Contratos de API sugeridos (v1)

- `POST /api/v1/auth/login` ou integração com provedor de identidade.
- `POST /api/v1/captures` cria registro idempotente e devolve instrução segura de upload.
- `PUT /api/v1/captures/{id}/image` ou URL pré-assinada de curta duração para upload de objeto privado.
- `POST /api/v1/captures/{id}/complete` confirma upload; servidor valida existência, integridade e vinculação da imagem antes de enfileirar OCR.
- `GET /api/v1/me/inventory` lista equipamentos sob custódia do técnico.
- `GET /api/v1/captures/{id}` consulta sincronização/OCR/revisão.
- `POST /api/v1/captures/{id}/review` corrige identificação com trilha de auditoria.
- `POST /api/v1/receipt-sessions` abre sessão de devolução.
- `POST /api/v1/receipt-sessions/{id}/scan` resolve leitura e retorna resultado, sem transferência automática.
- `POST /api/v1/receipt-sessions/{id}/confirm` confirma item específico com idempotência e transação.
- `GET /api/v1/receipt-sessions/{id}` apresenta resultado consolidado.
- `GET /api/v1/audit-events` restrito a papel autorizado.

Endpoints acima são proposta inicial; gerar OpenAPI e manter contratos versionados. Usar paginação, filtro, validação de payload e erros padronizados.

## 9. Sincronização offline e integridade

- Gerar `client_capture_id` estável no dispositivo antes do primeiro upload; índice único por origem/autorização para prevenir duplicação.
- Persistir as transições da fila no IndexedDB (Dexie.js), com transações atômicas para metadados/foto quando aplicável; retomar capturas em estado `UPLOADING` interrompido após reinício.
- Implementar retomada segura após aba fechada, PWA suspenso, crash, interrupção, token expirado ou troca de rede. Não pressupor tarefas em segundo plano com navegador fechado.
- Não supor ordem garantida das requisições. A API precisa aceitar retries e reconciliar estados já concluídos.
- Upload com verificação de tipo/tamanho, checksum (SHA-256) e confirmação de integridade. Não confiar só no cabeçalho `Content-Type`.
- Preferir fotos legíveis com resolução mínima definida por testes reais; compressão deve preservar os caracteres da etiqueta.
- Exibir por captura: `aguardando envio`, `enviando`, `recebida`, `processando`, `revisar`, `erro`. Mostrar contagem de fotos pendentes, últimas tentativas e alertas de armazenamento insuficiente.
- Evitar exclusão prematura de imagens: limpeza local somente depois de confirmação do upload + prazo de segurança definido, e respeitando necessidade de revisão.
- Verificar instalação, cache, câmera, persistência de IndexedDB, cotas/evicção e ausência de Background Sync nos navegadores-alvo; fornecer ação manual “Sincronizar agora” e sincronizar ao reabrir o app.
- Evitar marcar uma captura como `UPLOADED` por evento `online` ou por HTTP iniciado; somente usar confirmação durável da API.
- Em erros de quota ou armazenamento, impedir falsa confirmação de captura e instruir o técnico a sincronizar ou liberar espaço de forma segura.
- **Limite operacional explícito:** se o usuário limpar os dados do site, desinstalar o PWA ou se houver evicção pelo sistema antes do upload, o navegador pode perder capturas. O sistema deve avisar desse risco e jamais tratá-las como recebidas no backend.

## 10. Regras de recebimento e concorrência

- Conferência é sempre feita no servidor com permissão `warehouse:receive`.
- Toda operação de confirmação é idempotente: requisição repetida retorna resultado anterior, sem registrar novo movimento.
- Transação de banco deve bloquear registro/estado relevante (`SELECT ... FOR UPDATE` ou estratégia equivalente), verificar custódia atual, validar sessão e só então mover.
- Duas conferências simultâneas do mesmo equipamento não podem ambas ser aprovadas.
- Scanner desconhecido, dois equipamentos correspondentes, equipamento de outro técnico, já recebido e serial/MAC divergente são casos explícitos de erro ou exceção.
- O estoquista não deve dar baixa em massa sem listar claramente o que foi conferido. A confirmação por item é a fonte de verdade.
- Recebimentos excepcionais sem etiqueta exigem fluxo administrativo separado, justificativa, foto e auditoria.

## 11. Segurança, privacidade e observabilidade

- HTTPS obrigatório em produção; credenciais nunca em código ou repositório.
- Autenticação segura, sessão/token com renovação e revogação; autorização no backend para cada rota.
- Técnico acessa apenas suas capturas, equipamento e históricos autorizados. Estoquista acessa sessões e registros do seu escopo; administrador tem acesso controlado.
- Fotos privadas com chaves aleatórias, sem public-read, criptografia em repouso conforme ambiente e URLs assinadas com expiração curta.
- Não registrar fotos, tokens ou dados pessoais completos nos logs. Aplicar política de retenção e adequação à LGPD.
- Definir backup de PostgreSQL e storage, cópia externa e testes periódicos de restauração; replicação **não** equivale a backup.
- Métricas: fotos aguardando envio, taxa de OCR revisada, falhas de upload, jobs atrasados, divergências de conferência e tempo de processamento.
- Usar logs estruturados com `request_id`, `capture_id` e `receipt_session_id` quando aplicável.

## 12. Estrutura de monorepo sugerida

```text
/
├── AGENTS.md
├── apps/
│   └── web/                 # React + TypeScript + Vite + PWA (mobile e desktop)
├── services/
│   ├── api/                 # Rust + Axum
│   └── worker/              # Rust: OCR e jobs
├── crates/
│   ├── domain/              # Regras de negócio puras
│   ├── application/         # Casos de uso
│   ├── persistence/         # PostgreSQL / SQLx
│   ├── object-storage/      # Adapter S3
│   └── recognition/         # Adapter OCR/IA
├── migrations/
├── infra/
│   └── compose.yaml
├── docs/
│   ├── architecture.md
│   ├── decisions/
│   └── api/
└── .github/workflows/
```

Não forçar abstrações artificiais. Separar crates somente quando os limites e o reuso justificarem.

## 13. Prioridades de implementação (MVP)

### Fase 1 — Base e identidade
- Projeto Rust, migrations, autenticação/RBAC e cadastro de usuários técnicos/estoquistas.
- Modelo de equipamento, custódia, capturas e movimentações auditáveis.
- Ambiente local com PostgreSQL e storage S3 compatível.

### Fase 2 — Captura e sincronização
- PWA instalável com login, câmera, IndexedDB/Dexie, armazenamento local, Service Worker e fila de envio.
- API idempotente para cadastro/upload/conclusão e tela do estoque particular.

### Fase 3 — OCR assistido
- Worker com extração de serial/MAC e regras de normalização.
- Tela de revisão manual de leituras incertas, incompatíveis e duplicadas.

### Fase 4 — Recebimento
- Painel web de sessões de recebimento com leitor HID.
- Busca por código, validação visual, confirmação transacional e relatório de divergências.

### Fase 5 — Robustez de produção
- Controle de acessos detalhado, observabilidade, testes E2E, retenção, backup/restauração e operação em rede instável.

## 14. Testes obrigatórios e critérios de aceite

1. Capturar 10 fotos sem internet, fechar/reabrir o PWA e recuperar todas pelo IndexedDB sem perda, desde que dados do site permaneçam preservados.
2. Interromper upload no meio e retomar sem gerar duplicatas.
3. Enviar mesma captura repetidamente e resultar em um único registro lógico.
4. Processar OCR com serial correto, MAC correto, campo ausente, texto ambíguo e vários códigos na etiqueta.
5. Corrigir OCR manualmente sem apagar resultado bruto ou auditoria.
6. Impedir que um técnico leia o estoque privado de outro sem autorização.
7. Bipar item correto e transferir custódia exatamente uma vez após confirmação.
8. Bipar item inexistente, de outro técnico, duplicado ou já recebido e exigir tratamento explícito.
9. Executar duas confirmações concorrentes; apenas uma pode gerar movimentação.
10. Simular indisponibilidade de OCR/storage e preservar a fila para reprocessamento.
11. Restaurar backup e verificar consistência entre imagem, captura, identificação e movimento.
12. Garantir que item não seja liberado do técnico apenas por upload, OCR ou scan sem confirmação.
13. Instalar o PWA no Android/Chrome e iOS/Safari e verificar captura, reabertura, tela inicial, permissões e operação offline nos dispositivos alvo.
14. Com PWA fechado durante falta de conexão, reabrir online e garantir retomada idempotente; não exigir sincronização em background com app encerrado.
15. Simular quota insuficiente, falha ao salvar Blob e limpeza de cache do Service Worker: mostrar erro sem perder dados previamente salvos e sem marcar uploads inexistentes como concluídos.
16. Testar scanner HID com sufixo `Enter`, câmera com código de barras legível, fallback ZXing e entrada manual.
17. Validar que atualização do PWA não elimina fotos pendentes no IndexedDB.

## 15. Como agentes de IA devem trabalhar neste repositório

1. Antes de editar código, ler este `AGENTS.md`, o README, os ADRs relevantes e os contratos OpenAPI.
2. Propor mudanças pequenas e incrementais, respeitando a ordem das fases do MVP.
3. Nunca implementar transferência de estoque só no frontend; todas as invariantes devem valer no backend e no PostgreSQL.
4. Novas tabelas/alterações requerem migrations reversíveis quando viável, índices e testes.
5. Escrever testes automatizados para casos normais, falhas e concorrência. Não considerar pronto sem execução dos testes pertinentes.
6. Manter credenciais e endpoints sensíveis em variáveis de ambiente; fornecer `.env.example` sem segredos.
7. Usar OpenAPI como contrato e atualizar documentação ao alterar endpoints ou estados.
8. Não adicionar novas dependências, filas, microsserviços ou provedores sem justificar custo, benefício e impacto operacional.
9. Não enviar fotografias reais ou identificadores de clientes para provedores de IA sem aprovação, base legal e configuração de tratamento de dados apropriadas.
10. Antes de alterar funcionalidades PWA, validar comportamento real em iOS/Safari e Android/Chrome; não presumir suporte a APIs experimentais ou execução em segundo plano.
11. Em caso de regra ambígua, documentar a hipótese e escolher o comportamento que **não dá baixa indevida** em equipamento.
12. Ao concluir uma tarefa, relatar arquivos alterados, migrações, testes executados e riscos remanescentes.

## 16. Critérios específicos de instalação e operação PWA

- Servir app por HTTPS com manifest e Service Worker válidos, ícones adequados e indicação de instalação conforme suporte do navegador. No iOS, orientar instalação via menu de compartilhamento **Adicionar à Tela de Início** quando aplicável; não depender de `beforeinstallprompt`.
- Oferecer tela offline/cache do shell para permitir entrar em capturas já autenticadas. Não guardar senhas/tokens em cache público; definir política segura para revalidação de sessão offline e operações permitidas sem rede.
- Não fazer cache indiscriminado de rotas autenticadas, respostas privadas ou imagens de terceiros; manter dados privados no IndexedDB com regras explícitas de limpeza por usuário/dispositivo.
- Em dispositivos compartilhados, logout deve lidar com capturas ainda não enviadas: impedir descarte silencioso, bloquear exposição entre contas e exigir resolução explícita antes de limpeza; isolar fila pelo usuário autenticado.
- Em produção, medir compatibilidade e limites reais de espaço para 10, 50 e 100 fotos por dispositivo; escolher compressão/qualidade por teste de legibilidade de etiquetas.
- Não prometer proteção absoluta de fotos offline contra perda do dispositivo ou exclusão do armazenamento do navegador. Propor aplicativo nativo apenas caso testes reais revelem necessidade incontornável de background sync, armazenamento garantido ou integração nativa.

## 17. Questões de negócio a validar antes de produção

- Quais fabricantes/modelos de roteador existem? A etiqueta contém vários MACs? Qual código de barras é escaneado no recebimento?
- A foto sozinha cria o registro de custódia ou é preciso validar a extração antes de assumir responsabilidade?
- Como tratar equipamento sem etiqueta, etiqueta danificada, equipamento avariado ou serial já cadastrado?
- Um equipamento pode ser transferido entre técnicos ou ficar com subcontratados?
- A devolução é por técnico, ordem de serviço, lote, filial ou combinação desses escopos?
- Qual política de prazo e retenção de imagens (dispositivo e servidor)?
- Volume esperado: técnicos, fotos por dia, tempo tolerável de OCR e número de depósitos?
- É necessário comprovar cadeia de custódia com geolocalização, assinatura ou comprovante? Só implementar se houver fundamento operacional e privacidade adequada.

## 18. Definição de pronto

Uma funcionalidade está pronta quando atende às regras de autorização, preserva o histórico, é resiliente a falhas e reenvios, tem testes relevantes e mensagens úteis para o usuário. Na dúvida, preservar a custódia atual e abrir pendência de reconciliação, nunca transferir ou excluir silenciosamente.
