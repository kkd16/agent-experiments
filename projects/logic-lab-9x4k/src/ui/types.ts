export interface View {
  x: number
  y: number
  scale: number
}

export type Selection = { kind: 'comp'; id: string } | { kind: 'wire'; id: string } | null
