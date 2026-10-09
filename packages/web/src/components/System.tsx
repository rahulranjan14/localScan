import { useEffect, useState } from 'react'
import { api, type ProbeResult, type SystemReport } from '../api'

/**
 * Services, models and role assignment on one page (FR-9.1).
 *
 * The role table is the point. Seven named states each map to exactly one user
 * action, so the page can say what to do rather than that something is wrong —
 * "unhealthy" would make the reader guess between pulling a model, starting a
 * host and assigning a role at all.
 */

const STATE_COLOUR: Record<string, string> = {
  ready: 'var(--ok)',
  not_installed: 'var(--warn)',
  wont_fit: 'var(--warn)',
  unreachable: 'var(--bad)',
  no_api_key: 'var(--warn)',
  incapable: 'var(--bad)',
  unconfigured: 'var(--text-dim)',
}

const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`

export function System() {
  const [report, setReport] = useState<SystemReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [probes, setProbes] = useState<Record<string, ProbeResult | 'running'>>({})

  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .system()
        .then((r) => !cancelled && setReport(r))
        .catch((e: Error) => !cancelled && setError(e.message))

    void load()
    // Cheap checks only, so polling costs almost nothing (FR-9.4).
    const timer = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  const probe = async (role: string) => {
    setProbes((p) => ({ ...p, [role]: 'running' }))
    try {
      // Awaited before the updater runs: a setState callback is synchronous.
      const result = await api.probe(role)
      setProbes((p) => ({ ...p, [role]: result }))
    } catch (e) {
      setProbes((p) => ({
        ...p,
        [role]: {
          role,
          model: '',
          honoursSchema: false,
          durationMs: 0,
          detail: (e as Error).message,
        },
      }))
    }
  }

  if (error) return <div className="library"><div className="notice">{error}</div></div>
  if (!report) return <div className="center"><p className="dim">Loading…</p></div>

  const { services } = report

  return (
    <div className="library">
      <h2 style={{ fontSize: 16, marginTop: 0 }}>System</h2>

      <section className="group">
        <h3>Services</h3>
        <Service
          name="PostgreSQL"
          ok={services.database.ok}
          detail={
            services.database.ok
              ? `${services.database.version}${services.database.pgvector ? ' · pgvector' : ' · NO pgvector — retrieval will fail'}`
              : (services.database.reason ?? 'unreachable')
          }
        />
        <Service
          name="Temporal"
          ok={services.temporal.ok}
          detail={
            services.temporal.workers === null
              ? (services.temporal.reason ?? 'unreachable')
              : services.temporal.workers === 0
                ? `up, but no worker polling "${services.temporal.taskQueue}" — uploads would never run`
                : `${services.temporal.workers} worker(s) on "${services.temporal.taskQueue}"`
          }
        />
        <Service
          name="Inference"
          ok={services.inference.ok}
          detail={
            services.inference.ok
              ? `${services.inference.baseUrl} · ${services.inference.models.length} models`
              : (services.inference.reason ?? services.inference.baseUrl)
          }
        />
      </section>

      <section className="group">
        <h3>Roles</h3>
        <table>
          <thead>
            <tr>
              <th style={{ width: '6rem' }}>Role</th>
              <th style={{ width: '12rem' }}>Model</th>
              <th style={{ width: '8rem' }}>State</th>
              <th>What to do</th>
              <th style={{ width: '5rem' }} />
            </tr>
          </thead>
          <tbody>
            {report.roles.map((r) => {
              const result = probes[r.role]
              return (
                <tr key={r.role}>
                  <td className="mono">{r.role}</td>
                  <td className="mono">{r.model ?? '—'}</td>
                  <td>
                    <span style={{ color: STATE_COLOUR[r.status] ?? 'var(--text)' }}>
                      {r.status.replace('_', ' ')}
                    </span>
                  </td>
                  <td style={{ fontSize: 12 }}>
                    {r.note || <span className="dim">—</span>}
                    {result && result !== 'running' && (
                      <div
                        className="dim"
                        style={{ marginTop: 4, color: result.honoursSchema ? 'var(--ok)' : 'var(--bad)' }}
                      >
                        JSON schema {result.honoursSchema ? 'honoured' : 'NOT honoured'} (
                        {(result.durationMs / 1000).toFixed(1)}s) — {result.detail}
                      </div>
                    )}
                  </td>
                  <td>
                    {r.model && (
                      <button
                        className="subtle tiny"
                        disabled={result === 'running'}
                        title="Send a two-field schema request and see whether the output validates"
                        onClick={() => void probe(r.role)}
                      >
                        {result === 'running' ? '…' : 'Test'}
                      </button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
        <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
          Vision and embedding support are read from the host. Whether a model honours a JSON
          schema is not reported by anything, so <strong>Test</strong> measures it — one small
          request, on demand, never on the poll.
        </p>
      </section>

      {services.inference.models.length > 0 && (
        <section className="group">
          <h3>Models on {services.inference.baseUrl}</h3>
          <table>
            <thead>
              <tr>
                <th>Model</th>
                <th style={{ width: '7rem' }}>Size</th>
                <th style={{ width: '10rem' }}>Fits</th>
              </tr>
            </thead>
            <tbody>
              {services.inference.models.map((m) => (
                <tr key={m.name}>
                  <td className="mono">{m.name}</td>
                  <td>{gb(m.sizeBytes)}</td>
                  <td className="dim">
                    {m.fits === null ? 'unknown' : m.fits ? 'yes' : 'no'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {!report.host.inferenceMemoryKnown && (
            <p className="dim" style={{ fontSize: 12, marginTop: 8 }}>
              Fit is unknown because the models run on a different machine and Ollama reports no
              memory figures. Set <code>OCR_INFERENCE_MEMORY_BYTES</code> to have it checked.
              Guessing from this machine's memory would mark every model too large.
            </p>
          )}
        </section>
      )}
    </div>
  )
}

function Service({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="field" style={{ gridTemplateColumns: '8rem 1fr' }}>
      <label>
        <span style={{ color: ok ? 'var(--ok)' : 'var(--bad)', marginRight: 6 }}>●</span>
        {name}
      </label>
      <div style={{ paddingTop: 6, fontSize: 13 }} className={ok ? '' : 'dim'}>
        {detail}
      </div>
    </div>
  )
}
