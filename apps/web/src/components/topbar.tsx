import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Icon } from './icon'

export type CityChoice = { id: string; name: string }

export function Topbar({ connected, onQuickSearch, city, cities, onCity }: {
  connected: boolean
  onQuickSearch?: (query: string) => void
  city?: CityChoice
  /** Presente apenas para quem pode trocar de cidade (administrador). */
  cities?: CityChoice[]
  onCity?: (id: string) => void
}) {
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
            <input ref={input} type="search" maxLength={128} aria-label="Buscar serial, MAC ou ICCID"
              placeholder="Buscar serial, MAC ou ICCID do chip" value={search}
              onChange={event => setSearch(event.target.value)} className="global-search-input" />
          </form>
        </div>
      )}
      {city && <div className="city-switch">
        <Icon name="pin" />
        {cities && onCity
          ? <select aria-label="Cidade em operação" value={city.id} onChange={(event) => onCity(event.target.value)}>
            {cities.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
          : <strong>{city.name}</strong>}
      </div>}
      <div className="connectivity-badge" data-online={connected}>
        <span className="pulse-dot" />
        <span>{connected ? 'Conectado' : 'Sem conexão'}</span>
      </div>
    </header>
  )
}
