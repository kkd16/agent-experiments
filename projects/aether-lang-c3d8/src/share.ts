// One-shot hand-off used when the Examples gallery opens a program in the
// playground. The playground consumes it once on mount.

let pending: string | null = null

export function setPendingCode(code: string): void {
  pending = code
}

export function consumePendingCode(): string | null {
  const c = pending
  pending = null
  return c
}
