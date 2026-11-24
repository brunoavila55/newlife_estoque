import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { administrator, ApiError } from './api'
import type { BarcodeEvidence, User } from './db'

type Kind = 'SERIAL' | 'MAC' | 'BARCODE'
type Identifier = { kind: Kind; raw_value: string }
type Draft = Identifier & { id: string }
type Suggestion = {
  kind: Kind | 'MODEL' | 'MANUFACTURER'; label: string; raw_value: string
  normalized_value: string; confidence: number | null
}
type Capture = {
  id: string; technician_name: string; status: string; captured_at_device: string
  received_at_server: string; equipment_id: string | null
  review_issue: { code: string; reason?: string } | null
}
type Run = { id: string; status: string; created_at: string }
type Detail = Capture & {
  barcode_evidence: BarcodeEvidence | null
  complement?: {
    model?: string
    service_order?: string
    condition?: 'GOOD' | 'DAMAGED'
    power_supply?: 'ORIGINAL' | 'REPLACEMENT' | 'MISSING'
    cables?: boolean
    notes?: string
  } | null
  validated_identifiers: (Identifier & { normalized_value: string })[] | null
  runs: Run[]
  result: (Run & {
    provider: string; model_version: string; raw_tsv: string | null
    suggestions: Suggestion[]; warnings: string[]; failure_code: string | null
  }) | null
}
type Page = { items: Capture[]; next_cursor: string | null }

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const statuses: Record<string, string> = {
  RECEIVED: 'Recebida', OCR_PENDING: 'Aguardando OCR', OCR_PROCESSING: 'Processando',
  NEEDS_REVIEW: 'Em revisão', OCR_FAILED: 'Falha no OCR', IDENTIFIED: 'Validada',
}
const warningLabels: Record<string, string> = {
  LOW_CONFIDENCE: 'Há leituras com confiança baixa ou indisponível.',
  UNREADABLE_FIELD: 'Há campos ilegíveis ou com formato incerto.',
  SERIAL_MISSING: 'Nenhum serial identificado.',
  MAC_MISSING: 'Nenhum MAC identificado.',
  MULTIPLE_SERIALS: 'Foram encontrados seriais diferentes.',
  BARCODE_MAC_MISMATCH: 'O código informado tem formato de MAC e diverge dos MACs lidos.',
  TOO_MANY_VALUES: 'A imagem contém mais valores do que o painel de sugestões pode mostrar.',
}
const issues: Record<string, string> = {
  MANUAL_REVIEW: 'Pendência registrada pelo administrador',
  DIFFERENT_CUSTODY: 'O equipamento está sob outra custódia',
  IDENTIFIER_MISMATCH: 'Os identificadores divergem do cadastro',
  AMBIGUOUS_IDENTITY: 'Os identificadores apontam para mais de um equipamento',
}
const codes: Record<string, string> = { SERIAL: 'Serial', MAC: 'MAC', BARCODE: 'Código', MODEL: 'Modelo', MANUFACTURER: 'Fabricante' }
const origins: Record<string, string> = { MANUAL: 'digitação', BARCODE_DETECTOR: 'leitor do navegador', ZXING: 'ZXing' }
const failures: Record<string, string> = {
  STORAGE_UNAVAILABLE: 'Imagem temporariamente indisponível no armazenamento.',
  IMAGE_INTEGRITY: 'A imagem diverge da verificada durante o recebimento.',
  ENGINE_UNAVAILABLE: 'O mecanismo de OCR está indisponível.',
  ENGINE_TIMEOUT: 'A leitura excedeu o tempo de processamento.',
  ENGINE_REJECTED: 'O mecanismo de OCR não conseguiu processar a imagem.',
  ENGINE_OUTPUT: 'O mecanismo retornou uma leitura inválida.',
  LEASE_EXPIRED: 'O processamento foi interrompido após as tentativas automáticas.',
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'Não foi possível conectar ao servidor. Tente novamente.'
}

