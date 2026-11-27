# Arquitetura

## Cidades e escopo do estoque

`locations` guarda as cidades. A migration `202611270001` renomeou o depósito piloto para São Gabriel, criou Bagé e Passo Fundo e acrescentou `users.location_id`, obrigatório para técnico e estoquista. O módulo `locations` resolve a cidade de cada requisição do estoque: o estoquista usa sempre a própria cidade, mesmo que envie outro valor; o administrador usa o cabeçalho `X-Location-Id` ou, sem ele, a cidade de referência da conta. A resolução trava a linha do usuário, como as demais autorizações.

As rotas do estoque filtram pela cidade: técnicos do seletor e do painel, fila de lotes, abertura de sessão, ocorrências e chips. Abrir sessão ou conferir lote de técnico de outra cidade responde 409 `OTHER_LOCATION` ou 404. A sessão de recebimento grava a cidade em `warehouse_id`, e o roteador recebido entra no estoque dessa cidade. A busca por serial ou MAC continua global para que a ambiguidade seja detectada no cadastro inteiro. Trocar a cidade de uma conta revoga as sessões e é recusado enquanto houver custódia ou trabalho em aberto.

## Chips (SIM cards)

`sim_cards` guarda o ICCID (19 ou 20 dígitos, prefixo 89, dígito verificador Luhn quando há 20), os dados informativos da operadora e a custódia atual: estoque de uma cidade **ou** técnico. `sim_movements` registra `IMPORTED`, `DELIVERED` e `RETURNED`. Um gatilho exige que cada movimento parta de onde o anterior terminou, e uma restrição diferida exige que a custódia materializada no chip seja a do último movimento. Chaves estrangeiras compostas obrigam o movimento a herdar cidade, técnico e operador da `sim_transfers` correspondente. Chips, movimentos, entregas e importações não podem ser apagados nem reescritos.

A importação recebe as linhas já lidas do `.xlsx` no navegador (`apps/web/src/xlsx.ts`, sem dependências: diretório central do ZIP, `DecompressionStream('deflate-raw')` e `DOMParser`). A API revalida cada ICCID, serializa importações com bloqueio da tabela, cria os chips novos no estoque da cidade e atualiza apenas os campos informativos dos existentes. `dry_run` executa a mesma lógica e descarta a transação. A chave `client_import_id` torna a gravação idempotente.

A entrega e a devolução bloqueiam os chips com `FOR UPDATE`, conferem a posição de cada um e gravam tudo na mesma transação, ou nada. Uma repetição com a mesma `client_transfer_id` é verificada depois do bloqueio e devolve o mesmo registro. Duas entregas concorrentes do mesmo chip resultam em uma confirmação e uma recusa. Um leitor que omite o dígito verificador é resolvido pelos 19 primeiros dígitos, indexados.

Os campos `Assinante` da planilha podem conter nome e CPF de clientes. Eles ficam visíveis para estoquistas e administradores da cidade e entram na auditoria da importação.

## Roteadores

Um processo Axum usa o PostgreSQL para contas, sessões, capturas, identidades verificadas, custódia e auditoria. A porta de armazenamento de objetos encapsula a API S3. O Compose executa PostgreSQL e SeaweedFS com volumes persistentes e portas expostas em loopback.

## Identidade e acesso

As senhas usam Argon2id. Os tokens opacos de acesso e renovação têm hashes persistidos separadamente. A renovação rotaciona os dois tokens e mantém o limite de sete dias desde o login. Desativação e redefinição de senha são auditadas e revogam as sessões na mesma transação. O bloqueio por conta ordena renovação, revogação e operações autorizadas concorrentes. O comando de inicialização é a via de criação do primeiro administrador.

O administrador revisa capturas e gerencia contas de técnico e estoquista. O estoque privado consulta o técnico derivado da sessão. No painel administrativo, a lista de contas inclui usuários desativados e permite consultar a custódia atual de cada técnico. No piloto, administradores e estoquistas têm a permissão warehouse:receive no depósito único. Cada operador acessa as sessões que abriu.

## Custódia e revisão

A captura recebida começa sem equipamento associado. A validação administrativa exige acesso à imagem no storage. Identidade nova gera equipamento, identificadores, movimento inicial e auditoria em uma única transação. Restrições diferidas no PostgreSQL verificam que a custódia do técnico corresponde ao movimento e que a captura de origem corresponde ao equipamento e ao técnico. O depósito piloto é cadastrado pela migration para uso nas fases seguintes.

