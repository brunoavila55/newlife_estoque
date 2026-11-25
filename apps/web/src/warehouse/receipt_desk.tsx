import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { ApiError, warehouse } from '../api'
import { formatWhatsapp } from '../users'
import { playSound } from '../audio'
import {
  batchName, dateTime, jsonPost, kindLabel, type Identifier, type Suggestion,
} from '../delivery'

type Session = {
  id: string; technician_id: string; technician_name: string; technician_whatsapp: string | null; warehouse_name: string
  opened_at: string; closed_at: string | null; closing_reason: string | null
  batch_id: string | null; batch_number: number | null; batch_notes: string | null
}
type Inspection = { power_supply: 'ORIGINAL' | 'REPLACEMENT' | 'MISSING'; cables_present: boolean; condition: 'GOOD' | 'DAMAGED' | 'INOPERATIVE' }
type Item = { equipment_id: string; matched_scan_id: string | null; confirmed_at: string | null; identifiers: Identifier[]; inspection: Inspection | null }
type Scan = {
  id: string; equipment_id: string | null; result: string; value: string
  secondary_value: string | null; created_at: string; capture_candidates?: string[]
}
type Unidentified = {
  capture_id: string; captured_at: string; typed_code: string | null
  complement: { service_order?: string } | null; suggestions: Suggestion[]
}
type Totals = { expected: number; confirmed: number; missing: number; duplicates: number; divergences: number; unidentified: number }
type Detail = {
  session: Session; totals: Totals; items: Item[]; scans: Scan[]
  next_item: string | null; next_scan: string | null; unidentified: Unidentified[]
}

type Focus =
  | { kind: 'confirm'; item: Item }
  | { kind: 'identify'; scan: Scan; candidates: string[] }
  | { kind: 'include'; scan: Scan }
  | { kind: 'problem'; scan: Scan }

const supplies = { ORIGINAL: 'Original', REPLACEMENT: 'Paralela', MISSING: 'Ausente' } as const
const conditions = { GOOD: 'Bom', DAMAGED: 'Avariado', INOPERATIVE: 'Não liga' } as const
const DEFAULT_INSPECTION: Inspection = { power_supply: 'ORIGINAL', cables_present: true, condition: 'GOOD' }

const problems: Record<string, { title: string; hint: string }> = {
  OTHER_TECHNICIAN: { title: 'Equipamento de outro técnico', hint: 'Separe este equipamento. Ele está sob responsabilidade de outra pessoa.' },
  ALREADY_RECEIVED: { title: 'Já recebido anteriormente', hint: 'Este equipamento já está no estoque. Separe e verifique a etiqueta.' },
  AMBIGUOUS: { title: 'Código ligado a mais de um equipamento', hint: 'Bipe outro código da etiqueta (MAC ou serial) para desempatar.' },
  IDENTIFIER_MISMATCH: { title: 'Os dois códigos não batem', hint: 'Os códigos lidos pertencem a equipamentos diferentes. Separe para análise.' },
  UNKNOWN: { title: 'Código não cadastrado', hint: 'Nenhum equipamento ou foto do lote corresponde a este código. Separe o equipamento.' },
  DUPLICATE_SCAN: { title: 'Já bipado nesta conferência', hint: 'Este equipamento já foi lido. Siga para o próximo.' },
}

function ids(identifiers: Identifier[]): string {
  return identifiers.map((item) => kindLabel[item.kind] + ' ' + item.raw_value).join(' · ')
}

function guessKind(value: string): 'MAC' | 'SERIAL' {
  return /^([0-9a-f]{2}([:-]?)){5}[0-9a-f]{2}$/i.test(value.trim()) ? 'MAC' : 'SERIAL'
}