export function ReviewDesk({ admin, denied }: { admin: User; denied: () => void }) {
  const [filter, setFilter] = useState('pending')
  const [page, setPage] = useState<Page>()
  const [selection, setSelection] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const listRequest = useRef(0)

  const fail = useCallback((error: unknown) => {
    if (error instanceof ApiError && error.status === 401) denied()
    return errorMessage(error)
  }, [denied])

  const load = useCallback(async (cursor?: string) => {
    const request = ++listRequest.current
    setBusy(true)
    setError('')
    try {
      const params = new URLSearchParams({ status: filter })
      if (cursor) params.set('after', cursor)
      const data = await administrator<Page>(admin.id, '/admin/captures?' + params)
      if (request === listRequest.current) {
        setPage((previous) => cursor && previous ? { ...data, items: [...previous.items, ...data.items] } : data)
      }
    } catch (failure) {
      if (request === listRequest.current) setError(fail(failure))
    } finally {
      if (request === listRequest.current) setBusy(false)
    }
  }, [admin.id, fail, filter])

  useEffect(() => { void load() }, [load])

  return <>
    {error && <p className="alert" role="alert">{error}</p>}
    <section className="card work-list">
      <div className="section-head review-filters">
        <label>Capturas <select value={filter} onChange={(event) => { setPage(undefined); setFilter(event.target.value) }}>
          <option value="pending">Pendentes</option><option value="NEEDS_REVIEW">Em revisão</option>
          <option value="OCR_FAILED">Falha no OCR</option><option value="IDENTIFIED">Validadas</option><option value="all">Todas</option>
        </select></label>
        <button disabled={busy} onClick={() => void load()}>Atualizar lista</button>
      </div>
      <form className="receipt-form" onSubmit={event => {
        event.preventDefault()
        setSelection(String(new FormData(event.currentTarget).get('capture')).trim())
      }}>
        <label>Referência da coleta no balcão<input name="capture" required pattern="[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}" /></label>
        <button>Abrir pela referência</button>
      </form>
      {busy && !page && <p role="status">Consultando capturas…</p>}
      {page?.items.length === 0 && <p>Nenhuma captura neste filtro.</p>}
      {!!page?.items.length && <ul className="items">{page.items.map((capture) =>
        <li key={capture.id} className="queue-row">
          <div><strong>{capture.technician_name}</strong><br />
            <span className="muted">{statuses[capture.status]} · </span>
            <time dateTime={capture.received_at_server}>{dateTime.format(new Date(capture.received_at_server))}</time>
            {capture.review_issue && <p className="alert">{issues[capture.review_issue.code] ?? capture.review_issue.code}</p>}
          </div>
          <button aria-expanded={selection === capture.id} onClick={() => setSelection(capture.id)}>Abrir captura</button>
        </li>
      )}</ul>}
      {page?.next_cursor && <button disabled={busy} onClick={() => void load(page.next_cursor!)}>Carregar mais</button>}
    </section>
    {selection && <ReviewCapture key={selection} owner={admin.id} id={selection} fail={fail}
      changed={() => void load()} close={() => setSelection(undefined)} />}
  </>
}

