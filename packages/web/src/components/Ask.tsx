import { useState } from 'react'
import { api, type AskAnswer } from '../api'

/**
 * Question answering over a document, with page citations.
 *
 * This is the only surface where a `generic` document is useful. It cannot be
 * edited — there is no schema to validate an edit against — but it is chunked,
 * embedded and answerable, which is where retrieval earns its keep hardest: no
 * structured data to read, so you query it instead.
 *
 * The rewrites are shown deliberately. When the answer is wrong, the queries the
 * system actually searched for are the first thing worth seeing, and they are
 * also the only visible evidence that the self-corrective loop is a loop rather
 * than a single retrieval.
 */
export function Ask({ documentId }: { documentId: string }) {
  const [question, setQuestion] = useState('')
  const [answer, setAnswer] = useState<AskAnswer | null>(null)
  const [asking, setAsking] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const ask = async () => {
    const q = question.trim()
    if (!q || asking) return
    setAsking(true)
    setError(null)
    setAnswer(null)
    try {
      setAnswer(await api.ask(documentId, q))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setAsking(false)
    }
  }

  return (
    <section className="group">
      <h3>Ask this document</h3>

      <div style={{ display: 'flex', gap: 8 }}>
        <input
          value={question}
          placeholder="What is the total?"
          disabled={asking}
          onChange={(event) => setQuestion(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void ask()
          }}
        />
        <button className="primary" onClick={() => void ask()} disabled={asking || !question.trim()}>
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </div>

      {asking && (
        <p className="dim" style={{ fontSize: 13, marginBottom: 0 }}>
          Retrieving, grading the result, and rewriting the query if it was not enough.
          A minute or two on local hardware.
        </p>
      )}

      {error && (
        <div className="notice" style={{ borderLeftColor: 'var(--bad)', marginTop: 10 }}>
          {error}
        </div>
      )}

      {answer && (
        <div style={{ marginTop: 12 }}>
          <p style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>{answer.answer}</p>

          <p className="dim" style={{ fontSize: 13, margin: '0 0 6px' }}>
            {answer.citations.length > 0 ? (
              <>
                From page{answer.citations.length > 1 ? 's' : ''}{' '}
                <strong>{answer.citations.join(', ')}</strong>
              </>
            ) : (
              'No page cited — treat this answer with suspicion.'
            )}
          </p>

          {answer.rewrites > 0 && (
            <details>
              <summary className="dim" style={{ cursor: 'pointer', fontSize: 12 }}>
                The first search did not find it — {answer.rewrites} rewrite
                {answer.rewrites > 1 ? 's' : ''}
              </summary>
              <ol className="dim mono" style={{ fontSize: 12, margin: '6px 0 0', paddingLeft: 22 }}>
                {answer.queries.map((q, i) => (
                  <li key={i}>{q}</li>
                ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </section>
  )
}
