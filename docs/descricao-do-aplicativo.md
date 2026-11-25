# Estoque New Life — Recolhimento e devolução de equipamentos

O sistema substitui o bloco de notas usado pelos técnicos. O técnico fotografa a etiqueta de cada roteador recolhido. Ao voltar, monta um **lote** com o que vai entregar. No balcão, o estoquista abre o lote e bipa cada equipamento com o leitor de código de barras. Cada técnico tem o próprio estoque, e cada entrega fica registrada em um lote com comprovante.

## Técnico (PWA no celular)

| Aba | Para que serve |
| --- | --- |
| **Coletar** | Fotografar a etiqueta e, se quiser, digitar o código e a OS. Funciona sem internet. |
| **Comigo** | Ver o que está sob sua responsabilidade e montar o lote de entrega. |
| **Lotes** | Acompanhar cada lote: aguardando, em conferência, conferido ou cancelado. Mostra o que foi recebido e o que continua com o técnico. |
| **Envios** | Fila de fotos ainda no celular, com o botão **Sincronizar agora**. |

## Estoque (navegador no computador)

| Módulo | Para que serve |
| --- | --- |
| **Lotes para conferir** | Fila de lotes enviados. Abre a mesa de conferência. |
| **Mesa de conferência** | Bipe e **Enter** por equipamento. Mostra as listas de faltantes, recebidos e ocorrências, além da conferência de fonte, cabos e estado. Inclui itens fora do lote e identifica fotos pelo bipe. Gera o comprovante. |
| **Estoque por técnico** | Saldo de cada técnico, com fotos sem identificação, lotes abertos e alerta de retenção acima de 7 dias. |
| **Comprovantes** | Conferências anteriores e envio do comprovante em texto pelo WhatsApp do técnico, sem papel. |
| **Rastrear equipamento** | Histórico de custódia por serial ou MAC. |
| **Revisão de fotos** e **Usuários e permissões** | Exclusivos do administrador. |

## Regras que não mudam

- Foto, OCR e lote não transferem custódia. Apenas a confirmação do bipe pelo estoque transfere.
- Itens não entregues continuam com o técnico depois do encerramento do lote.
- Lotes, leituras, movimentos e auditoria não podem ser apagados no banco.

Detalhes técnicos estão em [architecture.md](architecture.md) e no [contrato OpenAPI](api/openapi.yaml).
