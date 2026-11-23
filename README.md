# New Life · Controle de recolhimento e devolução

O sistema inclui a API Rust de custódia, o PWA do técnico para fotografar etiquetas offline, a revisão administrativa de OCR e o recebimento físico no depósito piloto. Consulte o [contrato OpenAPI](docs/api/openapi.yaml) para os endpoints e a [arquitetura](docs/architecture.md) para as regras implementadas.

## Ambiente local

Use Rust estável, Node.js 24, Docker Compose e as portas locais 3000, 4173, 5432 e 8333.

1. Copie `.env.example` para `.env` e preencha as credenciais locais. A senha em `DATABASE_URL` deve corresponder a `POSTGRES_PASSWORD`. Codifique em URL os caracteres reservados da senha.
2. Suba a infraestrutura com `docker compose --env-file .env -f infra/compose.yaml up -d --wait`.
3. Execute `cargo run --locked -p stock-api -- bootstrap-admin` e informe login, nome e senha no terminal. O comando aplica a migration e cria a primeira conta administrativa.
4. Execute `cargo run --locked -p stock-api`. Verifique o processo com `curl -fsS http://127.0.0.1:3000/health`.

5. Em outro terminal, execute os comandos abaixo e abra [o PWA local](http://localhost:4173).

```sh
cd apps/web
npm ci
npm run build
npm run preview
```

O endereço de pré-visualização local é `http://localhost:4173`. O proxy local encaminha `/api` para a API Rust. Use o build de pré-visualização para testar o Service Worker. Em produção, sirva `apps/web/dist` e encaminhe `/api` no mesmo domínio HTTPS.

## Administração de usuários

Entre com a conta administrativa e abra **Usuários**. Em **Criar usuário**, informe nome, login, perfil e senha inicial. É possível cadastrar técnicos e estoquistas. A lista mostra o perfil e o status de cada conta. Use **Ver estoque** na linha de um técnico para consultar os equipamentos identificados que estão sob sua custódia.

## Captura offline

Entre com a conta do técnico e aguarde o aplicativo indicar que está preparado para abrir offline. Use **Abrir câmera** ou **Escolher foto**. É possível digitar um código ou pedir que o aplicativo procure um código na imagem. Esse código fica separado dos identificadores verificados.

Cada conta vê sua própria fila no dispositivo. O aplicativo salva a foto antes de tentar enviá-la e mantém uma cópia local até a confirmação da API. A sincronização retoma ao abrir ou voltar ao aplicativo, com o botão **Sincronizar agora** disponível. Mantenha o aplicativo aberto durante o envio.

Há um limite de 100 fotos pendentes por conta e 320 MiB de fotos locais por perfil de navegador. O aplicativo limita a foto enviada a 12 MiB e tenta converter HEIC quando o navegador consegue abrir o arquivo. Fotos confirmadas e identificadas podem ter a cópia local removida após sete dias. Limpar os dados do site ou perder o armazenamento do navegador pode apagar fotos ainda pendentes.

No Android, use **Instalar aplicativo** quando o Chrome disponibilizar a opção. No Safari do iOS, use **Compartilhar** e **Adicionar à Tela de Início**. A API confirma o upload e coloca a foto na fila de OCR.

## OCR e revisão de etiquetas

Instale Tesseract e os dados de idioma no host do worker. Em Debian ou Ubuntu, os pacotes padrão são `tesseract-ocr` e `tesseract-ocr-eng`. Verifique se `tesseract --list-langs` inclui `eng` e execute em outro terminal, com o PostgreSQL e o SeaweedFS ativos.

```sh
cargo run --locked -p stock-api -- worker
```

Use `OCR_TESSERACT_BIN` para indicar outro caminho e `OCR_LANGUAGE` para escolher os idiomas já instalados. O worker roda localmente e a foto permanece na infraestrutura do sistema. A integração usa a [interface de linha de comando do Tesseract](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage).

Entre no mesmo aplicativo com a conta de administrador. Em **Revisão de etiquetas**, abra uma captura, confira a foto original e os valores sugeridos, ajuste ou adicione os identificadores e confirme a identificação. Leituras anteriores e o resultado bruto ficam disponíveis na captura. Uma etiqueta ilegível ou divergente pode ficar pendente com justificativa. O administrador pode pedir nova leitura de uma falha de OCR ou de uma captura que ainda aguarda decisão humana. A revisão exige conexão.

## Recebimento no depósito piloto

Cadastre um estoquista em **Usuários**. Entre com a conta dele no aplicativo e abra uma sessão para o técnico que está entregando os equipamentos. O sistema fixa a lista de equipamentos previstos naquele momento. Uma coleta validada depois da abertura pode ser conferida em outra sessão.

Com o cursor em **Código lido**, use um scanner USB ou Bluetooth no modo teclado. Configure o mesmo sufixo no scanner e no painel, **Enter** ou **Tab**. Também é possível digitar e clicar em **Buscar código**. Para conferir dois identificadores, informe o segundo antes de enviar a leitura principal.

Quando o painel localizar um item, confira os identificadores e, se necessário, abra a foto da etiqueta. Marque a conferência física e confirme o recebimento. O equipamento só sai do estoque do técnico após a confirmação do servidor. A sessão conserva a lista de previstos, confirmados, faltantes, leituras duplicadas e divergências. Encerrar com faltantes ou divergências exige justificativa. Itens sem identificação verificável ficam pendentes.

## Testes

Com o PostgreSQL local ativo e as variáveis de `.env` exportadas, execute:

```sh
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked
```

Os testes de integração criam bancos descartáveis no servidor indicado por `DATABASE_URL`. Use uma instância de desenvolvimento com um usuário autorizado a criar bancos. O adapter de testes simula a disponibilidade e o armazenamento das fotos.

Para testar o PWA no Chromium:

```sh
cd apps/web
npm ci
npm run build
npx playwright install chromium
npm run test:e2e
```

Para validar no piloto, instale em Safari iOS e Chrome Android sob HTTPS. Teste permissões de câmera, seleção de arquivo, legibilidade da etiqueta após conversão, reabertura offline e retomada do envio ao reconectar. Verifique o espaço necessário com lotes de 10, 50 e 100 fotos dos aparelhos usados em campo.

## Operação

O Compose atende ao desenvolvimento local. O [guia de operação](docs/operations.md) descreve configuração de produção, saúde, métricas, auditoria, backup e restauração isolada. A foto fica disponível ao administrador e ao estoquista que localizou o item em sua sessão. A URL temporária vale por dois minutos.

A configuração do serviço local segue o [guia do SeaweedFS](https://github.com/seaweedfs/seaweedfs#quick-start-with-weed-mini).
