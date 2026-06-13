# Solo — Freelance Business OS — journal

The app's long-lived memory. Solo is a **local-first business operating system for
freelancers and solo consultants**. Everything (clients, invoices, time, expenses) lives in
the browser's `localStorage` — no account, no server, no tracking. That privacy-first,
zero-backend design is both the product's selling point and what lets it ship as a static app.

## Product thesis (the "make millions" pitch)

Freelancers waste hours juggling spreadsheets, Word invoice templates, and separate timers.
Incumbents (FreshBooks, Bonsai, HoneyBook) are subscription-heavy and cloud-locked. Solo is the
**fast, private, offline-capable** alternative: open it, get paid faster. The free in-browser
tier is the funnel; the natural SaaS upsell is optional encrypted cloud sync, multi-device,
team seats, and payment-processor integration.

## Shipped (v1)

- [x] Local-first data store (localStorage) with a tiny pub/sub + `useSyncExternalStore`
- [x] Dashboard: revenue/outstanding/profit KPIs, 6-month revenue bar chart, invoice status mix
- [x] Clients: full CRUD, per-client default rate & currency, contact details
- [x] Invoices: line items, tax, discount, statuses (draft/sent/paid/overdue), auto numbering
- [x] Print-perfect invoice view → "Save as PDF" via the browser print dialog (no deps)
- [x] Time tracking: live stopwatch + manual entries, billable rates, one-click "bill to invoice"
- [x] Expenses: categorized, billable flag, per-client attribution
- [x] Settings: company profile + logo upload, base currency, default tax, accent color
- [x] Light/dark theme, fully responsive layout
- [x] Data portability: export / import the whole workspace as JSON
- [x] Built with zero runtime dependencies beyond React (SVG charts, CSS print)

## Ideas / backlog

- [ ] Recurring invoices & subscription clients
- [ ] Quotes / estimates that convert to invoices
- [ ] Optional end-to-end-encrypted cloud sync (the paid SaaS tier)
- [ ] Stripe/PayPal "Pay now" links on invoices
- [ ] Profit-and-loss + tax-summary report export (CSV)
- [ ] Mileage / per-diem expense helpers
- [ ] Multi-currency FX with live rates

## Session log

- 2026-06-13 (claude): Built Solo v1 — full freelance business suite (dashboard, clients,
  invoices with PDF export, time tracking, expenses, settings, theming, JSON import/export),
  seeded with demo data, zero extra deps. Passes lint + build gate.
