import { useRef, useState } from 'react'
import { api } from '../api'

/**
 * Drag-and-drop *and* a file picker, both wired (FR-1.1).
 *
 * Worth stating because both frontends in the predecessor archive styled a drop
 * zone and never connected `onDrop` -- it looked like a feature and was a
 * decoration.
 */
export function Upload({ onDone }: { onDone: (id: string) => void }) {
  const [over, setOver] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const input = useRef<HTMLInputElement>(null)

  const send = async (file: File) => {
    setBusy(true)
    setError(null)
    setElapsed(0)
    // Extraction runs inline and takes minutes on local hardware, so a spinner
    // with no elapsed time is indistinguishable from a hang. Phase 6 replaces
    // this with real per-stage progress from the orchestrator.
    const started = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - started) / 1000)), 1000)
    try {
      const doc = await api.upload(file)
      onDone(doc.id)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      clearInterval(timer)
      setBusy(false)
    }
  }

  if (busy) {
    return (
      <div className="center">
        <div className="panel" style={{ textAlign: 'center' }}>
          <p style={{ marginTop: 0 }}>Extracting…</p>
          <p className="dim mono">{elapsed}s</p>
          <p className="dim" style={{ fontSize: 13, marginBottom: 0 }}>
            Local inference on CPU takes a few minutes. The text layer is read without a model;
            the time goes on extraction.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div className="center">
      <div className="panel">
        <h2 style={{ marginTop: 0, fontSize: 16 }}>Upload a PDF</h2>

        {error && <div className="notice" style={{ borderLeftColor: 'var(--bad)' }}>{error}</div>}

        <div
          className={`drop${over ? ' over' : ''}`}
          onClick={() => input.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setOver(true)
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(event) => {
            event.preventDefault()
            setOver(false)
            const file = event.dataTransfer.files[0]
            if (file) void send(file)
          }}
        >
          <p style={{ margin: 0 }}>Drop a PDF here, or click to choose one</p>
          <p style={{ margin: '6px 0 0', fontSize: 12 }}>
            Digital PDFs skip the vision model entirely
          </p>
        </div>

        <input
          ref={input}
          type="file"
          accept="application/pdf"
          hidden
          onChange={(event) => {
            const file = event.target.files?.[0]
            if (file) void send(file)
          }}
        />
      </div>
    </div>
  )
}
