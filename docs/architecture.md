# Arquitetura das Fases 1 a 5

Um processo Axum usa o PostgreSQL para contas, sessões, capturas, identidades verificadas, custódia e auditoria. A porta de armazenamento de objetos encapsula a API S3. O Compose executa PostgreSQL e SeaweedFS com volumes persistentes e portas expostas em loopback.

## Identidade e acesso

As senhas usam Argon2id. Os tokens opacos de acesso e renovação têm hashes persistidos separadamente. A renovação rotaciona os dois tokens e mantém o limite de sete dias desde o login. Desativação e redefinição de senha são auditadas e revogam as sessões na mesma transação. O bloqueio por conta ordena renovação, revogação e operações autorizadas concorrentes. O comando de inicialização é a via de criação do primeiro administrador.

O administrador revisa capturas e gerencia contas de técnico e estoquista. O estoque privado consulta o técnico derivado da sessão. No painel administrativo, a lista de contas inclui usuários desativados e permite consultar a custódia atual de cada técnico. No piloto, o papel de estoquista concede warehouse:receive no depósito único. Cada estoquista acessa apenas suas próprias sessões.

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


## Operação e recuperação

A API separa a saúde do processo da prontidão do PostgreSQL e do storage. As métricas usam um token dedicado. Consultas de auditoria e do relatório de retenção exigem a conta administrativa. Logs HTTP registram o modelo da rota, o status, a duração e o identificador da requisição.

A cópia de banco e a lista de fotos usam o mesmo snapshot PostgreSQL. O backup lê apenas objetos associados a capturas confirmadas, verifica seu SHA-256 e grava o manifesto junto com o dump. A restauração requer banco e bucket vazios e verifica a ligação entre a imagem, a captura, a identificação, a custódia e a auditoria. O dump conserva o esquema de sessões e as sessões ativas ficam de fora. O procedimento de cópia externa e a preparação do ambiente estão no [guia de operação](operations.md).