/** Mesa de conferência de um lote (ou de uma sessão já encerrada, em modo leitura). */
export function ReceiptDesk({ owner, clerkName, id, denied, back }: {
  owner: string; clerkName: string; id: string; denied: () => void; back: () => void
}) {
  const [detail, setDetail] = useState<Detail>()
  const [focus, setFocus] = useState<Focus>()
  const [inspection, setInspection] = useState<Inspection>(DEFAULT_INSPECTION)
  const [value, setValue] = useState('')
  const [terminator, setTerminator] = useState(() => localStorage.getItem('newlife-scanner-suffix') ?? 'Enter')
  const [photos, setPhotos] = useState<Record<string, string>>({})
  const [chosen, setChosen] = useState<string>()
  const [closing, setClosing] = useState(false)
  const [reason, setReason] = useState('')
  const [flash, setFlash] = useState<{ tone: 'ok' | 'warn' | 'bad'; text: string }>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const pendingScan = useRef<{ client_scan_id: string; value: string }>(undefined)
  const path = '/receipt-sessions/' + id

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && failure.status === 401) denied()
    setError(failure instanceof ApiError ? failure.message : 'Sem conexão com o servidor. Tente novamente.')
    playSound('ERROR')
  }, [denied])

  const load = useCallback(async () => {
    const data = await warehouse<Detail>(owner, path + '?limit=100')
    while (data.next_item) {
      const page = await warehouse<Detail>(owner, path + '?limit=100&after_item=' + encodeURIComponent(data.next_item))
      data.items.push(...page.items)
      data.next_item = page.next_item
    }
    setDetail(data)
    return data
  }, [owner, path])

  const focusScanner = useCallback(() => requestAnimationFrame(() => field.current?.focus()), [])
  useEffect(() => { void load().catch(fail) }, [fail, load])
  useEffect(() => { localStorage.setItem('newlife-scanner-suffix', terminator) }, [terminator])

  // Foco persistente: qualquer tecla digitada fora de um campo volta para o leitor.
  const open = detail ? !detail.session.closed_at : false
  useEffect(() => {
    if (!open || closing) return
    focusScanner()
    function capture(event: globalThis.KeyboardEvent) {
      const target = event.target as HTMLElement
      if (target.closest('input, textarea, select')) return
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) field.current?.focus()
      if (event.key === 'Enter' && target.tagName !== 'BUTTON') field.current?.focus()
    }
    window.addEventListener('keydown', capture)
    return () => window.removeEventListener('keydown', capture)
  }, [open, closing, focusScanner])

  async function perform(operation: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      fail(failure)
    } finally {
      setBusy(false)
      focusScanner()
    }
  }

  async function photoOf(key: string, url: string) {
    if (photos[key]) return
    try {
      const evidence = await warehouse<{ url: string }>(owner, url)
      setPhotos((previous) => ({ ...previous, [key]: evidence.url }))
    } catch (failure) {
      fail(failure)
    }
  }

  async function scan(code: string) {
    await perform(async () => {
      setFlash(undefined)
      if (pendingScan.current?.value !== code) pendingScan.current = { value: code, client_scan_id: crypto.randomUUID() }
      const result = await warehouse<Scan>(owner, path + '/scan', jsonPost(pendingScan.current))
      pendingScan.current = undefined
      setValue('')
      setChosen(undefined)
      const data = await load()
      if (result.result === 'MATCHED') {
        const item = data.items.find((entry) => entry.equipment_id === result.equipment_id)
        playSound('MATCHED')
        setInspection(DEFAULT_INSPECTION)
        setFocus(item && { kind: 'confirm', item })
        return
      }
      if (result.result === 'DUPLICATE_SCAN') {
        const item = data.items.find((entry) => entry.equipment_id === result.equipment_id)
        playSound('DUPLICATE')
        if (item && !item.confirmed_at) {
          setFocus({ kind: 'confirm', item })
        } else {
          setFocus(undefined)
          setFlash({ tone: 'warn', text: 'Já recebido nesta conferência · ' + (item ? ids(item.identifiers) : code) })
        }
        return
      }
      if (result.result === 'NOT_IN_SESSION') {
        playSound('UNKNOWN')
        setFocus({ kind: 'include', scan: result })
        return
      }
      if (result.result === 'UNKNOWN' && data.unidentified.length > 0) {
        const candidates = result.capture_candidates ?? []
        playSound('UNKNOWN')
        setFocus({ kind: 'identify', scan: result, candidates })
        if (candidates.length === 1) setChosen(candidates[0])
        for (const capture of candidates) void photoOf(capture, path + '/captures/' + capture + '/image-url')
        return
      }
      playSound('ERROR')
      setFocus({ kind: 'problem', scan: result })
    })
  }

  async function confirm(item: Item) {
    if (!item.matched_scan_id || item.confirmed_at) return
    await perform(async () => {
      await warehouse(owner, path + '/confirm', jsonPost({
        equipment_id: item.equipment_id, scan_id: item.matched_scan_id, inspection,
      }))
      setFocus(undefined)
      setInspection(DEFAULT_INSPECTION)
      setFlash({ tone: 'ok', text: 'Recebido · ' + ids(item.identifiers) })
      await load()
    })
  }

  async function identify(scan: Scan, capture: string) {
    await perform(async () => {
      const result = await warehouse<{ result: string }>(owner, path + '/identify', jsonPost({
        scan_id: scan.id, capture_id: capture, inspection,
        identifiers: [{ kind: guessKind(scan.value), raw_value: scan.value }],
      }))
      setFocus(undefined)
      setChosen(undefined)
      setInspection(DEFAULT_INSPECTION)
      if (result.result === 'RECEIVED') {
        playSound('MATCHED')
        setFlash({ tone: 'ok', text: 'Identificado e recebido · ' + scan.value })
      } else {
        playSound('ERROR')
        setFlash({ tone: 'bad', text: 'O código conflita com outro cadastro. A foto foi para revisão do administrador e o equipamento continua com o técnico.' })
      }
      await load()
    })
  }

  async function include(entry: Scan) {
    let included = false
    await perform(async () => {
      await warehouse(owner, path + '/include', jsonPost({ value: entry.value }))
      included = true
    })
    // Incluir não recebe: o item é lido de novo e segue a confirmação normal.
    if (included) await scan(entry.value)
  }

  function keyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' && terminator === 'Tab' && value.trim()) {
      event.preventDefault()
      return
    }
    if (event.key !== terminator || event.shiftKey) return
    event.preventDefault()
    const code = value.trim()
    if (code) {
      void scan(code)
      return
    }
    // Enter com o campo vazio confirma a ação em destaque (o leitor nunca envia Enter sozinho).
    if (focus?.kind === 'confirm') void confirm(focus.item)
    else if (focus?.kind === 'include') void include(focus.scan)
    else if (focus?.kind === 'identify' && chosen) void identify(focus.scan, chosen)
  }

  if (!detail) return <section className="card">
    {error ? <p className="alert" role="alert">{error}</p> : <p role="status">Abrindo conferência…</p>}
    <button onClick={back}>Voltar</button>
  </section>

  const { session, totals } = detail
  const title = session.batch_number ? batchName({ number: session.batch_number }) : 'Recebimento avulso'
  const confirmed = detail.items.filter((item) => item.confirmed_at)
  const waiting = detail.items.filter((item) => !item.confirmed_at)
  const goal = totals.expected + totals.unidentified
  const issues = detail.scans.filter((entry) => !['MATCHED', 'DUPLICATE_SCAN'].includes(entry.result))
  // Leituras que depois foram localizadas no lote (incluídas ou identificadas pela foto).
  const resolved = new Set(detail.scans.filter((entry) => entry.result === 'MATCHED').map((entry) => entry.value))
  const outstanding = totals.missing + totals.unidentified
  const needsReason = outstanding > 0 || totals.divergences > 0

  const inspectionPanel = <div className="inspection-bar" aria-label="Conferência física">
    <fieldset><legend>Fonte</legend>{Object.entries(supplies).map(([key, label]) =>
      <button key={key} type="button" aria-pressed={inspection.power_supply === key}
        onClick={() => { setInspection({ ...inspection, power_supply: key as Inspection['power_supply'] }); focusScanner() }}>{label}</button>)}
    </fieldset>
    <fieldset><legend>Cabos</legend>{([[true, 'Sim'], [false, 'Não']] as const).map(([key, label]) =>
      <button key={label} type="button" aria-pressed={inspection.cables_present === key}
        onClick={() => { setInspection({ ...inspection, cables_present: key }); focusScanner() }}>{label}</button>)}
    </fieldset>
    <fieldset><legend>Estado</legend>{Object.entries(conditions).map(([key, label]) =>
      <button key={key} type="button" aria-pressed={inspection.condition === key}
        onClick={() => { setInspection({ ...inspection, condition: key as Inspection['condition'] }); focusScanner() }}>{label}</button>)}
    </fieldset>
  </div>

  return <div className="counter-desk">
    <header className="counter-head no-print">
      <button type="button" className="small-btn" onClick={back} disabled={busy}>← Voltar</button>
      <div className="counter-title">
        <h1>{title}</h1>
        <p className="muted">{session.technician_name} · {open ? 'Em conferência' : 'Encerrado em ' + dateTime.format(new Date(session.closed_at!))}</p>
        {session.batch_notes && <p className="muted">“{session.batch_notes}”</p>}
      </div>
      <div className="counter-score" aria-live="polite">
        <strong>{totals.confirmed}</strong><span>de {goal} recebidos</span>
        <progress value={totals.confirmed} max={Math.max(goal, 1)} />
      </div>
    </header>

    {error && <p className="alert no-print" role="alert">{error}</p>}

    {open && <section className="card counter-scan no-print">
      <form onSubmit={(event) => event.preventDefault()}>
        <label className="counter-field">
          <span>Bipe o equipamento</span>
          <input ref={field} value={value} onChange={(event) => setValue(event.target.value)} onKeyDown={keyDown}
            onBlur={() => { if (!closing) setTimeout(() => { if (!document.activeElement?.closest('input, textarea, select, button')) focusScanner() }, 0) }}
            autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={128} disabled={busy}
            placeholder="Serial ou MAC" aria-describedby="scanner-hint" />
        </label>
        <div className="counter-scan-side">
          <button type="button" className="primary" disabled={busy || !value.trim()} onClick={() => void scan(value.trim())}>Buscar</button>
          <label className="muted small-text">Sufixo
            <select value={terminator} onChange={(event) => setTerminator(event.target.value)}>
              <option value="Enter">Enter</option><option value="Tab">Tab</option>
            </select>
          </label>
        </div>
      </form>
      <p id="scanner-hint" className="muted small-text">Depois do bipe, aperte <kbd>Enter</kbd> para confirmar o recebimento.</p>
      {flash && <p className={'counter-flash ' + flash.tone} role="status">{flash.text}</p>}

      {focus?.kind === 'confirm' && <div className="counter-focus ok">
        <div className="counter-focus-head">
          <div><span className="badge badge-success">Está no lote</span>
            <h2 className="mono">{ids(focus.item.identifiers)}</h2></div>
          <button type="button" className="small-btn" onClick={() => void photoOf(focus.item.equipment_id, path + '/items/' + focus.item.equipment_id + '/image-url')}>Ver foto da coleta</button>
        </div>
        {photos[focus.item.equipment_id] && <img src={photos[focus.item.equipment_id]} className="counter-photo" alt="Foto da etiqueta na coleta" referrerPolicy="no-referrer" />}
        {inspectionPanel}
        <div className="counter-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void confirm(focus.item)}>Confirmar recebimento <kbd>Enter</kbd></button>
          <button type="button" disabled={busy} onClick={() => { setFocus(undefined); focusScanner() }}>Agora não</button>
        </div>
      </div>}

      {focus?.kind === 'include' && <div className="counter-focus warn">
        <span className="badge badge-warning">Fora do lote</span>
        <h2 className="mono">{focus.scan.value}</h2>
        <p>Está com {session.technician_name}, mas não foi colocado neste lote. Se ele veio na pilha, inclua e confira.</p>
        <div className="counter-actions">
          <button type="button" className="primary" disabled={busy} onClick={() => void include(focus.scan)}>Incluir no lote <kbd>Enter</kbd></button>
          <button type="button" disabled={busy} onClick={() => { setFocus(undefined); focusScanner() }}>Separar</button>
        </div>
      </div>}

      {focus?.kind === 'identify' && <div className="counter-focus identify">
        <span className="badge badge-purple">Identificar pela foto</span>
        <h2 className="mono">{focus.scan.value}</h2>
        <p>{focus.candidates.length
          ? 'Este código bate com a leitura sugerida de uma foto do lote. Compare a etiqueta e confirme.'
          : 'Código ainda não cadastrado. Se ele for de uma destas fotos do lote, selecione a foto correspondente.'}</p>
        <div className="capture-picker">{detail.unidentified
          .filter((entry) => !focus.candidates.length || focus.candidates.includes(entry.capture_id))
          .map((entry) => <button key={entry.capture_id} type="button" aria-pressed={chosen === entry.capture_id}
            className="capture-option" onClick={() => {
              setChosen(entry.capture_id)
              void photoOf(entry.capture_id, path + '/captures/' + entry.capture_id + '/image-url')
              focusScanner()
            }}>
            {photos[entry.capture_id]
              ? <img src={photos[entry.capture_id]} alt="Foto da etiqueta" referrerPolicy="no-referrer" />
              : <span className="capture-option-empty">Toque para ver a foto</span>}
            <span className="mono small-text">{entry.typed_code ?? entry.suggestions[0]?.raw_value ?? 'sem leitura'}</span>
            <span className="muted small-text">{dateTime.format(new Date(entry.captured_at))}</span>
          </button>)}
        </div>
        {chosen && <>{inspectionPanel}
          <p className="muted small-text">O código bipado será gravado como {guessKind(focus.scan.value) === 'MAC' ? 'MAC' : 'serial'} do equipamento.</p></>}
        <div className="counter-actions">
          <button type="button" className="primary" disabled={busy || !chosen} onClick={() => chosen && void identify(focus.scan, chosen)}>É este equipamento · receber <kbd>Enter</kbd></button>
          <button type="button" disabled={busy} onClick={() => { setFocus(undefined); setChosen(undefined); focusScanner() }}>Nenhuma destas · separar</button>
        </div>
      </div>}

      {focus?.kind === 'problem' && <div className="counter-focus bad">
        <span className="badge badge-danger">{problems[focus.scan.result]?.title ?? 'Ocorrência'}</span>
        <h2 className="mono">{focus.scan.value}</h2>
        <p>{problems[focus.scan.result]?.hint ?? 'Separe o equipamento para análise.'}</p>
        <p className="muted small-text">A leitura ficou registrada nas ocorrências deste lote.</p>
      </div>}
    </section>}

    <div className="counter-columns no-print">
      <section className="card">
        <h2>Faltam <span className="count">{outstanding}</span></h2>
        {outstanding === 0 && <p className="empty-state">Todos os itens do lote foram recebidos.</p>}
        <ul className="counter-list">
          {waiting.map((item) => <li key={item.equipment_id}>
            <span className="mono">{ids(item.identifiers)}</span>
            {item.matched_scan_id && open
              ? <button type="button" className="small-btn" onClick={() => { setInspection(DEFAULT_INSPECTION); setFocus({ kind: 'confirm', item }); focusScanner() }}>Conferir</button>
              : <span className="badge badge-info">Aguardando bipe</span>}
          </li>)}
          {detail.unidentified.map((entry) => <li key={entry.capture_id}>
            <span className="mono muted">{entry.typed_code ?? entry.suggestions[0]?.raw_value ?? 'Etiqueta não lida'}</span>
            <span className="badge badge-purple">Identificar no bipe</span>
          </li>)}
        </ul>
      </section>
      <section className="card">
        <h2>Recebidos <span className="count">{confirmed.length}</span></h2>
        <ul className="counter-list">{confirmed.map((item) => <li key={item.equipment_id}>
          <span className="mono">{ids(item.identifiers)}</span>
          {item.inspection && <span className="muted small-text">Fonte {supplies[item.inspection.power_supply].toLowerCase()} · cabos {item.inspection.cables_present ? 'sim' : 'não'} · {conditions[item.inspection.condition].toLowerCase()}</span>}
        </li>)}</ul>
      </section>
      {issues.length > 0 && <section className="card">
        <h2>Ocorrências <span className="count">{issues.length}</span></h2>
        <ul className="counter-list">{issues.map((entry) => <li key={entry.id}>
          <span className="mono">{entry.value}</span>
          <span className="muted small-text">{problems[entry.result]?.title ?? (entry.result === 'NOT_IN_SESSION' ? 'Fora do lote' : entry.result)}
            {resolved.has(entry.value) && <> · <span className="badge badge-success">resolvida</span></>}</span>
        </li>)}</ul>
      </section>}
    </div>

    {open && <section className="card counter-close no-print">
      {closing ? <form onSubmit={(event) => {
        event.preventDefault()
        void perform(async () => {
          await warehouse(owner, path + '/close', jsonPost({ reason: reason.trim() || null }))
          setClosing(false)
          setFocus(undefined)
          await load()
        })
      }}>
        <h2>Encerrar conferência</h2>
        {needsReason
          ? <p className="alert">{outstanding > 0 && <>{outstanding} item{outstanding > 1 ? 's' : ''} não {outstanding > 1 ? 'foram recebidos e continuarão' : 'foi recebido e continuará'} com {session.technician_name}. </>}
            {totals.divergences > 0 && <>{totals.divergences} ocorrência{totals.divergences > 1 ? 's' : ''} no registro. </>}Explique o motivo.</p>
          : <p className="success">Todos os itens foram recebidos.</p>}
        <label>Justificativa {needsReason ? '(obrigatória)' : '(opcional)'}
          <textarea autoFocus maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} required={needsReason} />
        </label>
        <div className="counter-actions">
          <button className="primary" disabled={busy || (needsReason && !reason.trim())}>Encerrar e gerar comprovante</button>
          <button type="button" disabled={busy} onClick={() => { setClosing(false); focusScanner() }}>Continuar conferindo</button>
        </div>
      </form> : <div className="counter-close-row">
        <p className="muted">Terminou a pilha? Encerre para gerar o comprovante. Itens não bipados continuam com o técnico.</p>
        <button type="button" onClick={() => setClosing(true)} disabled={busy}>Encerrar conferência</button>
      </div>}
    </section>}

    {!open && <Voucher detail={detail} clerkName={clerkName} title={title} />}
  </div>
}

