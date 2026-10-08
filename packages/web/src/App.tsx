import { useEffect, useState } from 'react'
import { api, type HealthResponse } from './api'
import { Library } from './components/Library'
import { Review } from './components/Review'
import { Upload } from './components/Upload'

type View = { name: 'library' } | { name: 'upload' } | { name: 'review'; id: string }

export function App() {
  const [view, setView] = useState<View>({ name: 'library' })
  const [health, setHealth] = useState<HealthResponse | null>(null)
  const [theme, setTheme] = useState<'light' | 'dark' | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)

  useEffect(() => {
    api.health().then(setHealth).catch(() => setHealth(null))
  }, [view])

  useEffect(() => {
    if (theme) document.documentElement.dataset['theme'] = theme
  }, [theme])

  // One dot, with what is wrong behind it. A single "unhealthy" flag would make
  // the user guess which of several unrelated problems they have (FR-9.2).
  const reachable = health?.extractReachable
  const dot = reachable === true ? 'var(--ok)' : reachable === null ? 'var(--text-dim)' : 'var(--bad)'

  return (
    <div className="app">
      <header className="header">
        <h1>agentic-ocr</h1>
        <span
          title={
            health
              ? `extract model ${health.roles['extract']?.model ?? '(unconfigured)'} at ${health.ollamaBaseUrl} — ${
                  reachable === true ? 'reachable' : reachable === null ? 'unconfigured' : 'unreachable'
                }`
              : 'server unreachable'
          }
          style={{
            width: 8,
            height: 8,
            borderRadius: 999,
            background: dot,
            display: 'inline-block',
          }}
        />
        <nav>
          <button className="subtle" onClick={() => setView({ name: 'library' })}>
            Library
          </button>
          <button className="subtle" onClick={() => setView({ name: 'upload' })}>
            Upload
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
        {view.name === 'review' && (
          <Review id={view.id} onBack={() => setView({ name: 'library' })} />
        )}
      </main>
    </div>
  )
}
