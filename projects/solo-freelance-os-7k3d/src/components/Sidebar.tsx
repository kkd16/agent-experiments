// App navigation rail. Collapses to a top bar on narrow screens via CSS.

import { Icon } from './Icon'
import type { IconName } from './Icon'
import { navigate } from '../lib/router'
import { settingsActions, useAppState } from '../store/store'

const NAV: { path: string; label: string; icon: IconName }[] = [
  { path: '/', label: 'Dashboard', icon: 'dashboard' },
  { path: '/invoices', label: 'Invoices', icon: 'invoices' },
  { path: '/clients', label: 'Clients', icon: 'clients' },
  { path: '/time', label: 'Time', icon: 'time' },
  { path: '/expenses', label: 'Expenses', icon: 'expenses' },
  { path: '/settings', label: 'Settings', icon: 'settings' },
]

function isActive(navPath: string, current: string): boolean {
  if (navPath === '/') return current === '/'
  return current === navPath || current.startsWith(navPath + '/')
}

export function Sidebar({ path }: { path: string }) {
  const { settings } = useAppState()
  return (
    <aside className="sidebar">
      <div className="brand" onClick={() => navigate('/')}>
        <div className="brand-mark">
          <Icon name="logo" size={20} />
        </div>
        <div className="brand-text">
          <strong>Solo</strong>
          <span>Business OS</span>
        </div>
      </div>

      <nav className="nav">
        {NAV.map((item) => (
          <button
            key={item.path}
            className={`nav-item ${isActive(item.path, path) ? 'active' : ''}`}
            onClick={() => navigate(item.path)}
          >
            <Icon name={item.icon} size={18} />
            <span>{item.label}</span>
          </button>
        ))}
      </nav>

      <div className="sidebar-foot">
        <button className="nav-item theme-toggle" onClick={() => settingsActions.toggleTheme()}>
          <Icon name={settings.theme === 'light' ? 'moon' : 'sun'} size={18} />
          <span>{settings.theme === 'light' ? 'Dark mode' : 'Light mode'}</span>
        </button>
        <div className="sidebar-company">
          {settings.company.logo ? (
            <img src={settings.company.logo} alt="" className="company-logo" />
          ) : (
            <div className="company-logo placeholder">
              {(settings.company.name || 'S').slice(0, 1)}
            </div>
          )}
          <div className="company-meta">
            <strong>{settings.company.name || 'Your company'}</strong>
            <span>{settings.company.email || 'Set up in Settings'}</span>
          </div>
        </div>
      </div>
    </aside>
  )
}
