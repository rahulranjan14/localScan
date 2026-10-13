import { useEffect, useRef, useState } from 'react'
import { api, type RunStatus } from '../api'

/**
 * Drag-and-drop *and* a file picker, both wired (FR-1.1).
 *
 * Worth stating because both frontends in the predecessor archive styled a drop
 * zone and never connected `onDrop` — it looked like a feature and was a
 * decoration.
 *
 * Upload no longer waits for a document. The server answers 202 with a run id
 * and this polls it, because extraction takes minutes on local hardware and a
 * held-open connection is the wrong shape for that (FR-1.5).
 */

/** Slow enough not to hammer a busy server, fast enough to feel responsive. */
const POLL_INTERVAL_MS = 2000

export function Upload({ onDone }: { onDone: (documentId: string) => void }) {
  const [over, setOver] = useState(false)
  const [run, setRun] = useState<{ workflowId: string; status: RunStatus | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [pages, setPages] = useState('')
  const [reprocess, setReprocess] = useState(false)
  // Shown only when the server opts in, so the control never offers something
  // the server will silently ignore.
  const [allowReprocess, setAllowReprocess] = useState(false)

  useEffect(() => {
    let cancelled = false
    api
      .health()
      .then((h) => !cancelled && setAllowReprocess(h.allowReprocess === true))
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])
  const input = useRef<HTMLInputElement>(null)

  const send = async (file: File) => {
    setError(null)
    setElapsed(0)
    setRun(null)

    let timer: ReturnType<typeof setInterval> | undefined
    try {
      const started = await api.upload(file, pages.trim() || undefined, reprocess)

      // A file already processed comes back as the stored document, with
      // nothing to wait for.
      if (started.duplicate && started.id) {
        onDone(started.id)
        return
      }

      setRun({ workflowId: started.workflowId, status: null })
      const startedAt = Date.now()
      timer = setInterval(() => setElapsed(Math.round((Date.now() - startedAt) / 1000)), 1000)

      // Poll until Temporal reports a terminal state. The run outlives this
      // page: closing the tab does not cancel it, and reopening would find it
      // still going.
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        const status = await api.run(started.workflowId)
        setRun({ workflowId: started.workflowId, status })

        if (status.status === 'COMPLETED' && status.result) {
          onDone(status.result.documentId)
          return
        }
        if (status.status !== 'RUNNING') {
          setError(status.error ?? `The run ended as ${status.status}.`)
          return
        }
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      if (timer) clearInterval(timer)
    }
  }

  if (run) {
    return (
      <div className="center">
        <div className="panel" style={{ textAlign: 'center' }}>
          <p style={{ marginTop: 0 }}>
            {run.status?.status === 'RUNNING' || run.status === null ? 'Extracting…' : run.status.status}
          </p>
          <p className="dim mono">{elapsed}s</p>
          {error && <div className="notice" style={{ borderLeftColor: 'var(--bad)' }}>{error}</div>}
          <p className="dim" style={{ fontSize: 13, marginBottom: 0 }}>
            Running as a durable workflow. Closing this tab will not cancel it, and
            killing the worker will not lose it — the run resumes.
          </p>
          <p className="dim mono" style={{ fontSize: 11, marginTop: 10, marginBottom: 0 }}>
            {run.workflowId}
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

        <div className="field" style={{ marginTop: 14, gridTemplateColumns: '136px 1fr' }}>
          <label htmlFor="pages">Pages (optional)</label>
          <input
            id="pages"
            value={pages}
            placeholder="all pages"
            onChange={(event) => setPages(event.target.value)}
          />
        </div>

        {allowReprocess && (
          <div className="field" style={{ marginTop: 10, gridTemplateColumns: '136px 1fr' }}>
            <label htmlFor="reprocess">Re-process</label>
            <label htmlFor="reprocess" className="dim" style={{ fontSize: 13, cursor: 'pointer' }}>
              <input
                id="reprocess"
                type="checkbox"
                checked={reprocess}
                onChange={(event) => setReprocess(event.target.checked)}
                style={{ marginRight: 8 }}
              />
              Run again even if this document is already stored — for comparing OCR models and prompts.
            </label>
          </div>
        )}

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
