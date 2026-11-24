import type { UserRole } from '../types'
import type { User } from '../db'

export type DesktopModule =
  | 'dashboard'
  | 'receiving'
  | 'batches'
  | 'catalog'
  | 'triage'
  | 'discrepancies'
  | 'inventory_warehouse'
  | 'reports'
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
  const role = (user.role ?? 'warehouse_clerk') as UserRole
  const isAdminOrSuper = role === 'administrator' || role === 'supervisor' || role === 'platform_admin'

  const menuItems: { id: DesktopModule; label: string; icon: string; adminOnly?: boolean }[] = [
    { id: 'dashboard', label: 'Visão Geral', icon: '📊' },
    { id: 'receiving', label: 'Mesa de Recebimento', icon: '⚡' },
    { id: 'batches', label: 'Lotes e Entregas', icon: '📋' },
    { id: 'catalog', label: 'Catálogo & Rastreamento', icon: '🔍' },
    { id: 'triage', label: 'Triagem e Destinação', icon: '🔬' },
    { id: 'discrepancies', label: 'Divergências e Exceções', icon: '⚠️' },
    { id: 'inventory_warehouse', label: 'Estoque & Transferências', icon: '🏢' },
    { id: 'reports', label: 'Relatórios & Exportação', icon: '📄' },
    { id: 'diagnostics', label: 'Diagnóstico de Leitor', icon: '🎯' },
    { id: 'review', label: 'Revisão de OCR', icon: '📷', adminOnly: true },
    { id: 'users', label: 'Usuários & Permissões', icon: '👥', adminOnly: true },
    { id: 'onboarding', label: 'Onboarding & Ajuda', icon: '💡' },
  ]

  return (
    <aside className="app-sidebar no-print">
      <div className="sidebar-brand">
        <div className="brand-logo-wrapper">
          <img src="/icons/new-life-logo.png" alt="New Life" className="brand-logo-img" />
        </div>
        <div className="brand-text-block">
          <span className="brand-title">New Life</span>
          <span className="brand-subtitle">Cadeia de Custódia</span>
        </div>
      </div>

      <nav className="sidebar-menu">
        <div className="menu-group-label">Módulos Operacionais</div>
        {menuItems.map((item) => {
          if (item.adminOnly && !isAdminOrSuper) return null
          const isActive = currentModule === item.id
          return (
            <button
              key={item.id}
              className={`sidebar-nav-item ${isActive ? 'active' : ''}`}
              onClick={() => onSelectModule(item.id)}
            >
              <span className="nav-icon">{item.icon}</span>
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
