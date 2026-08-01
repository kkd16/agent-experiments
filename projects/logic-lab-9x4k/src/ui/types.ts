export interface View {
  x: number
  y: number
  scale: number
}

// A selection is either a set of components (one or many) or a single wire.
export type Selection = { kind: 'comp'; ids: string[] } | { kind: 'wire'; id: string } | null

/** Component ids in the current selection, or an empty array. */
export function selectedComps(sel: Selection): string[] {
  return sel?.kind === 'comp' ? sel.ids : []
}
