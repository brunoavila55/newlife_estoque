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

Entre com a conta administrativa e abra **Usuários**. Em **Criar usuário**, informe nome, login, perfil e senha inicial. É possível cadastrar técnicos e estoquistas. A lista mostra o perfil e o status de cada conta.

Na linha de um técnico, selecione **Abrir técnico**. A aba **Em posse** lista os equipamentos identificados sob sua custódia atual. A aba **Já entregues** mostra os equipamentos com recebimento físico confirmado, com data e depósito. O histórico inclui confirmações feitas em sessões ainda abertas.

## Como o fluxo funciona

1. **Coletar.** No celular, o técnico fotografa a etiqueta de cada roteador. A foto fica salva no aparelho e é enviada quando houver conexão.
2. **Comigo.** Lista o que está sob responsabilidade do técnico: equipamentos identificados e fotos ainda sem identificação. O técnico seleciona o que vai entregar e toca em **Montar lote**. O lote recebe um número curto, por exemplo **Lote 0012**.
3. **Balcão.** O técnico entrega a pilha e informa o número do lote. Em **Lotes para conferir**, o estoquista abre o lote e bipa cada equipamento. Depois do bipe, **Enter** com o campo vazio confirma o recebimento com o padrão de fonte, cabos e estado. Exceções exigem um clique.
4. **Encerrar.** Ao encerrar, o sistema gera o comprovante de devolução. O que não foi bipado continua com o técnico e pode entrar em outro lote. Faltantes, ocorrências ou fotos sem identificação exigem justificativa.

O lote nunca transfere custódia sozinho. Cada equipamento só sai do técnico quando o estoque confirma o bipe correspondente.

### Situações no balcão

- **Está no lote:** confira e aperte Enter.
- **Fora do lote:** o equipamento é do técnico, mas não foi colocado no lote. **Incluir no lote** adiciona o item à conferência, e ele ainda precisa ser confirmado.
- **Identificar pela foto:** o código ainda não está cadastrado, mas o lote tem fotos sem identificação. O estoquista compara a foto com o equipamento e confirma. O código bipado passa a identificar o equipamento, com a mesma validação da revisão de OCR. Em caso de conflito, a foto vai para a revisão do administrador e a custódia não muda.
- **Outro técnico, já recebido ou código ambíguo:** separe o equipamento. A leitura fica registrada nas ocorrências do lote.

### Área do estoque

- **Lotes para conferir:** fila de lotes enviados pelos técnicos, com busca por número ou nome.
- **Estoque por técnico:** quantos equipamentos cada técnico tem, quantas fotos ainda não foram identificadas, lotes abertos e há quantos dias está o item mais antigo. Mais de 7 dias aparece em vermelho.
- **Comprovantes:** conferências abertas pelo estoquista, com o comprovante enviado em texto pelo WhatsApp Web para o número cadastrado do técnico (sem impressão).
- **Rastrear equipamento:** histórico de custódia por serial ou MAC.

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

## Leitor de código de barras

Use um leitor USB ou Bluetooth no modo teclado e configure o sufixo **Enter** ou **Tab**, o mesmo escolhido na mesa de conferência. O campo de leitura recupera o foco automaticamente. A busca global fica oculta durante a conferência para que um bipe não tire o estoquista do lote. Use **Testar leitor** para conferir a configuração.

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
