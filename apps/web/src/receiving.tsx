import { useCallback, useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ApiError, warehouse } from './api'
import type { User } from './db'

type Session = {
  id: string; technician_id: string; technician_name: string; warehouse_id: string
  warehouse_name: string; opened_at: string; closed_at: string | null; closing_reason: string | null
}
type Identifier = { kind: string; raw_value: string }
type Item = { equipment_id: string; matched_scan_id: string | null; confirmed_at: string | null; identifiers: Identifier[] }
type Scan = {
  id: string; equipment_id: string | null; result: string; value: string
  secondary_value: string | null; created_at: string
}
type Totals = { expected: number; confirmed: number; missing: number; duplicates: number; divergences: number }
type Detail = { session: Session; totals: Totals; items: Item[]; scans: Scan[]; next_item: string | null; next_scan: string | null }
type Page<T> = { items: T[]; next_cursor: string | null }
type Technician = { id: string; name: string; login: string }

const dateTime = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' })
const outcomes: Record<string, string> = {
  MATCHED: 'Equipamento localizado',
  DUPLICATE_SCAN: 'Leitura duplicada nesta sessão',
  UNKNOWN: 'Código desconhecido',
  AMBIGUOUS: 'Código associado a mais de um equipamento',
  OTHER_TECHNICIAN: 'Equipamento de outro técnico',
  ALREADY_RECEIVED: 'Equipamento já recebido',
  NOT_IN_SESSION: 'Equipamento fora da lista desta sessão',
  IDENTIFIER_MISMATCH: 'Os dois códigos não correspondem ao mesmo equipamento',
}
const kinds: Record<string, string> = { SERIAL: 'Serial', MAC: 'MAC', BARCODE: 'Código' }

function jsonPost(body: object): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
}

