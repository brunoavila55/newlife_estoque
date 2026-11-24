import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './icon'

export function Topbar({ connected, onQuickSearch }: { connected: boolean; onQuickSearch?: (query: string) => void }) {
  const [search, setSearch] = useState('')
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!onQuickSearch) return
    function focusSearch(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === 'k') {
        event.preventDefault()
        input.current?.focus()
      }
    }
    window.addEventListener('keydown', focusSearch)
    return () => window.removeEventListener('keydown', focusSearch)
  }, [onQuickSearch])

  function submit(event: FormEvent) {
    event.preventDefault()
    if (search.trim()) onQuickSearch?.(search.trim())
  }

  return (
    <header className="topbar-desktop no-print">
      {onQuickSearch && (
        <div className="topbar-search-area">
          <form onSubmit={submit} className="global-search-form">
            <Icon name="search" />
            <input ref={input} type="search" maxLength={128} aria-label="Buscar por serial ou MAC"
              placeholder="Buscar por serial ou MAC" value={search}
              onChange={event => setSearch(event.target.value)} className="global-search-input" />
          </form>
        </div>
      )}
      <div className="connectivity-badge" data-online={connected}>
        <span className="pulse-dot" />
        <span>{connected ? 'Conectado' : 'Sem conexão'}</span>
      </div>
    </header>
  )
}
