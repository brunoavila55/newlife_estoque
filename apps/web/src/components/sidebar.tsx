import { useState } from 'react'
import { Icon, type IconName } from './icon'
import type { UserRole } from '../types'
import type { User } from '../db'

export type DesktopModule =
  | 'dashboard'
  | 'receiving'
  | 'history'
  | 'catalog'
  | 'discrepancies'
  | 'diagnostics'
  | 'review'
  | 'users'
  | 'onboarding'

interface SidebarProps {
  currentModule: DesktopModule
  onSelectModule: (module: DesktopModule) => void
  user: User
  onLogout: () => void
}

const roleNames: Record<UserRole, string> = {
  technician: 'Técnico de Campo',
  warehouse_clerk: 'Estoquista / Conferente',
  supervisor: 'Supervisor Operacional',
  administrator: 'Administrador da Empresa',
  auditor: 'Auditor de Conformidade',
  platform_admin: 'Administrador SaaS',
}

export function Sidebar({ currentModule, onSelectModule, user, onLogout }: SidebarProps) {
  const [menuOpen, setMenuOpen] = useState(false)
  const role = (user.role ?? 'warehouse_clerk') as UserRole
  const admin = role === 'administrator'
  const menuItems: { id: DesktopModule; label: string; icon: IconName }[] = [
    { id: 'dashboard', label: 'Visão geral', icon: 'home' },
    ...(admin ? [
      { id: 'review', label: 'Revisão de OCR', icon: 'camera' },
      { id: 'users', label: 'Usuários e permissões', icon: 'users' },
    ] as const : []),
    { id: 'receiving', label: 'Mesa de recebimento', icon: 'scan' },
    { id: 'history', label: 'Histórico e comprovantes', icon: 'file' },
    { id: 'catalog', label: 'Rastreamento', icon: 'search' },
    { id: 'discrepancies', label: 'Divergências', icon: 'alert' },
    { id: 'diagnostics', label: 'Teste de leitor', icon: 'scan' },
    { id: 'onboarding', label: 'Ajuda', icon: 'help' },
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
        {menuItems.map((item) => {
          const isActive = currentModule === item.id
          return (
            <button
              key={item.id}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              aria-current={isActive ? 'page' : undefined}
              onClick={() => {
                setMenuOpen(false)
                onSelectModule(item.id)
              }}
            >
              <span className="nav-icon"><Icon name={item.icon} /></span>
              <span className="nav-label">{item.label}</span>
            </button>
          )
        })}
      </nav>

      <div className="sidebar-footer">
        <div className="user-profile-badge">
          <div className="user-avatar">{user.name.charAt(0).toUpperCase()}</div>
          <div className="user-text">
            <strong>{user.name}</strong>
            <span className="user-role-label">{roleNames[role] || role}</span>
          </div>
        </div>
        <button className="sidebar-logout-btn" onClick={onLogout} title="Sair do Sistema">
          Sair
        </button>
      </div>
    </aside>
  )
}
