import { useEffect, useState } from 'react'
import { api, type SystemReport } from './api'
import { Library } from './components/Library'
import { Review } from './components/Review'
import { Upload } from './components/Upload'
import { System } from './components/System'

type View =
  | { name: 'library' }
  | { name: 'upload' }
  | { name: 'system' }
  | { name: 'review'; id: string }

export function App() {
  const [view, setView] = useState<View>({ name: 'library' })
  const [system, setSystem] = useState<SystemReport | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  // One endpoint behind the header dot and the System page (FR-9.1), polled on
  // a 30-second interval because every check in it is cheap.
  useEffect(() => {
    let cancelled = false
    const load = () =>
      api
        .system()
        .then((r) => !cancelled && setSystem(r))
        .catch(() => !cancelled && setSystem(null))
    void load()
    const timer = setInterval(load, 30_000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    if (theme) document.documentElement.dataset['theme'] = theme
  }, [theme])

  // One dot and a count, never a bare "unhealthy": the number is what tells the
  // user whether to look now, and the System page says which of seven things
  // each problem actually is (FR-9.2).
  const problems = system
    ? [
        !system.services.database.ok,
        !system.services.temporal.ok,
        !system.services.inference.ok,
        ...system.roles.map((r) => r.status !== 'ready' && r.status !== 'unconfigured'),
      ].filter(Boolean).length
    : null
  const dot =
    problems === null ? 'var(--text-dim)' : problems === 0 ? 'var(--ok)' : 'var(--bad)'

  return (
    <div className="app">
      <header className="header">
        <h1>agentic-ocr</h1>
        <button
          className="subtle"
          title={
            problems === null
              ? 'Server unreachable'
              : problems === 0
                ? 'Everything is ready'
                : `${problems} thing${problems > 1 ? 's' : ''} need attention`
          }
          onClick={() => setView({ name: 'system' })}
          style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 8px' }}
        >
          <span
            style={{
              width: 8,
              height: 8,
              borderRadius: 999,
              background: dot,
              display: 'inline-block',
            }}
          />
          {problems !== null && problems > 0 && (
            <span style={{ fontSize: 12 }}>{problems}</span>
          )}
        </button>
        <nav>
          <button className="subtle" onClick={() => setView({ name: 'library' })}>
            Library
          </button>
          <button className="subtle" onClick={() => setView({ name: 'upload' })}>
            Upload
          </button>
          <button className="subtle" onClick={() => setView({ name: 'system' })}>
            System
          </button>
          <button
            className="subtle"
            title="Toggle theme"
            onClick={() =>
              setTheme((current) =>
                current === 'dark' ? 'light' : current === 'light' ? 'dark' : 'dark',
              )
            }
          >
            ◐
          </button>
        </nav>
      </header>

      <main className="main">
        {view.name === 'library' && (
          <Library refreshKey={refreshKey} onOpen={(id) => setView({ name: 'review', id })} />
        )}
        {view.name === 'upload' && (
          <Upload
            onDone={(id) => {
              setRefreshKey((k) => k + 1)
              setView({ name: 'review', id })
            }}
          />
        )}
        {view.name === 'system' && <System />}
        {view.name === 'review' && (
          <Review id={view.id} onBack={() => setView({ name: 'library' })} />
        )}
      </main>
    </div>
  )
}
