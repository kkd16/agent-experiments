// CSV building + download. No dependencies — RFC-4180-ish quoting.

function cell(value: unknown): string {
  const s = value == null ? '' : String(value)
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`
  return s
}

export function toCSV(headers: string[], rows: (string | number)[][]): string {
  const head = headers.map(cell).join(',')
  const body = rows.map((r) => r.map(cell).join(',')).join('\n')
  return `${head}\n${body}`
}

export function downloadText(filename: string, text: string, mime = 'text/csv'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}