function ReviewCapture({ owner, id, fail, changed, close }: {
  owner: string; id: string; fail: (error: unknown) => string; changed: () => void; close: () => void
}) {
  const [capture, setCapture] = useState<Detail>()
  const [image, setImage] = useState<string>()
  const [imageReady, setImageReady] = useState(false)
  const [error, setError] = useState('')
  const [imageError, setImageError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [reading, setReading] = useState(false)
  const [checked, setChecked] = useState(false)
  const [reason, setReason] = useState('')
  const [draft, setDraft] = useState<Draft[]>([])
  const requestNumber = useRef(0)
  const path = '/admin/captures/' + id
  const apiPath = '/captures/' + id

  const load = useCallback(async (resultId?: string) => {
    const request = ++requestNumber.current
    setReading(true)
    setChecked(false)
    setError('')
    try {
      const detail = await administrator<Detail>(owner, path + (resultId ? '?result_id=' + resultId : ''))
      if (request === requestNumber.current) setCapture(detail)
    } catch (failure) {
      if (request === requestNumber.current) setError(fail(failure))
    } finally {
      if (request === requestNumber.current) setReading(false)
    }
  }, [fail, owner, path])

  const loadImage = useCallback(async () => {
    setImageReady(false)
    setImage(undefined)
    setChecked(false)
    setImageError('')
    try {
      const result = await administrator<{ url: string }>(owner, apiPath + '/image-url')
      setImage(result.url)
    } catch (failure) {
      setImageError(fail(failure))
    }
  }, [apiPath, fail, owner])

  useEffect(() => {
    void load()
    void loadImage()
    return () => { requestNumber.current++ }
  }, [load, loadImage])

  function add(kind: Kind, raw = '') {
    setChecked(false)
    setDraft((previous) => previous.length < 16 ? [...previous, { kind, raw_value: raw, id: crypto.randomUUID() }] : previous)
  }

  function edit(identifierId: string, update: Partial<Identifier>) {
    setChecked(false)
    setDraft((previous) => previous.map((item) => item.id === identifierId ? { ...item, ...update } : item))
  }

  async function decide(decision: 'validate' | 'flag' | 'reprocess') {
    setBusy(true)
    setNotice('')
    setError('')
    try {
      if (decision === 'reprocess') {
        await administrator(owner, path + '/reprocess', { method: 'POST' })
        setNotice('OCR solicitado. Atualize para acompanhar a próxima leitura.')
      } else {
        const body = decision === 'flag' ? { decision, reason } : {
          decision, identifiers: draft.map(({ kind, raw_value }) => ({ kind, raw_value })),
          ocr_result_id: capture?.result?.id,
        }
        const result = await administrator<{ status: string; issue: Capture['review_issue'] }>(owner, apiPath + '/review', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        setNotice(result.status === 'IDENTIFIED' ? 'Identificação validada.' : 'Pendência registrada.')
        if (decision === 'flag') setReason('')
        setChecked(false)
      }
      await load()
      changed()
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setBusy(false)
    }
  }

  function validate(event: FormEvent) {
    event.preventDefault()
    if (checked && imageReady && draft.length) void decide('validate')
  }

  const result = capture?.result
  const barcode = capture?.barcode_evidence
  const details = capture?.complement
  const powerLabels = { ORIGINAL: 'Original', REPLACEMENT: 'Paralela', MISSING: 'Ausente' }
  const identified = capture?.status === 'IDENTIFIED'
  const eligible = capture && !capture.review_issue && ['RECEIVED', 'NEEDS_REVIEW', 'OCR_FAILED'].includes(capture.status)

  return <section className="card" aria-label="Detalhes da captura">
    <div className="section-head review-filters">
      <h2>{capture ? capture.technician_name : 'Detalhes da captura'}</h2>
      <div className="actions">
        <button onClick={() => void load()} disabled={reading || busy}>Atualizar captura</button>
        <button onClick={close} disabled={busy}>Fechar captura</button>
      </div>
    </div>
    {notice && <p role="status" className="success">{notice}</p>}
    {error && <p role="alert" className="alert">{error}</p>}
    {reading && !capture && <p role="status">Consultando evidências…</p>}
    {capture && <>
      <p className="muted">{statuses[capture.status]} · Foto de {dateTime.format(new Date(capture.captured_at_device))}</p>
      {capture.review_issue && <p className="alert">
        {issues[capture.review_issue.code] ?? capture.review_issue.code}
        {capture.review_issue.reason && <>. {capture.review_issue.reason}</>}
      </p>}
      {details && <section aria-label="Informações do recolhimento">
        <h3>Informações do recolhimento</h3>
        <dl>
          {details.model && <><dt>Modelo informado</dt><dd>{details.model}</dd></>}
          {details.service_order && <><dt>Ordem de serviço</dt><dd>{details.service_order}</dd></>}
          {details.condition && <><dt>Estado da carcaça</dt><dd>{details.condition === 'GOOD' ? 'Bom estado' : 'Avariada'}</dd></>}
          {details.power_supply && <><dt>Fonte</dt><dd>{powerLabels[details.power_supply]}</dd></>}
          {details.cables !== undefined && <><dt>Cabos inclusos</dt><dd>{details.cables ? 'Sim' : 'Não'}</dd></>}
          {details.notes && <><dt>Observações</dt><dd>{details.notes}</dd></>}
        </dl>
      </section>}
      <div className="review-grid">
        <section className="review-block evidence-panel">
          <h3>Foto original</h3>
          {image && <img className="review-photo" alt="Foto da etiqueta enviada pelo técnico" src={image}
            referrerPolicy="no-referrer" onLoad={() => setImageReady(true)}
            onError={() => { setImageReady(false); setImageError('Não foi possível abrir a foto.') }} />}
          {imageError && <p role="alert" className="alert">{imageError}</p>}
          <div className="actions">
            <button onClick={() => void loadImage()}>Recarregar foto</button>
            {imageReady && image && <a className="review-photo-link" href={image} target="_blank" rel="noreferrer">
              Abrir em tamanho original
            </a>}
          </div>
        </section>
        <section className="review-block">
          <h3>Sugestões de OCR</h3>
          {capture.runs.length > 1 && <label className="review-field">Tentativa
            <select value={result?.id ?? ''} disabled={reading || busy}
              onChange={(event) => { setChecked(false); void load(event.target.value) }}>
              {capture.runs.map((run) => <option key={run.id} value={run.id}>
                {dateTime.format(new Date(run.created_at))} · {run.status === 'FAILED' ? 'Falha' : 'Concluída'}
              </option>)}
            </select>
          </label>}
          {!result && <p>Nenhuma leitura disponível.</p>}
          {result?.failure_code && <p className="alert">{failures[result.failure_code] ?? 'Falha na leitura.'}</p>}
          {!!result?.warnings.length && <ul className="review-warnings">
            {result.warnings.map((warning) => <li key={warning}>{warningLabels[warning] ?? warning}</li>)}
          </ul>}
          {!!result?.suggestions.length && <ul className="items">
            {result.suggestions.map((suggestion, index) => <li className="queue-row" key={index}>
              <div><strong>{suggestion.label}: {suggestion.raw_value}</strong><br />
                <span className="muted">{suggestion.confidence === null ? 'Confiança indisponível'
                  : `Confiança do OCR: ${Math.round(suggestion.confidence * 100)}%`}</span></div>
              {!identified && (suggestion.kind === 'MAC' || suggestion.kind === 'SERIAL') &&
                <button type="button" disabled={draft.length >= 16 || busy}
                  onClick={() => add(suggestion.kind as Kind, suggestion.raw_value)}>Usar {codes[suggestion.kind]}</button>}
            </li>)}
          </ul>}
          {barcode && <div className="review-barcode">
            <p><strong>Código registrado na captura:</strong> {barcode.raw_value} ({origins[barcode.source]})</p>
            {!identified && <button disabled={draft.length >= 16 || busy} onClick={() => add('BARCODE', barcode.raw_value)}>Usar código</button>}
          </div>}
          {result?.raw_tsv && <details><summary>Ver leitura bruta</summary>
            <p className="muted">{result.model_version}</p><pre>{result.raw_tsv}</pre>
          </details>}
          {eligible && <button disabled={busy} onClick={() => void decide('reprocess')}>Reprocessar OCR</button>}
        </section>
      </div>
      {identified ? <section className="review-block">
        <h3>Identificadores validados</h3>
        <ul>{capture.validated_identifiers?.map((item) =>
          <li key={item.kind + item.normalized_value}>{codes[item.kind]}: {item.raw_value}</li>)}</ul>
      </section> : <>
        <form className="review-block" onSubmit={validate}>
          <h3>Conferir identificação</h3>
          {draft.map((item) => <div key={item.id} className="review-draft">
            <label className="review-field">Tipo<select value={item.kind} disabled={busy}
              onChange={(event) => edit(item.id, { kind: event.target.value as Kind })}>
              <option value="SERIAL">Serial</option><option value="MAC">MAC</option><option value="BARCODE">Código</option>
            </select></label>
            <label className="review-field">Valor<input value={item.raw_value} maxLength={128} required disabled={busy}
              onChange={(event) => edit(item.id, { raw_value: event.target.value })} /></label>
            <button type="button" disabled={busy} onClick={() => {
              setChecked(false)
              setDraft((previous) => previous.filter((entry) => entry.id !== item.id))
            }}>Remover</button>
          </div>)}
          <button type="button" disabled={draft.length >= 16 || busy} onClick={() => add('SERIAL')}>Adicionar identificador</button>
          <label className="review-confirm"><input type="checkbox" checked={checked} disabled={!imageReady || busy || !draft.length}
            onChange={(event) => setChecked(event.target.checked)} /> Conferi os valores na foto original.</label>
          <button className="primary" disabled={!checked || !imageReady || busy || reading || !draft.length}>Validar identificação</button>
        </form>
        <form className="review-block" onSubmit={(event) => { event.preventDefault(); void decide('flag') }}>
          <label className="review-field">Justificativa da pendência
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} required maxLength={500} />
          </label>
          <button disabled={busy || !reason.trim()}>Registrar pendência</button>
        </form>
      </>}
    </>}
  </section>
}
