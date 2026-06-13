import { useEffect } from 'react'
import './App.css'
import { applyTheme, useAppState } from './store/store'
import { match, useRoute } from './lib/router'
import { Sidebar } from './components/Sidebar'
import { Dashboard } from './pages/Dashboard'
import { Clients } from './pages/Clients'
import { Invoices } from './pages/Invoices'
import { InvoiceEditor } from './pages/InvoiceEditor'
import { InvoicePrint } from './pages/InvoicePrint'
import { Time } from './pages/Time'
import { Expenses } from './pages/Expenses'
import { Settings } from './pages/Settings'

function Router({ path }: { path: string }) {
  const printMatch = match('/invoices/:id/print', path)
  if (printMatch) return <InvoicePrint id={printMatch.id} />

  const editMatch = match('/invoices/:id', path)
  if (editMatch) return <InvoiceEditor id={editMatch.id} />

  switch (path) {
    case '/':
      return <Dashboard />
    case '/clients':
      return <Clients />
    case '/invoices':
      return <Invoices />
    case '/time':
      return <Time />
    case '/expenses':
      return <Expenses />
    case '/settings':
      return <Settings />
    default:
      return <Dashboard />
  }
}

export default function App() {
  const { settings } = useAppState()
  const path = useRoute()

  // Apply theme + accent whenever they change.
  useEffect(() => {
    applyTheme(settings)
  }, [settings])

  // The print view is a standalone full-bleed document (no app chrome).
  const isPrint = !!match('/invoices/:id/print', path)
  if (isPrint) {
    return <Router path={path} />
  }

  return (
    <div className="shell">
      <Sidebar path={path} />
      <main className="content">
        <Router path={path} />
      </main>
    </div>
  )
}
