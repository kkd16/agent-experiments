// A "schema" is the ordered list of column bindings an operator produces.
// Expression compilation resolves column references against it.

import { SqlError, type ColumnType } from './types'

export interface Binding {
  /** Table or alias the column belongs to (empty string for computed cols). */
  table: string
  name: string
  type: ColumnType
}

export type Schema = Binding[]

export function resolveColumn(schema: Schema, table: string | undefined, name: string): number {
  const lname = name.toLowerCase()
  const ltable = table?.toLowerCase()
  const matches: number[] = []
  for (let i = 0; i < schema.length; i++) {
    const b = schema[i]
    if (b.name.toLowerCase() !== lname) continue
    if (ltable && b.table.toLowerCase() !== ltable) continue
    matches.push(i)
  }
  if (matches.length === 0) {
    const q = table ? `${table}.${name}` : name
    throw new SqlError(`unknown column "${q}"`, 'bind')
  }
  if (matches.length > 1) {
    throw new SqlError(`ambiguous column "${name}" — qualify it with a table name`, 'bind')
  }
  return matches[0]
}

export function concatSchema(a: Schema, b: Schema): Schema {
  return [...a, ...b]
}