export function ReceivingDesk({ clerk, denied, exit }: { clerk: User; denied: () => void; exit: () => Promise<void> }) {
  const [sessions, setSessions] = useState<Page<Session>>()
  const [technicians, setTechnicians] = useState<Page<Technician>>()
  const [search, setSearch] = useState('')
  const [searched, setSearched] = useState('')
  const [selected, setSelected] = useState<string>()
  const [technician, setTechnician] = useState('')
  const [opening, setOpening] = useState(false)
  const [findingTechnicians, setFindingTechnicians] = useState(false)
  const [findingSessions, setFindingSessions] = useState(false)
  const [error, setError] = useState('')
  const pendingOpen = useRef<{ technician_id: string; client_session_id: string } | undefined>(undefined)

  const fail = useCallback((failure: unknown) => {
    if (failure instanceof ApiError && (failure.status === 401 || failure.status === 403)) denied()
    return failure instanceof ApiError ? failure.message : 'Não foi possível acessar o servidor. Tente novamente.'
  }, [denied])

  const loadSessions = useCallback(async (after?: string) => {
    setFindingSessions(true)
    try {
      const page = await warehouse<Page<Session>>(clerk.id, '/receipt-sessions' + (after ? '?after=' + after : ''))
      setSessions((previous) => after && previous ? { ...page, items: [...previous.items, ...page.items] } : page)
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setFindingSessions(false)
    }
  }, [clerk.id, fail])

  const loadTechnicians = useCallback(async (query = '', after?: string) => {
    setFindingTechnicians(true)
    try {
      const params = new URLSearchParams({ search: query })
      if (after) params.set('after', after)
      const page = await warehouse<Page<Technician>>(clerk.id, '/receipt-technicians?' + params)
      setTechnicians((previous) => after && previous ? { ...page, items: [...previous.items, ...page.items] } : page)
      setSearched(query)
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setFindingTechnicians(false)
    }
  }, [clerk.id, fail])

  useEffect(() => {
    void loadSessions()
    void loadTechnicians()
  }, [loadSessions, loadTechnicians])

  async function open(event: FormEvent) {
    event.preventDefault()
    if (!technician || opening) return
    setOpening(true)
    setError('')
    if (pendingOpen.current?.technician_id !== technician) {
      pendingOpen.current = { technician_id: technician, client_session_id: crypto.randomUUID() }
    }
    try {
      const session = await warehouse<Session>(clerk.id, '/receipt-sessions', jsonPost(pendingOpen.current))
      pendingOpen.current = undefined
      setSelected(session.id)
      void loadSessions()
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setOpening(false)
    }
  }

  return <>
    <div className="workspace-head">
      <div><p className="eyebrow">Área do estoquista</p><h1>Recebimento de equipamentos</h1><p className="muted">{clerk.name}</p></div>
      <button onClick={() => void exit().catch((failure) => setError(fail(failure)))}>Sair</button>
    </div>
    {error && <p className="alert" role="alert">{error}</p>}
    {selected ? <ReceiptSession key={selected} owner={clerk.id} id={selected} fail={fail}
      back={() => { setSelected(undefined); void loadSessions() }} /> : <>
      <section className="card">
        <h2>Abrir recebimento</h2>
        <form className="receipt-form" onSubmit={(event) => {
          event.preventDefault()
          if (!findingTechnicians) { setTechnician(''); void loadTechnicians(search) }
        }}>
          <label className="review-field">Buscar técnico<input value={search} onChange={(event) => setSearch(event.target.value)} /></label>
          <button disabled={findingTechnicians}>Buscar</button>
        </form>
        <form className="receipt-form" onSubmit={(event) => void open(event)}>
          <label className="review-field">Técnico<select required value={technician} disabled={opening || findingTechnicians}
            onChange={(event) => setTechnician(event.target.value)}>
            <option value="">Selecione o técnico</option>
            {technicians?.items.map((item) => <option value={item.id} key={item.id}>{item.name} ({item.login})</option>)}
          </select></label>
          <button className="primary" disabled={!technician || opening || findingTechnicians}>Abrir sessão</button>
        </form>
        {technicians?.next_cursor && <button disabled={findingTechnicians}
          onClick={() => void loadTechnicians(searched, technicians.next_cursor!)}>Mais técnicos</button>}
      </section>
      <section className="card">
        <div className="section-head"><h2>Minhas sessões</h2>
          <button disabled={findingSessions} onClick={() => void loadSessions()}>Atualizar sessões</button></div>
        {sessions?.items.length === 0 && <p>Nenhuma sessão registrada.</p>}
        {!!sessions?.items.length && <ul className="items">{sessions.items.map((session) => (
          <li key={session.id} className="queue-row">
            <div><strong>{session.technician_name}</strong><br />
              <span className="muted">{session.closed_at ? 'Encerrada' : 'Em aberto'} · {dateTime.format(new Date(session.opened_at))}</span>
            </div>
            <button onClick={() => setSelected(session.id)}>Ver sessão</button>
          </li>
        ))}</ul>}
        {sessions?.next_cursor && <button disabled={findingSessions}
          onClick={() => void loadSessions(sessions.next_cursor!)}>Mais sessões</button>}
      </section>
    </>}
  </>
}

