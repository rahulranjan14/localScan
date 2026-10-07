import { useEffect, useState } from 'react'
import { api, type DocumentRecord } from '../api'

/** Document list with type and status filters (FR-5.9). */
export function Library({ onOpen, refreshKey }: { onOpen: (id: string) => void; refreshKey: number }) {
  const [docs, setDocs] = useState<DocumentRecord[] | null>(null)
  const [status, setStatus] = useState('')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setDocs(null)
    api
      .list(status ? { status } : {})
      .then((rows) => !cancelled && setDocs(rows))
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [status, refreshKey])

  return (
    <div className="library">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Documents</h2>
        <span className="spacer" />
        <select
          value={status}
          onChange={(event) => setStatus(event.target.value)}
          style={{ width: 'auto' }}
        >
          <option value="">All statuses</option>
          <option value="completed">Completed</option>
          <option value="needs_review">Needs review</option>
          <option value="failed">Failed</option>
        </select>
      </div>

      {error && <div className="notice">{error}</div>}

      {docs === null ? (
        <p className="dim">Loading…</p>
      ) : docs.length === 0 ? (
        <p className="dim">Nothing here yet. Upload a PDF to get started.</p>
      ) : (
        docs.map((doc) => {
          const data = doc.editedStructuredData ?? doc.structuredData
          const label = (data?.['invoiceNumber'] as string | undefined) ?? doc.id.slice(0, 8)
          const vendor = (data?.['vendor'] as { name?: string } | undefined)?.name
          return (
            <button className="row" key={doc.id} onClick={() => onOpen(doc.id)}>
              <span className={`badge ${doc.status}`}>{doc.status.replace('_', ' ')}</span>
              <span className="name mono">{label}</span>
              {vendor && <span className="dim">{vendor}</span>}
              <span className="spacer" />
              <span className="dim">{doc.type}</span>
              <span className="dim" style={{ fontSize: 12 }}>
                {new Date(doc.createdAt).toLocaleString()}
              </span>
            </button>
          )
        })
      )}
    </div>
  )
}
