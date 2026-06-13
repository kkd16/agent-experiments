// Domain model for Solo — the entire app state is plain serializable data so it can be
// persisted to localStorage and exported/imported as JSON with no transformation.

export type ID = string

export type InvoiceStatus = 'draft' | 'sent' | 'paid' | 'overdue'

export type RecurInterval = 'none' | 'weekly' | 'monthly'

export interface Client {
  id: ID
  name: string
  company: string
  email: string
  phone: string
  address: string
  /** Default hourly rate used to pre-fill time entries for this client. */
  rate: number
  currency: string
  notes: string
  createdAt: string // ISO date
}

export interface InvoiceItem {
  id: ID
  description: string
  quantity: number
  unitPrice: number
}

export interface Invoice {
  id: ID
  number: string
  clientId: ID | null
  status: InvoiceStatus
  issueDate: string // YYYY-MM-DD
  dueDate: string // YYYY-MM-DD
  items: InvoiceItem[]
  /** Percentage, e.g. 8.5 means 8.5%. */
  taxRate: number
  /** Flat discount in currency units applied before tax. */
  discount: number
  currency: string
  notes: string
  /** Optional "pay online" URL (Stripe/PayPal/bank link) surfaced on the invoice. */
  paymentLink: string
  /** If not 'none', this invoice is a template that spawns copies on a schedule. */
  recurring: RecurInterval
  /** Next date (YYYY-MM-DD) this recurring template should generate a copy, else null. */
  nextRun: string | null
  /** ISO timestamp the invoice was marked paid, if it has been. */
  paidAt: string | null
  createdAt: string
}

export interface TimeEntry {
  id: ID
  clientId: ID | null
  project: string
  description: string
  date: string // YYYY-MM-DD
  /** Duration in seconds. */
  seconds: number
  rate: number
  billable: boolean
  /** When billed, the id of the invoice that absorbed this entry. */
  invoicedIn: ID | null
}

export type ExpenseCategory =
  | 'Software'
  | 'Hardware'
  | 'Travel'
  | 'Meals'
  | 'Marketing'
  | 'Office'
  | 'Fees'
  | 'Other'

export interface Expense {
  id: ID
  date: string // YYYY-MM-DD
  vendor: string
  category: ExpenseCategory
  amount: number
  clientId: ID | null
  billable: boolean
  notes: string
}

export interface CompanyProfile {
  name: string
  email: string
  phone: string
  website: string
  address: string
  /** Base64 data URL of an uploaded logo, or empty. */
  logo: string
}

export interface Settings {
  company: CompanyProfile
  currency: string
  /** Default tax rate (%) applied to new invoices. */
  taxRate: number
  invoicePrefix: string
  /** Default "pay online" URL pre-filled onto new invoices (optional). */
  paymentLink: string
  accent: string
  theme: 'light' | 'dark'
  /** Monotonic counter used to mint sequential invoice numbers. */
  invoiceSeq: number
}

export interface AppState {
  version: number
  clients: Client[]
  invoices: Invoice[]
  time: TimeEntry[]
  expenses: Expense[]
  settings: Settings
}