function inspectionText(inspection: Inspection | null) {
  if (!inspection) return ''
  return ' — fonte ' + supplies[inspection.power_supply].toLowerCase()
    + ', cabos ' + (inspection.cables_present ? 'sim' : 'não')
    + ', ' + conditions[inspection.condition].toLowerCase()
}

/** Comprovante em texto simples (formatação do WhatsApp), para enviar sem papel. */
function voucherText(detail: Detail, clerkName: string, title: string) {
  const { session, totals } = detail
  const received = detail.items.filter((item) => item.confirmed_at)
  const missing = detail.items.filter((item) => !item.confirmed_at)
  const lines = [
    '*Comprovante de devolução — New Life*',
    title,
    '',
    'Técnico: ' + session.technician_name,
    'Recebido por: ' + clerkName + ' · ' + session.warehouse_name,
    'Início: ' + dateTime.format(new Date(session.opened_at)),
    'Encerramento: ' + (session.closed_at ? dateTime.format(new Date(session.closed_at)) : '—'),
    '',
    `*Recebidos (${totals.confirmed})*`,
    ...received.map((item, index) => `${index + 1}. ${ids(item.identifiers)}${inspectionText(item.inspection)}`),
  ]
  if (received.length === 0) lines.push('Nenhum equipamento recebido.')
  const pending = missing.length + detail.unidentified.length
  if (pending > 0) {
    lines.push('', `*Continuam com o técnico (${pending})*`,
      ...missing.map((item) => '• ' + ids(item.identifiers)),
      ...detail.unidentified.map((entry) => '• Foto sem identificação de ' + dateTime.format(new Date(entry.captured_at))
        + (entry.typed_code ? ' · código informado ' + entry.typed_code : '')))
  }
  if (session.closing_reason) lines.push('', 'Justificativa: ' + session.closing_reason)
  lines.push('', 'Sessão ' + session.id)
  return lines.join('\n')
}

