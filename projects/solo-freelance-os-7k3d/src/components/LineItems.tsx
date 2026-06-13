// Shared editable line-items table used by both the invoice and estimate editors.

import type { InvoiceItem } from '../types'
import { clampNumber, money } from '../lib/format'
import { itemTotal } from '../lib/finance'
import { Button, IconButton } from './ui'

export function LineItems({
  items,
  currency,
  onPatch,
  onRemove,
  onAdd,
}: {
  items: InvoiceItem[]
  currency: string
  onPatch: (itemId: string, patch: Partial<InvoiceItem>) => void
  onRemove: (itemId: string) => void
  onAdd: () => void
}) {
  return (
    <>
      <table className="items-table">
        <thead>
          <tr>
            <th>Description</th>
            <th className="num qty">Qty</th>
            <th className="num price">Unit price</th>
            <th className="num">Amount</th>
            <th aria-label="remove" />
          </tr>
        </thead>
        <tbody>
          {items.map((it) => (
            <tr key={it.id}>
              <td>
                <input
                  value={it.description}
                  placeholder="Describe the work…"
                  onChange={(e) => onPatch(it.id, { description: e.target.value })}
                />
              </td>
              <td className="num">
                <input
                  type="number"
                  className="num-input"
                  value={it.quantity}
                  onChange={(e) => onPatch(it.id, { quantity: clampNumber(e.target.value) })}
                />
              </td>
              <td className="num">
                <input
                  type="number"
                  className="num-input"
                  value={it.unitPrice}
                  onChange={(e) => onPatch(it.id, { unitPrice: clampNumber(e.target.value) })}
                />
              </td>
              <td className="num strong">{money(itemTotal(it), currency)}</td>
              <td>
                <IconButton icon="x" label="Remove line" onClick={() => onRemove(it.id)} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Button variant="ghost" icon="plus" onClick={onAdd}>
        Add line item
      </Button>
    </>
  )
}
