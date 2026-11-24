# Estoque New Life — Sistema Integrado de Recolhimento e Devolução de Equipamentos

> Especificação Técnica e Funcional do SaaS — Versão 1.0 (Conforme os 24 Capítulos do Requisito de Produto).

O **Estoque New Life** é a solução completa de rastreabilidade de ativos de telecomunicação (roteadores, ONTs, modems e repetidores). Ele substitui o controle manual ou bloco de notas por uma cadeia de custódia digital de ponta a ponta: desde a captura da foto da etiqueta em campo até a conferência ágil com scanner de código de barras no balcão e triagem pós-recebimento.

---

## 1. Visão Geral dos Módulos Implementados

### 📱 Aplicativo Móvel do Técnico (PWA Offline-First — Cap. 04, 05, 07, 20)
- **Início:** Dashboard pessoal com saudação funcional, equipamentos em posse, dias de retenção com alertas de devolução, status de sincronização e botão principal de captura rápida.
- **Registrar (Câmera com OCR & Leitor):** Captura com câmera traseira com guia de enquadramento, upload de galeria ou digitação manual.
- **Revisão e Cadastro Complementar:** Foto ampliável, campos separados para Serial (preservando zeros à esquerda) e MAC Address (formatação automática `AA:BB:CC:DD:EE:FF`), seleção de Modelo Homologado, número da Ordem de Serviço (OS), condição física da carcaça (Bom / Avariado), fonte de alimentação (Original / Paralela / Ausente) e cabos.
- **Modo Registrar Próximo (Produtividade):** Mantém a mesma OS e contexto preenchidos para registrar múltiplos aparelhos do mesmo cliente em segundos.
- **Minha Carteira & Criação de Lotes:** Listagem dos aparelhos sob custódia do técnico com seleção múltipla e botão **"Criar Lote com Selecionados"**.
- **Meus Lotes de Devolução:** Acompanhamento dos lotes declarados com QR Code gerado em SVG offline para o estoquista bipar no balcão e recibos emitidos.
- **Fila Offline com Dexie.js:** Armazenamento seguro de fotos em IndexedDB com medição de espaço e sincronização causal via backoff.

---

### 🖥️ Central Desktop de Conferência e Gestão (Cap. 08, 09, 10, 11, 12, 14, 15)
- **Sidebar & Topbar Unificadas:** Navegação rápida entre os 11 módulos operacionais, busca global (`Ctrl+K`), seletor de unidade ativa, indicador de conectividade em tempo real e central de notificações in-app.
- **Visão Geral & Indicadores (Cap. 14):** Cards KPI em tempo real (Em Campo com Técnicos, Aguardando Entrega, Recebidos no Mês, Taxa de Devolução %, Divergências Abertas, Estoque Disponível, Fila de Triagem), gráficos de ciclo de vida e monitoramento de técnicos com equipamentos retidos há mais de 7 dias.
- **Mesa de Recebimento & Scanner HID (Cap. 08 & 09):** Bip contínuo com leitor de código de barras USB/Bluetooth, foco automático persistente, suporte a sufixo configurável (Enter / Tab), feedback sonoro rico com Web Audio API (tons de Sucesso, Duplicado, Desconhecido e Divergência) e contadores de sessão separados de número de bipes.
- **Emissão de Termo de Quitação (Cap. 07 & 08):** Geração imediata de Comprovante de Quitação Digital com listagem de seriais aceitos, faltantes, inspeção física de fontes/cabos e layout pronto para impressão e PDF.
- **Lotes e Entregas (Cap. 07):** Gestão de lotes em balcão, suporte a entrega parcial (aceita parte dos itens mantendo faltantes na responsabilidade do técnico) e cancelamento seguro.
- **Catálogo de Modelos & Rastreabilidade (Cap. 06):** Consulta rastreável de qualquer serial ou MAC com linha do tempo de custódia completa e homologação de modelos de equipamentos (Huawei, Intelbras, ZTE, Fiberhome, TP-Link).
- **Triagem e Destinação Pós-Recebimento (Cap. 11):** Fila de equipamentos recebidos com checklist técnico (carcaça, conectores, fonte, cabos, testes elétricos, reset de fábrica e limpeza de dados anteriores do cliente - conformidade LGPD) e destinação para: Estoque Disponível, Manutenção, Quarentena, Sucata ou Devolução ao Fornecedor.
- **Divergências e Exceções (Cap. 10):** Tratamento de ocorrências: códigos desconhecidos (quarentena física), tentativas duplicadas, itens de outro técnico, avarias graves e workflow de resolução com justificativa auditada.
- **Estoque, Endereçamento e Transferências (Cap. 11):** Endereçamento em depósito (Área e Prateleira), contagem física de inventário assistida por leitor e remessas de transferência entre unidades em trânsito.
- **Relatórios & Exportação (Cap. 15):** Relatórios de Custódia em Campo, Recebimentos, Lotes, Triagem e Kardex de Auditoria, com filtros por período e exportação para CSV/Excel com formatação segura contra perda de zeros e injeção de fórmulas.
- **Diagnóstico de Leitores HID (Cap. 09):** Bancada de teste que mede a velocidade de bipe em milissegundos (<25ms vs digitação manual), identifica o terminador (Enter/Tab), detecta a simbologia (Code 128, Code 39, EAN-13, QR) e valida o formato de MAC e Serial sem gravar alterações no banco.
- **Onboarding & Central de Ajuda (Cap. 21):** Checklist interativo de 6 etapas de implantação e guia de configuração de leitores Zebra, Honeywell, Elgin e Bluetooth.

---

## 2. Design System New Life (Cap. 13)
- Paleta visual corporativa moderna com Azul Petróleo / Navy (`#0b253a`), Tech Teal (`#0284c7`, `#009688`), superfícies claras e cartões nítidos.
- Tipografia proporcional com fontes mono tabulares para números de série e endereços MAC.
- Badges semânticos com alto contraste para status (`IDENTIFIED`, `PENDING`, `IN_CHECK`, `APPROVED`, `REJECTED`, `AVAILABLE`, `MAINTENANCE`, `SCRAP`).
- Acessibilidade WCAG 2.2 AA (foco visível, navegação por teclado e atalhos rápidos).
- Folha de estilo de impressão (`@media print`) otimizada para comprovantes de entrega e termos de quitação sem elementos decorativos ou barras de navegação.

---

## 3. Comandos de Execução Local

```sh
# 1. Backend Rust e Migrations
cargo run --locked -p stock-api

# 2. Worker de OCR
cargo run --locked -p stock-api -- worker

# 3. Frontend Web + PWA
cd apps/web
npm run build
npm run preview
```
