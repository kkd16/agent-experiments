import { useRef, useState } from 'react'
import { settingsActions, useAppState, workspaceActions } from '../store/store'
import { CURRENCIES, clampNumber } from '../lib/format'
import { Button, Card, Field, Modal, PageHeader } from '../components/ui'
import { Icon } from '../components/Icon'

const ACCENTS = ['#4f46e5', '#0ea5e9', '#059669', '#db2777', '#ea580c', '#7c3aed', '#0d9488']

export function Settings() {
  const { settings } = useAppState()
  const co = settings.company
  const fileRef = useRef<HTMLInputElement>(null)
  const importRef = useRef<HTMLInputElement>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [importMsg, setImportMsg] = useState<string | null>(null)

  function onLogo(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => settingsActions.patchCompany({ logo: String(reader.result) })
    reader.readAsDataURL(file)
  }

  function exportData() {
    const blob = new Blob([workspaceActions.exportJSON()], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `solo-workspace-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  }

  function onImport(file: File | undefined) {
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => {
      const ok = workspaceActions.importJSON(String(reader.result))
      setImportMsg(ok ? 'Workspace imported successfully.' : 'That file could not be imported.')
      setTimeout(() => setImportMsg(null), 4000)
    }
    reader.readAsText(file)
  }

  return (
    <div className="page">
      <PageHeader title="Settings" subtitle="Your company details, branding, and data." />

      <div className="dash-grid">
        <Card>
          <div className="card-head">
            <h3>Company profile</h3>
          </div>
          <p className="muted small">This appears on every invoice you generate.</p>
          <div className="logo-row">
            {co.logo ? (
              <img src={co.logo} alt="logo" className="logo-preview" />
            ) : (
              <div className="logo-preview placeholder">
                <Icon name="logo" size={24} />
              </div>
            )}
            <div className="logo-actions">
              <input
                ref={fileRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => onLogo(e.target.files?.[0])}
              />
              <Button icon="upload" onClick={() => fileRef.current?.click()}>
                Upload logo
              </Button>
              {co.logo && (
                <Button variant="ghost" onClick={() => settingsActions.patchCompany({ logo: '' })}>
                  Remove
                </Button>
              )}
            </div>
          </div>
          <div className="form-grid">
            <Field label="Company name">
              <input
                value={co.name}
                onChange={(e) => settingsActions.patchCompany({ name: e.target.value })}
              />
            </Field>
            <Field label="Email">
              <input
                value={co.email}
                onChange={(e) => settingsActions.patchCompany({ email: e.target.value })}
              />
            </Field>
            <Field label="Phone">
              <input
                value={co.phone}
                onChange={(e) => settingsActions.patchCompany({ phone: e.target.value })}
              />
            </Field>
            <Field label="Website">
              <input
                value={co.website}
                onChange={(e) => settingsActions.patchCompany({ website: e.target.value })}
              />
            </Field>
            <Field label="Address">
              <textarea
                rows={2}
                value={co.address}
                onChange={(e) => settingsActions.patchCompany({ address: e.target.value })}
              />
            </Field>
          </div>
        </Card>

        <div className="settings-col">
          <Card>
            <div className="card-head">
              <h3>Invoicing defaults</h3>
            </div>
            <div className="form-grid">
              <Field label="Base currency">
                <select
                  value={settings.currency}
                  onChange={(e) => settingsActions.patch({ currency: e.target.value })}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="Default tax rate (%)">
                <input
                  type="number"
                  value={settings.taxRate}
                  onChange={(e) => settingsActions.patch({ taxRate: clampNumber(e.target.value) })}
                />
              </Field>
              <Field label="Invoice number prefix">
                <input
                  value={settings.invoicePrefix}
                  onChange={(e) => settingsActions.patch({ invoicePrefix: e.target.value })}
                />
              </Field>
              <Field label="Estimate number prefix">
                <input
                  value={settings.estimatePrefix}
                  onChange={(e) => settingsActions.patch({ estimatePrefix: e.target.value })}
                />
              </Field>
              <Field label="Default pay-online link" hint="Pre-filled onto new invoices.">
                <input
                  value={settings.paymentLink}
                  placeholder="https://buy.stripe.com/…"
                  onChange={(e) => settingsActions.patch({ paymentLink: e.target.value })}
                />
              </Field>
            </div>
          </Card>

          <Card>
            <div className="card-head">
              <h3>Appearance</h3>
            </div>
            <Field label="Theme">
              <div className="seg">
                <button
                  className={`seg-btn ${settings.theme === 'light' ? 'active' : ''}`}
                  onClick={() => settingsActions.patch({ theme: 'light' })}
                >
                  Light
                </button>
                <button
                  className={`seg-btn ${settings.theme === 'dark' ? 'active' : ''}`}
                  onClick={() => settingsActions.patch({ theme: 'dark' })}
                >
                  Dark
                </button>
              </div>
            </Field>
            <Field label="Accent color">
              <div className="swatches">
                {ACCENTS.map((a) => (
                  <button
                    key={a}
                    className={`swatch ${settings.accent === a ? 'active' : ''}`}
                    style={{ background: a }}
                    onClick={() => settingsActions.patch({ accent: a })}
                    aria-label={`Accent ${a}`}
                  />
                ))}
              </div>
            </Field>
          </Card>
        </div>
      </div>

      <Card>
        <div className="card-head">
          <h3>Your data</h3>
        </div>
        <p className="muted small">
          Solo stores everything locally in this browser — nothing is sent to a server. Export a
          backup or move your workspace to another device.
        </p>
        {importMsg && <div className="notice">{importMsg}</div>}
        <div className="data-actions">
          <Button icon="download" onClick={exportData}>
            Export workspace (JSON)
          </Button>
          <input
            ref={importRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => onImport(e.target.files?.[0])}
          />
          <Button icon="upload" onClick={() => importRef.current?.click()}>
            Import workspace
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setResetOpen(true)}>
            Reset to demo data
          </Button>
        </div>
      </Card>

      <p className="footnote">
        Solo — Freelance Business OS · Local-first &amp; private · Built with React + Vite
      </p>

      <Modal
        open={resetOpen}
        onClose={() => setResetOpen(false)}
        title="Reset workspace?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setResetOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => {
                workspaceActions.reset()
                setResetOpen(false)
              }}
            >
              Reset everything
            </Button>
          </>
        }
      >
        <p>
          This replaces all your current clients, invoices, time, and expenses with the original
          demo data. Export a backup first if you want to keep your work.
        </p>
      </Modal>
    </div>
  )
}
