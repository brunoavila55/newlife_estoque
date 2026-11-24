import { Icon } from './icon'
import { useState, useRef, useEffect } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { db, type User } from '../db'
import type { DesktopModule } from './sidebar'

interface TopbarProps {
  user: User
  connected: boolean
  onNavigate: (module: DesktopModule) => void
  onQuickSearch: (query: string) => void
  isMobilePreview?: boolean
  onToggleMobilePreview?: () => void
}

export function Topbar({
  user,
  connected,
  onNavigate,
  onQuickSearch,
  isMobilePreview,
  onToggleMobilePreview,
}: TopbarProps) {
  const [searchVal, setSearchVal] = useState('')
  const [showNotifMenu, setShowNotifMenu] = useState(false)
  const [activeWarehouse, setActiveWarehouse] = useState('00000000-0000-4000-8000-000000000001')

  const notifications = useLiveQuery(() => db.notifications.orderBy('created_at').reverse().toArray(), [])
  const locations = useLiveQuery(() => db.locations.toArray(), [])

  const unreadCount = notifications?.filter((n) => !n.read).length || 0
  const searchInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault()
        searchInputRef.current?.focus()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  function handleSearchSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!searchVal.trim()) return
    onQuickSearch(searchVal.trim())
  }

  async function markAllNotificationsRead() {
    if (!notifications) return
    const ids = notifications.filter((n) => !n.read).map((n) => n.id)
    for (const id of ids) {
      await db.notifications.update(id, { read: true })
    }
  }

  return (
    <header className="topbar-desktop no-print">
      <div className="topbar-search-area">
        <form onSubmit={handleSearchSubmit} className="global-search-form">
          <Icon name="search" />
          <input
            ref={searchInputRef}
            type="search"
            aria-label="Buscar por serial, MAC ou lote"
            placeholder="Buscar por serial, MAC ou lote"
            value={searchVal}
            onChange={(e) => setSearchVal(e.target.value)}
            className="global-search-input"
          />
        </form>
      </div>

      <div className="topbar-right-controls">
        {/* Toggle para alternar entre Desktop e Mobile Simulator */}
        {onToggleMobilePreview && (
          <button
            type="button"
            className={`small-btn ${isMobilePreview ? 'primary' : ''}`}
            onClick={onToggleMobilePreview}
            title="Alternar entre visual Desktop e Mobile do Técnico"
          >
            {isMobilePreview ? 'Voltar ao estoque' : 'Prévia do técnico'}
          </button>
        )}

        {/* Seletor de Depósito */}
        <div className="warehouse-selector-box">
          <Icon name="building" />
          <select
            value={activeWarehouse}
            onChange={(e) => setActiveWarehouse(e.target.value)}
            className="warehouse-select"
            aria-label="Depósito"
          >
            {locations && locations.length > 0 ? (
              locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.name}
                </option>
              ))
            ) : (
              <option value="00000000-0000-4000-8000-000000000001">Depósito Piloto - Sala 01</option>
            )}
          </select>
        </div>

        {/* Indicador de Conexão */}
        <div className="connectivity-badge" data-online={connected}>
          <span className="pulse-dot" />
          <span className="conn-text">{connected ? 'Online' : 'Offline'}</span>
        </div>

        {/* Sino de Notificações */}
        <div className="notifications-dropdown-container">
          <button
            className="notif-bell-btn"
            onClick={() => setShowNotifMenu(!showNotifMenu)}
            aria-label="Notificações"
            aria-expanded={showNotifMenu}
          >
            <Icon name="bell" />
            {unreadCount > 0 && <span className="notif-badge">{unreadCount}</span>}
          </button>

          {showNotifMenu && (
            <div className="notif-dropdown-menu card">
              <div className="notif-dropdown-header">
                <strong>Notificações do Sistema</strong>
                {unreadCount > 0 && (
                  <button className="small-link-btn" onClick={() => void markAllNotificationsRead()}>
                    Marcar lidas
                  </button>
                )}
              </div>

              <ul className="notif-list">
                {notifications && notifications.length > 0 ? (
                  notifications.map((n) => (
                    <li
                      key={n.id}
                      className={`notif-item ${n.read ? 'read' : 'unread'}`}
                      onClick={() => {
                        void db.notifications.update(n.id, { read: true })
                        setShowNotifMenu(false)
                        if (n.type === 'BATCH_PRESENTED') onNavigate('batches')
                        else if (n.type === 'DISCREPANCY_ALERT') onNavigate('discrepancies')
                      }}
                    >
                      <strong className="notif-title">{n.title}</strong>
                      <p className="notif-desc">{n.message}</p>
                      <time className="notif-time">{new Date(n.created_at).toLocaleTimeString('pt-BR')}</time>
                    </li>
                  ))
                ) : (
                  <li className="empty-notif">Nenhuma notificação recente.</li>
                )}
              </ul>
            </div>
          )}
        </div>
      </div>
    </header>
  )
}
