import { loadedEnvFile } from './env.js'
import { createApp } from './app.js'
import { loadConfig } from './config.js'
import { closePool } from './db/pool.js'
import { migrate } from './db/migrate.js'
import { temporalHealth } from './services/runs.js'

const config = loadConfig()

// Migrate on boot. On a single-user local tool the alternative is an application
// that starts and then fails every request against a schema the user did not
// know they had to create.
const applied = await migrate()
if (applied.length > 0) {
  console.log(`Applied migrations: ${applied.join(', ')}`)
}

const app = createApp(config)

const server = app.listen(config.port, '127.0.0.1', () => {
  console.log(`  server     http://127.0.0.1:${config.port}`)
  console.log(`  inference  ${config.ollamaBaseUrl}`)
  console.log(`  extract    ${config.roles.extract?.model ?? '(unconfigured)'}`)
  // Printed because a silently-unloaded .env is the failure this replaced: the
  // server came up healthy and pointed at the wrong host.
  console.log(`  env        ${loadedEnvFile ?? '(no .env found — using defaults)'}`)

  // Checked at startup and said plainly, because the failure is silent
  // otherwise: an upload is accepted, a run is created, and nothing ever runs
  // it. From the browser that is indistinguishable from a slow model.
  void temporalHealth().then((t) => {
    if (!t.reachable) {
      console.log(`\n  ⚠ Temporal unreachable — uploads will fail.`)
      console.log(`    start it with:  npm run temporal\n`)
    } else if ((t.workers ?? 0) === 0) {
      console.log(`\n  ⚠ Temporal is up but no worker is polling "${t.taskQueue}".`)
      console.log(`    Uploads will be accepted and never processed.`)
      console.log(`    start one with:  npm run dev:worker\n`)
    } else {
      console.log(`  temporal   ${t.workers} worker(s) on "${t.taskQueue}"`)
    }
  })
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close(() => {
      void closePool().then(() => process.exit(0))
    })
  })
}
