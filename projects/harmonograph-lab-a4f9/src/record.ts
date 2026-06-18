// WebM capture of the drawing pass. We grab the live canvas as a MediaStream and
// drive the trace from 0→1 in real time while a MediaRecorder collects the
// frames. Everything is feature-detected and wrapped so an unsupported browser
// (or the sandboxed catalog thumbnail) degrades gracefully instead of throwing.

export interface RecordOptions {
  duration: number // seconds of the drawing pass
  fps: number
  hold: number // extra seconds to linger on the finished figure
}

export function canRecord(): boolean {
  try {
    return (
      typeof MediaRecorder !== 'undefined' &&
      typeof HTMLCanvasElement !== 'undefined' &&
      typeof HTMLCanvasElement.prototype.captureStream === 'function'
    )
  } catch {
    return false
  }
}

function pickMime(): string | undefined {
  const candidates = [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ]
  for (const m of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m
    } catch {
      /* ignore */
    }
  }
  return undefined
}

// Records `drawFrame` rendered across the trace range into a WebM blob. The
// caller supplies a redraw fn so recording reuses the exact render path.
export function recordWebm(
  canvas: HTMLCanvasElement,
  drawFrame: (trace: number) => void,
  opts: RecordOptions,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (!canRecord()) {
      reject(new Error('Recording is not supported in this browser.'))
      return
    }
    let stream: MediaStream
    let recorder: MediaRecorder
    try {
      stream = canvas.captureStream(opts.fps)
      const mime = pickMime()
      recorder = new MediaRecorder(stream, {
        ...(mime ? { mimeType: mime } : {}),
        videoBitsPerSecond: 12_000_000,
      })
    } catch (err) {
      reject(err instanceof Error ? err : new Error('Could not start recording.'))
      return
    }

    const chunks: BlobPart[] = []
    recorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data)
    }
    recorder.onerror = () => reject(new Error('Recording failed.'))
    recorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop())
      resolve(new Blob(chunks, { type: 'video/webm' }))
    }

    recorder.start()
    const start = performance.now()
    const drawMs = Math.max(0.2, opts.duration) * 1000
    const holdMs = Math.max(0, opts.hold) * 1000

    const tick = () => {
      const elapsed = performance.now() - start
      if (elapsed < drawMs) {
        drawFrame(Math.min(1, elapsed / drawMs))
        requestAnimationFrame(tick)
      } else if (elapsed < drawMs + holdMs) {
        drawFrame(1)
        requestAnimationFrame(tick)
      } else {
        drawFrame(1)
        try {
          recorder.stop()
        } catch (err) {
          reject(err instanceof Error ? err : new Error('Could not stop recording.'))
        }
      }
    }
    requestAnimationFrame(tick)
  })
}