Uma correspondência integral com o equipamento do mesmo técnico acrescenta evidência sem gerar outro movimento. Um conjunto que combina identificadores já conhecidos e valores novos exige revisão administrativa. Essa regra preserva os identificadores verificados diante de evidências contraditórias. Colisões, outra custódia e justificativas administrativas são registradas como pendências auditáveis. Um bloqueio de escrita na tabela de identificadores serializa as validações enquanto o piloto opera com volume baixo e permite detectar a corrida pela primeira ocorrência.

Serial preserva zeros e separadores internos e converte letras ASCII para maiúsculas. Código de barras preserva caixa e conteúdo interno. MAC aceita os três formatos previstos e mantém o valor bruto junto ao normalizado. A migration permite vários MACs e ocorrências legadas de um mesmo código em equipamentos distintos.

O recebimento físico adiciona um movimento vinculado à sessão e à leitura de origem. Movimentações excepcionais exigem um fluxo administrativo específico.


## Recebimento da foto

O UUID do cliente é único por técnico. A primeira requisição vincula o UUID, a hora, o tamanho, o checksum e a evidência opcional de código a uma chave aleatória no bucket. O PUT verifica o comprimento, o SHA-256 e a decodificação da imagem. O servidor lê de volta o objeto e verifica sua integridade antes de persistir a captura, o job de OCR e a auditoria em uma transação. Se a rede cair após a gravação, repetir o fluxo com os mesmos dados retorna a confirmação prévia. O técnico só consulta uploads da própria conta.

Os complementos da coleta, como ordem de serviço, modelo informado, conservação e acessórios, acompanham o upload e ficam disponíveis na revisão administrativa. São evidências declaradas pelo técnico e ficam separados dos identificadores verificados e da conferência física do depósito. Uploads iniciados por versões anteriores podem receber os complementos durante a retomada, antes da confirmação. Capturas já confirmadas antes da atualização conservam o registro original.

O processamento da fotografia valida JPEG, PNG ou WebP com até 24 megapixels e 12 MiB. Se o dispositivo precisar converter ou reduzir uma imagem, o checksum é calculado sobre o arquivo efetivamente persistido na fila. A leitura local com BarcodeDetector ou ZXing é uma evidência complementar. A identificação do estoque continua dependendo da revisão administrativa.

O PWA atualiza a fila e o Blob na mesma transação Dexie. A captura em envio tem uma reserva local, recuperada ao reabrir o aplicativo quando Web Locks está disponível, ou após a expiração da reserva nos demais navegadores. A API permanece idempotente se duas abas enviarem a mesma captura. Workbox guarda apenas os arquivos estáticos necessários para abrir o PWA. As rotas da API ficam fora do cache.

O token de acesso web fica em memória. A renovação usa cookie HttpOnly, Secure e SameSite Strict, com cabeçalho dedicado e chamadas na mesma origem. A última sessão autenticada permite captura local por até 24 horas sem rede. A operação offline pressupõe acesso ao aparelho desbloqueado. Em aparelho compartilhado, encerre a sessão; sem rede, bloquear o aplicativo remove o perfil local e preserva a fila da conta. A revogação no servidor exige conexão e ocorre ao sair online ou entrar novamente com o cookie anterior. Para concluir um upload é sempre necessário autenticar a conta que registrou a foto.

A política de retenção local conserva fotos pendentes e fotos em revisão. O aplicativo descarta apenas cópias de capturas confirmadas, identificadas e retidas por ao menos sete dias. Em produção, o servidor precisa de uma política própria de retenção para uploads iniciados que nunca foram concluídos e para as imagens de evidência.

Dexie mantém as transações e os índices da fila compatíveis com IndexedDB, Workbox gera o cache versionado e o ZXing é carregado sob demanda. No backend, a biblioteca `image` decodifica o conteúdo dentro de limites antes de gravá-lo e `chrono` representa a hora da captura em UTC. O manifesto precacheia também o fallback ZXing para preservar a leitura offline.


## OCR e revisão administrativa

O subcomando `stock-api worker` consome a fila PostgreSQL com `FOR UPDATE SKIP LOCKED`. A reserva usa um identificador de execução e expira após 90 segundos. A persistência de resultado verifica a reserva vigente na mesma transação que atualiza o job e a captura. Erros temporários têm até três tentativas, com intervalo de 15 e 30 segundos. Após uma falha definitiva, o administrador pode solicitar reprocessamento sem apagar as tentativas anteriores.

