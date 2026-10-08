import { useEffect, useState } from 'react'
import { api, type DocumentRecord } from '../api'
import { DynamicForm } from './DynamicForm'

/**
 * How the document type was decided, and how sure the model was.
 *
 * The number is labelled "self-reported" rather than shown as a percentage on its
 * own, because it is **not calibrated** (FR-3.4): a model answering 0.95 does not
 * mean 95% of such answers are correct. Presenting it as a bare percentage invites
 * exactly that reading, which is worse than not showing it — a user who trusts an
 * uncalibrated 0.95 reviews less carefully than one shown nothing.
 */
function Classification({
  confidence,
  reason,
  type,
}: {
  confidence: number | null
  reason: string | null
  type: string
}) {
  return (
    <details className="group" style={{ marginBottom: 18 }}>
      <summary style={{ cursor: 'pointer', fontSize: 13 }}>
        Classified as <strong>{type}</strong>
        {confidence !== null && (
          <span className="dim"> · model's own confidence {confidence.toFixed(2)}</span>
        )}
      </summary>
      <div style={{ marginTop: 8, fontSize: 13 }}>
        {reason && <p style={{ margin: '0 0 8px' }}>{reason}</p>}
        {confidence !== null && (
          <p className="dim" style={{ margin: 0 }}>
            This figure is the model's own estimate and is not calibrated — 0.95 here does not mean
            95% of such answers are right. Treat it as a hint about where to look, not a measure of
            correctness.
          </p>
        )}
      </div>
    </details>
  )
}

/**
 * The core screen: document on the left at full height, fields on the right,
 * each scrolling independently (FR-5.1).
 *
 * Reviewing an extraction *is* reading the source while fixing the field. A modal
 * or a separate tab makes the user hold the document in their head, which is the
 * job the screen is supposed to do for them.
 */
export function Review({ id, onBack }: { id: string; onBack: () => void }) {
  const [doc, setDoc] = useState<DocumentRecord | null>(null)
  const [data, setData] = useState<Record<string, unknown> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    api
      .get(id)
      .then((record) => {
        if (cancelled) return
        setDoc(record)
        // The edited copy when one exists, otherwise what the model produced.
        // The original is never overwritten, so this choice is purely about
        // which version to show first (FR-5.6).
        setData(record.editedStructuredData ?? record.structuredData ?? {})
      })
      .catch((e: Error) => !cancelled && setError(e.message))
    return () => {
      cancelled = true
    }
  }, [id])

  if (error) {
    return (
      <div className="center">
        <div className="panel">
          <p style={{ color: 'var(--bad)' }}>{error}</p>
          <button onClick={onBack}>Back</button>
        </div>
      </div>
    )
  }

  if (!doc || !data) {
    return <div className="center"><p className="dim">Loading…</p></div>
  }

  const readOnly = doc.uiSchema == null

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const updated = await api.save(doc.id, data)
      setDoc({ ...updated, uiSchema: doc.uiSchema })
      setSavedAt(new Date().toLocaleTimeString())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="review">
      <div className="pane-pdf">
        <iframe src={api.fileUrl(doc.fileId)} title="Source document" />
      </div>

      <div className="pane-form">
        <div className="toolbar">
          <button className="subtle" onClick={onBack}>← Library</button>
          <span className={`badge ${doc.status}`}>{doc.status.replace('_', ' ')}</span>
          <span className="dim">{doc.type}</span>
          <span className="spacer" />
          {savedAt && <span className="dim" style={{ fontSize: 12 }}>saved {savedAt}</span>}
          {!readOnly && (
            <button className="primary" onClick={save} disabled={saving}>
              {saving ? 'Saving…' : 'Save corrections'}
            </button>
          )}
        </div>

        {(doc.confidence !== null || doc.classificationReason) && (
          <Classification confidence={doc.confidence} reason={doc.classificationReason} type={doc.type} />
        )}

        {doc.status === 'needs_review' && (
          <div className="notice">
            <strong>Extraction did not validate.</strong> No structured data was stored, so nothing
            below is a partial result presented as fact.
            {doc.error && <div className="mono" style={{ marginTop: 6 }}>{doc.error}</div>}
          </div>
        )}

        {doc.status === 'failed' && (
          <div className="notice">
            <strong>This document could not be processed.</strong>
            {doc.error && <div className="mono" style={{ marginTop: 6 }}>{doc.error}</div>}
          </div>
        )}

        {error && <div className="notice" style={{ borderLeftColor: 'var(--bad)' }}>{error}</div>}

        {readOnly ? (
          <>
            <div className="notice">
              <strong>Read-only.</strong> This type has no schema, so there is nothing to validate
              an edit against. The raw text is the primary view — and it is still fully queryable
              once retrieval lands.
            </div>
            <section className="group">
              <h3>Extracted text</h3>
              <div className="raw">{doc.rawText ?? '(none)'}</div>
            </section>
          </>
        ) : (
          <DynamicForm
            data={data}
            uiSchema={doc.uiSchema!}
            onChange={setData}
          />
        )}

        {!readOnly && doc.rawText && (
          <details className="group">
            <summary className="dim" style={{ cursor: 'pointer', fontSize: 13 }}>
              Extracted text ({doc.rawText.length.toLocaleString()} characters)
            </summary>
            <div className="raw" style={{ marginTop: 8 }}>{doc.rawText}</div>
          </details>
        )}
      </div>
    </div>
  )
}
