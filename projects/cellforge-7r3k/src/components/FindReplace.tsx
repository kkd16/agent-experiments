import { useEffect, useMemo, useRef, useState } from 'react'
import type { Coord } from '../engine/address'
import { coordToA1 } from '../engine/address'
import type { Workbook } from '../engine/workbook'

interface Props {
  wb: Workbook
  sheetId: string
  version: number
  onGoto: (coord: Coord) => void
  applyReplacements: (entries: Array<{ coord: Coord; raw: string }>) => void
  onClose: () => void
}

interface Match {
  coord: Coord
}

/** Ctrl+F find & replace over the active sheet — searches raw inputs or values,
 *  navigates matches, and replaces within raw inputs (undoable via the parent). */
export default function FindReplace({ wb, sheetId, version, onGoto, applyReplacements, onClose }: Props) {
  const [find, setFind] = useState('')
  const [replace, setReplace] = useState('')
  const [matchCase, setMatchCase] = useState(false)
  const [useRegex, setUseRegex] = useState(false)
  const [inValues, setInValues] = useState(false)
  const [idx, setIdx] = useState(0)
  const findRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    findRef.current?.focus()
  }, [])

  // A non-global tester (so `.test` never advances `lastIndex`), or 'error' on a bad
  // pattern. Replacement builds its own global regex, leaving this one untouched.
  const tester = useMemo(() => {
    if (find === '' || !useRegex) return null
    try {
      return new RegExp(find, matchCase ? '' : 'i')
    } catch {
      return 'error' as const
    }
  }, [find, useRegex, matchCase])

  const matches = useMemo<Match[]>(() => {
    if (find === '' || tester === 'error') return []
    const out: Match[] = []
    const needle = matchCase ? find : find.toLowerCase()
    for (let r = 0; r < wb.rows; r++) {
      for (let c = 0; c < wb.cols; c++) {
        const coord = { row: r, col: c }
        const hay0 = inValues ? wb.getDisplay(coord, sheetId) : wb.getRaw(coord, sheetId)
        if (hay0 === '') continue
        const hit =
          tester instanceof RegExp ? tester.test(hay0) : (matchCase ? hay0 : hay0.toLowerCase()).includes(needle)
        if (hit) out.push({ coord })
      }
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [find, matchCase, useRegex, inValues, version, sheetId, tester])

  useEffect(() => {
    if (matches.length === 0) return
    const safe = idx % matches.length
    onGoto(matches[safe].coord)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idx, matches])

  const go = (delta: number) => {
    if (matches.length === 0) return
    setIdx((i) => (i + delta + matches.length) % matches.length)
  }

  const replaceOne = (raw: string): string => {
    if (useRegex) {
      try {
        return raw.replace(new RegExp(find, matchCase ? 'g' : 'gi'), replace)
      } catch {
        return raw
      }
    }
    if (matchCase) return raw.split(find).join(replace)
    const re = new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
    return raw.replace(re, replace)
  }

  const doReplace = () => {
    if (inValues || matches.length === 0) return
    const m = matches[idx % matches.length]
    const raw = wb.getRaw(m.coord, sheetId)
    applyReplacements([{ coord: m.coord, raw: replaceOne(raw) }])
  }

  const doReplaceAll = () => {
    if (inValues || matches.length === 0) return
    const entries = matches.map((m) => ({ coord: m.coord, raw: replaceOne(wb.getRaw(m.coord, sheetId)) }))
    applyReplacements(entries)
  }

  const count = matches.length
  const pos = count ? (idx % count) + 1 : 0
  const current = count ? coordToA1(matches[idx % count].coord.row, matches[idx % count].coord.col) : ''

  return (
    <div className="find-panel">
      <div className="find-row">
        <input
          ref={findRef}
          className="find-in mono"
          placeholder="Find"
          value={find}
          onChange={(e) => {
            setFind(e.target.value)
            setIdx(0)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') go(e.shiftKey ? -1 : 1)
            else if (e.key === 'Escape') onClose()
          }}
          spellCheck={false}
        />
        <span className="find-count">
          {tester === 'error' ? 'bad regex' : count ? `${pos}/${count} · ${current}` : 'no matches'}
        </span>
        <button className="find-btn" title="Previous (Shift+Enter)" onClick={() => go(-1)}>
          ↑
        </button>
        <button className="find-btn" title="Next (Enter)" onClick={() => go(1)}>
          ↓
        </button>
        <button className="find-btn" title="Close (Esc)" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="find-row">
        <input
          className="find-in mono"
          placeholder="Replace with"
          value={replace}
          onChange={(e) => setReplace(e.target.value)}
          disabled={inValues}
          spellCheck={false}
        />
        <button className="find-btn wide" onClick={doReplace} disabled={inValues || count === 0}>
          Replace
        </button>
        <button className="find-btn wide" onClick={doReplaceAll} disabled={inValues || count === 0}>
          All
        </button>
      </div>
      <div className="find-opts">
        <label>
          <input type="checkbox" checked={matchCase} onChange={(e) => setMatchCase(e.target.checked)} /> Case
        </label>
        <label>
          <input type="checkbox" checked={useRegex} onChange={(e) => setUseRegex(e.target.checked)} /> Regex
        </label>
        <label title="Search computed values instead of formulas (replace disabled)">
          <input type="checkbox" checked={inValues} onChange={(e) => setInValues(e.target.checked)} /> In values
        </label>
      </div>
    </div>
  )
}