function ReceiptSession({ owner, id, fail, back }: {
  owner: string; id: string; fail: (error: unknown) => string; back: () => void
}) {
  const [detail, setDetail] = useState<Detail>()
  const [item, setItem] = useState<Item>()
  const [lastScan, setLastScan] = useState<Scan>()
  const [value, setValue] = useState('')
  const [secondary, setSecondary] = useState('')
  const [terminator, setTerminator] = useState('Enter')
  const [physical, setPhysical] = useState(false)
  const [closing, setClosing] = useState(false)
  const [reason, setReason] = useState('')
  const [photo, setPhoto] = useState<string>()
  const [notice, setNotice] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const field = useRef<HTMLInputElement>(null)
  const pendingScan = useRef<{ client_scan_id: string; value: string; secondary_value?: string } | undefined>(undefined)
  const path = '/receipt-sessions/' + id

  const load = useCallback(async (cursor?: { type: 'item' | 'scan'; id: string }) => {
    const data = await warehouse<Detail>(owner, path + (cursor ? '?after_' + cursor.type + '=' + cursor.id : ''))
    setDetail((previous) => {
      if (!cursor || !previous) return data
      return cursor.type === 'item'
        ? { ...data, items: [...previous.items, ...data.items], scans: previous.scans, next_scan: previous.next_scan }
        : { ...data, scans: [...previous.scans, ...data.scans], items: previous.items, next_item: previous.next_item }
    })
  }, [owner, path])

  const focusScanner = () => requestAnimationFrame(() => field.current?.focus())
  useEffect(() => { void load().catch((failure) => setError(fail(failure))) }, [fail, load])
  useEffect(() => { if (detail?.session.closed_at === null) focusScanner() }, [detail?.session.closed_at])

  async function perform(operation: () => Promise<void>, focus = false) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
    } catch (failure) {
      setError(fail(failure))
    } finally {
      setBusy(false)
      if (focus) focusScanner()
    }
  }

  async function scan() {
    const code = value.trim()
    const secondCode = secondary.trim() || undefined
    if (!code) return
    await perform(async () => {
      setNotice('')
      if (pendingScan.current?.value !== code || pendingScan.current.secondary_value !== secondCode) {
        pendingScan.current = { value: code, secondary_value: secondCode, client_scan_id: crypto.randomUUID() }
      }
      const result = await warehouse<Scan>(owner, path + '/scan', jsonPost(pendingScan.current))
      pendingScan.current = undefined
      setLastScan(result)
      setValue('')
      setSecondary('')
      setItem(undefined)
      setPhysical(false)
      setPhoto(undefined)
      if (result.equipment_id && (result.result === 'MATCHED' || result.result === 'DUPLICATE_SCAN')) {
        setItem(await warehouse<Item>(owner, path + '/items/' + result.equipment_id))
      }
      await load()
    }, true)
  }

  function suffix(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === terminator && !event.shiftKey && value.trim()) {
      event.preventDefault()
      void scan()
    }
  }

  async function confirm() {
    if (!physical || !item?.matched_scan_id || item.confirmed_at) return
    await perform(async () => {
      await warehouse(owner, path + '/confirm', jsonPost({
        equipment_id: item.equipment_id, scan_id: item.matched_scan_id,
      }))
      setNotice('Recebimento confirmado. A custódia foi transferida ao depósito.')
      setItem(undefined)
      setPhysical(false)
      setPhoto(undefined)
      setLastScan(undefined)
      await load()
    }, true)
  }

  function inspect(entry: Item) {
    setItem(entry)
    setPhysical(false)
    setPhoto(undefined)
    setNotice('')
  }

  if (!detail) return <section className="card">
    {error ? <p className="alert" role="alert">{error}</p> : <p role="status">Consultando sessão…</p>}
    <button onClick={back}>Voltar às sessões</button>
  </section>

  const { session, totals } = detail
  const open = !session.closed_at
  const hasIssues = totals.missing > 0 || totals.divergences > 0
  return <>
    <section className="card">
      <div className="section-head review-filters">
        <div><h2>{session.technician_name}</h2><p className="muted">{session.warehouse_name} · {open ? 'Sessão aberta' : 'Sessão encerrada'}</p></div>
        <button onClick={back} disabled={busy}>Voltar às sessões</button>
      </div>
      {session.closing_reason && <p>Justificativa do encerramento: {session.closing_reason}</p>}
      <dl className="receipt-totals">
        {([['Previstos', totals.expected], ['Confirmados', totals.confirmed], ['Faltantes', totals.missing],
          ['Duplicados', totals.duplicates], ['Divergências', totals.divergences]] as const).map(([label, count]) => (
          <div key={label}><dt>{label}</dt><dd>{count}</dd></div>
        ))}
      </dl>
      {error && <p role="alert" className="alert">{error}</p>}
      {notice && <p role="status" className="success">{notice}</p>}
    </section>
    {open && <section className="card">
      <h2>Ler etiqueta</h2>
      <form className="receipt-form" onSubmit={(event) => { event.preventDefault(); void scan() }}>
        <label className="review-field">Código lido<input ref={field} name="scan" value={value} onKeyDown={suffix}
          onChange={(event) => setValue(event.target.value)} autoComplete="off" autoCapitalize="none"
          spellCheck={false} maxLength={128} disabled={busy} required /></label>
        <label className="review-field">Segundo código (opcional)<input value={secondary} onKeyDown={suffix}
          onChange={(event) => setSecondary(event.target.value)} autoComplete="off" spellCheck={false}
          maxLength={128} disabled={busy} /></label>
        <label className="review-field">Sufixo do scanner<select value={terminator} disabled={busy}
          onChange={(event) => setTerminator(event.target.value)}>
          <option value="Enter">Enter</option><option value="Tab">Tab</option>
        </select></label>
        <button className="primary" disabled={!value.trim() || busy}>Buscar código</button>
      </form>
      {lastScan && <p role="status" className={lastScan.result === 'MATCHED' ? 'success' : 'alert'}>{outcomes[lastScan.result]}</p>}
    </section>}
    {item && <section className="card">
      <div className="section-head"><h2>Conferir equipamento</h2>
        <button disabled={busy} onClick={() => { setItem(undefined); focusScanner() }}>Fechar conferência</button></div>
      <ul className="receipt-identifiers">{item.identifiers.map((entry) =>
        <li key={entry.kind + entry.raw_value}>{kinds[entry.kind]}: {entry.raw_value}</li>)}</ul>
      <div className="actions">
        <button disabled={busy} onClick={() => void perform(async () => {
          const evidence = await warehouse<{ url: string }>(owner, path + '/items/' + item.equipment_id + '/image-url')
          setPhoto(evidence.url)
        })}>Ver foto da etiqueta</button>
      </div>
      {photo && <img src={photo} className="review-photo" alt="Foto da etiqueta na coleta" referrerPolicy="no-referrer"
        onError={() => { setError('A foto está indisponível. Tente abrir novamente.'); setPhoto(undefined) }} />}
      {open && !item.confirmed_at && <>
        <label className="review-confirm"><input type="checkbox" checked={physical} disabled={busy}
          onChange={(event) => setPhysical(event.target.checked)} /> Conferi a etiqueta e recebi o equipamento fisicamente.</label>
        <button className="primary" disabled={busy || !physical} onClick={() => void confirm()}>Confirmar recebimento físico</button>
      </>}
    </section>}
    <section className="card">
      <h2>Equipamentos previstos</h2>
      {detail.items.length === 0 && <p>Nenhum equipamento em custódia na abertura desta sessão.</p>}
      {!!detail.items.length && <ul className="items">{detail.items.map((entry) => <li key={entry.equipment_id} className="queue-row">
        <div><strong>{entry.confirmed_at ? 'Confirmado' : entry.matched_scan_id ? 'Localizado · falta confirmar' : 'Faltante'}</strong>
          <ul className="receipt-identifiers">{entry.identifiers.map((identifier) =>
            <li key={identifier.kind + identifier.raw_value}>{kinds[identifier.kind]}: {identifier.raw_value}</li>)}</ul></div>
        {entry.matched_scan_id && <button onClick={() => inspect(entry)} disabled={busy}>
          {entry.confirmed_at || !open ? 'Ver item' : 'Conferir item'}
        </button>}
      </li>)}</ul>}
      {detail.next_item && <button disabled={busy}
        onClick={() => void perform(() => load({ type: 'item', id: detail.next_item! }))}>Mais equipamentos</button>}
    </section>
    <section className="card">
      <h2>Histórico de leituras</h2>
      {detail.scans.length === 0 && <p>Nenhuma leitura registrada.</p>}
      {!!detail.scans.length && <ul className="items">{detail.scans.map((entry) => <li key={entry.id} className="queue-row">
        <div><strong>{outcomes[entry.result]}</strong><br />
          <span>{entry.value}{entry.secondary_value ? ' / ' + entry.secondary_value : ''}</span></div>
        <time dateTime={entry.created_at}>{dateTime.format(new Date(entry.created_at))}</time>
      </li>)}</ul>}
      {detail.next_scan && <button disabled={busy}
        onClick={() => void perform(() => load({ type: 'scan', id: detail.next_scan! }))}>Mais leituras</button>}
    </section>
    {open && <section className="card">
      <h2>Encerrar recebimento</h2>
      {closing ? <form className="receipt-close" onSubmit={(event) => {
        event.preventDefault()
        void perform(async () => {
          await warehouse(owner, path + '/close', jsonPost({ reason: reason.trim() || null }))
          setItem(undefined)
          setClosing(false)
          await load()
        })
      }}>
        {hasIssues && <p className="alert">Faltantes e divergências permanecerão no relatório da sessão.</p>}
        <label className="review-field">Justificativa {hasIssues ? '(obrigatória)' : '(opcional)'}
          <textarea maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} required={hasIssues} />
        </label>
        <div className="actions">
          <button type="button" disabled={busy} onClick={() => setClosing(false)}>Cancelar</button>
          <button className="primary" disabled={busy || (hasIssues && !reason.trim())}>Confirmar encerramento</button>
        </div>
      </form> : <button onClick={() => setClosing(true)} disabled={busy}>Encerrar sessão</button>}
    </section>}
  </>
}
