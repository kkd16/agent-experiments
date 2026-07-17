import { BOOKMARKS } from '../fractal/bookmarks'
import type { Bookmark } from '../fractal/types'

export default function BookmarkBar({
  onPick,
  inset,
}: {
  onPick: (b: Bookmark) => void
  inset: boolean
}) {
  return (
    <div className={inset ? 'bookmarks inset' : 'bookmarks'}>
      {BOOKMARKS.map((b) => (
        <button key={b.name} className="chip" title={b.blurb} onClick={() => onPick(b)}>
          {b.name}
        </button>
      ))}
    </div>
  )
}
