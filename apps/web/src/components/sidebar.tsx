import { useState } from 'react'
import { Icon, type IconName } from './icon'
import type { User } from '../db'

export type DesktopModule =
  | 'batches'
  | 'technicians'
  | 'history'
  | 'search'
  | 'review'
  | 'users'
  | 'scanner'
  | 'help'

interface SidebarProps {
  currentModule: DesktopModule
  onSelectModule: (module: DesktopModule) => void
  user: User
  onLogout: () => void
}

const roleNames: Record<string, string> = {
  technician: 'Técnico',
  warehouse_clerk: 'Estoquista',
  administrator: 'Administrador',
}

export function Sidebar({ currentModule, onSelectModule, user, onLogout }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const admin = user.role === 'administrator'
  const groups: { title: string; items: { id: DesktopModule; label: string; icon: IconName }[] }[] = [
    { title: 'Balcão', items: [
      { id: 'batches', label: 'Lotes para conferir', icon: 'scan' },
      { id: 'technicians', label: 'Estoque por técnico', icon: 'users' },
      { id: 'history', label: 'Comprovantes', icon: 'file' },
      { id: 'search', label: 'Rastrear equipamento', icon: 'search' },
    ] },
    ...(admin ? [{ title: 'Administração', items: [
      { id: 'review', label: 'Revisão de fotos', icon: 'camera' },
      { id: 'users', label: 'Usuários e permissões', icon: 'building' },
    ] as { id: DesktopModule; label: string; icon: IconName }[] }] : []),
    { title: 'Suporte', items: [
      { id: 'scanner', label: 'Testar leitor', icon: 'tools' },
      { id: 'help', label: 'Ajuda', icon: 'help' },
    ] },
  ]

  return (
    <aside className="app-sidebar no-print" data-menu-open={menuOpen}>
      <div className="sidebar-brand">
        <img src="/icons/new-life-logo.png" alt="New Life" className="warehouse-wordmark" />
        <span className="warehouse-wordmark-label">Estoque</span>
        <button type="button" className="menu-toggle" aria-controls="warehouse-navigation"
          aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name={menuOpen ? 'close' : 'menu'} /> Menu
        </button>
      </div>

      <nav id="warehouse-navigation" className="sidebar-menu" aria-label="Módulos do estoque">
        {groups.map((group) => <div key={group.title} className="sidebar-group">
          <span className="sidebar-group-title">{group.title}</span>
          {group.items.map((item) => {
            const isActive = currentModule === item.id
            return <button key={item.id} className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => { setMenuOpen(false); onSelectModule(item.id) }}>
              <span className="nav-icon"><Icon name={item.icon} /></span>
              <span className="nav-label">{item.label}</span>
            </button>
          })}
        </div>)}
      </nav>

      <div className="sidebar-footer">
        <div className="user-profile-badge">
          <div className="user-avatar">{user.name.charAt(0).toUpperCase()}</div>
          <div className="user-text">
            <strong>{user.name}</strong>
            <span className="user-role-label">{roleNames[user.role ?? ''] ?? user.role}</span>
          </div>
        </div>
        <button className="sidebar-logout-btn" onClick={onLogout} title="Sair">Sair</button>
      </div>
    </aside>
  )
}