O worker verifica o SHA-256 antes de entregar a imagem ao adapter `LabelRecognitionProvider`. A primeira implementação executa Tesseract localmente com prazo de 45 segundos, saída TSV limitada a 1 MiB e um thread por processo de OCR. O TSV intacto e a procedência são registrados em `ocr_results`. O parser usa rótulos de serial, MAC, fabricante e modelo para gerar sugestões, conserva os valores brutos e registra a confiança do mecanismo por campo. O limiar de 80% serve como sinalizador de triagem. Sua calibração depende de amostras reais de cada fabricante e câmera.

Toda captura processada segue para revisão humana. O worker atualiza apenas a captura ainda em estado de processamento, preservando uma decisão administrativa gravada durante a leitura. O administrador vê a foto por URL temporária, compara evidências, confirma os valores e pode registrar uma justificativa. Quando uma leitura é consultada durante a validação, a auditoria liga a decisão à versão de OCR selecionada. O acesso administrativo no navegador é online e os dados de revisão ficam em memória.


## Recebimento físico

A sessão vincula o estoquista, o técnico e o depósito piloto. A abertura grava a lista de itens esperados a partir da custódia vigente. O servidor resolve códigos contra identificadores verificados e exige correspondência única no cadastro inteiro, inclusive quando apenas um dos candidatos pertence ao técnico da sessão. MAC e serial seguem a normalização cadastrada. O código de barras preserva caixa e conteúdo. Duas leituras fornecidas na mesma operação precisam identificar o mesmo equipamento.

O scan registra o resultado e a origem da leitura. A confirmação bloqueia sessão e equipamento, relê os identificadores e verifica a custódia atual. Em uma única transação grava a confirmação, atualiza a custódia e acrescenta o movimento e o evento auditável. Restrições diferidas vinculam movimento, sessão, leitura válida e item confirmado. Se duas sessões tentarem receber o mesmo equipamento, a segunda recebe um conflito. A confirmação é idempotente pela combinação de sessão, equipamento e leitura correspondente.

A sessão exibe previstos, confirmados, faltantes, duplicados e divergências. Um novo scan de item já localizado e ainda pendente conta como leitura duplicada. Scans de itens já recebidos ou fora da lista permanecem no histórico de divergências. O fechamento preserva faltantes e divergências e exige justificativa quando houver. A reversão da migration de recebimento é permitida enquanto a base não tiver sessões de recebimento.


## Lotes de devolução

`delivery_batches` e `delivery_batch_items` registram a entrega declarada pelo técnico. Um item aponta para uma coleta, identificada ou não. Um índice único parcial impede que a mesma coleta esteja em dois lotes abertos. Triggers limitam o ciclo a `SUBMITTED → RECEIVING → CLOSED` ou `SUBMITTED → CANCELLED` e bloqueiam a exclusão do histórico.

Abrir a conferência (`/warehouse/batches/{id}/receive`) cria uma `receipt_session` vinculada ao lote. Os itens previstos são os equipamentos identificados do lote que continuam com o técnico. A transferência de custódia segue a mesma confirmação item a item de qualquer sessão. Uma coleta identificada pela revisão depois da abertura passa a ser prevista no primeiro bipe.

Coletas sem identificação são resolvidas no balcão por `/receipt-sessions/{id}/identify`. O pedido exige uma leitura `UNKNOWN` da sessão e o código bipado entre os identificadores. Ele reaproveita `custody::validate`, que bloqueia `equipment_identifiers` e trata conflitos como revisão pendente. Em seguida, confirma o recebimento na mesma transação. `/include` adiciona à sessão um equipamento do mesmo técnico que estava fora do lote, sem transferir custódia.

O encerramento da sessão encerra o lote e libera os itens não recebidos para um novo lote. Faltantes, ocorrências e coletas sem identificação exigem justificativa.

## Operação e recuperação

A API separa a saúde do processo da prontidão do PostgreSQL e do storage. As métricas usam um token dedicado. Consultas de auditoria e do relatório de retenção exigem a conta administrativa. Logs HTTP registram o modelo da rota, o status, a duração e o identificador da requisição.

A cópia de banco e a lista de fotos usam o mesmo snapshot PostgreSQL. O backup lê apenas objetos associados a capturas confirmadas, verifica seu SHA-256 e grava o manifesto junto com o dump. A restauração requer banco e bucket vazios e verifica a ligação entre a imagem, a captura, a identificação, a custódia e a auditoria. O dump conserva o esquema de sessões e as sessões ativas ficam de fora. O procedimento de cópia externa e a preparação do ambiente estão no [guia de operação](operations.md).
