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
import { Estimates } from './pages/Estimates'
import { EstimateEditor } from './pages/EstimateEditor'
import { EstimatePrint } from './pages/EstimatePrint'
import { Time } from './pages/Time'
import { Expenses } from './pages/Expenses'
import { Reports } from './pages/Reports'
import { Settings } from './pages/Settings'

function Router({ path }: { path: string }) {
  const printMatch = match('/invoices/:id/print', path)
  if (printMatch) return <InvoicePrint id={printMatch.id} />

  const estPrintMatch = match('/estimates/:id/print', path)
  if (estPrintMatch) return <EstimatePrint id={estPrintMatch.id} />

  const editMatch = match('/invoices/:id', path)
  if (editMatch) return <InvoiceEditor id={editMatch.id} />

  const estEditMatch = match('/estimates/:id', path)
  if (estEditMatch) return <EstimateEditor id={estEditMatch.id} />

  switch (path) {
    case '/':
      return <Dashboard />
    case '/clients':
      return <Clients />
    case '/invoices':
      return <Invoices />
    case '/estimates':
      return <Estimates />
    case '/time':
      return <Time />
    case '/expenses':
      return <Expenses />
    case '/reports':
      return <Reports />
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

  // Print views are standalone full-bleed documents (no app chrome).
  const isPrint =
    !!match('/invoices/:id/print', path) || !!match('/estimates/:id/print', path)
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