function Voucher({ detail, clerkName, title }: { detail: Detail; clerkName: string; title: string }) {
  const { session, totals } = detail
  const received = detail.items.filter((item) => item.confirmed_at)
  const missing = detail.items.filter((item) => !item.confirmed_at)
  const [copied, setCopied] = useState(false)
  const text = voucherText(detail, clerkName, title)
  const phone = session.technician_whatsapp
  const link = phone && 'https://web.whatsapp.com/send?phone=' + phone + '&text=' + encodeURIComponent(text)

  async function copy() {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      setCopied(false)
    }
  }

  return <section className="card voucher">
    <div className="section-head">
      {phone
        ? <p className="muted">Envie o comprovante para o WhatsApp de {session.technician_name} ({formatWhatsapp(phone)}).</p>
        : <p className="muted">{session.technician_name} não tem WhatsApp cadastrado. Peça ao administrador para cadastrar o número em Usuários ou copie o texto.</p>}
      <div className="actions">
        {link && <a className="whatsapp-btn" href={link} target="_blank" rel="noopener noreferrer">Enviar pelo WhatsApp</a>}
        <button type="button" className={link ? 'small-btn' : 'primary'} onClick={() => void copy()}>{copied ? 'Texto copiado' : 'Copiar texto'}</button>
      </div>
    </div>
    <div className="receipt-print">
      <header className="voucher-head">
        <img src="/icons/new-life-logo.png" alt="New Life" />
        <div><h1>Comprovante de devolução</h1><p>{title}</p></div>
      </header>
      <dl className="voucher-facts">
        <div><dt>Técnico</dt><dd>{session.technician_name}</dd></div>
        <div><dt>Recebido por</dt><dd>{clerkName} · {session.warehouse_name}</dd></div>
        <div><dt>Início</dt><dd>{dateTime.format(new Date(session.opened_at))}</dd></div>
        <div><dt>Encerramento</dt><dd>{session.closed_at && dateTime.format(new Date(session.closed_at))}</dd></div>
        <div><dt>Recebidos</dt><dd>{totals.confirmed}</dd></div>
        <div><dt>Não entregues</dt><dd>{totals.missing + totals.unidentified}</dd></div>
      </dl>
      <h2>Recebidos ({received.length})</h2>
      <table className="voucher-table"><thead><tr><th>Identificação</th><th>Fonte</th><th>Cabos</th><th>Estado</th></tr></thead>
        <tbody>{received.map((item) => <tr key={item.equipment_id}>
          <td className="mono">{ids(item.identifiers)}</td>
          <td>{item.inspection ? supplies[item.inspection.power_supply] : '—'}</td>
          <td>{item.inspection ? (item.inspection.cables_present ? 'Sim' : 'Não') : '—'}</td>
          <td>{item.inspection ? conditions[item.inspection.condition] : '—'}</td>
        </tr>)}</tbody></table>
      {(missing.length > 0 || detail.unidentified.length > 0) && <>
        <h2>Continuam com o técnico ({missing.length + detail.unidentified.length})</h2>
        <ul>{missing.map((item) => <li key={item.equipment_id} className="mono">{ids(item.identifiers)}</li>)}
          {detail.unidentified.map((entry) => <li key={entry.capture_id}>Foto sem identificação de {dateTime.format(new Date(entry.captured_at))}{entry.typed_code ? ' · código informado ' + entry.typed_code : ''}</li>)}</ul>
      </>}
      {session.closing_reason && <p><strong>Justificativa:</strong> {session.closing_reason}</p>}
      <p className="muted small-text">Sessão {session.id}</p>
    </div>
  </section>
}
