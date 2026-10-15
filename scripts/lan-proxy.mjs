/**
 * Forwards 127.0.0.1:<port> to an inference host on the LAN.
 *
 *   node scripts/lan-proxy.mjs <host-ip>     # or set OCR_INFERENCE_HOST in .env
 *
 * This exists for a macOS problem, not an architectural one. macOS gates
 * **Local Network** access per application: a process can reach the internet and
 * the router freely, and is blocked from talking to another machine on the same
 * LAN unless its parent app has been granted that permission. Terminal usually
 * has it; an editor or an agent running inside one often does not, and the grant
 * is lost whenever the app updates.
 *
 * The symptom is confusing rather than obvious — `curl` from a Terminal window
 * works, the identical request from a tool fails in two milliseconds, and it
 * reports as a connection refusal rather than a permission error.
 *
 * Loopback is exempt from that gate. So this is started once from a terminal that
 * has the permission, and everything else points at 127.0.0.1 and stops caring.
 *
 * No dependencies, because needing to install something to fix a networking
 * problem is how this kind of workaround fails.
 */
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Reads one key out of .env without a dependency.
 *
 * This file is kept dependency-free on purpose -- needing to install something
 * to fix a networking problem is how a workaround like this fails -- so it does
 * twelve lines of parsing rather than importing dotenv. The address of the
 * inference host is configuration, and configuration belongs in .env rather
 * than in a usage example in a public repository.
 */
const fromEnvFile = (key) => {
  try {
    const envPath = join(dirname(dirname(fileURLToPath(import.meta.url))), '.env')
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      const match = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)
      if (match && match[1] === key) return match[2].replace(/^['"]|['"]$/g, '').trim()
    }
  } catch {
    // No .env, or unreadable: the argument is the other way in.
  }
  return undefined
}

const target = process.argv[2] ?? process.env.OCR_INFERENCE_HOST ?? fromEnvFile('OCR_INFERENCE_HOST')
const port = Number(process.argv[3] ?? 11434)

if (!target) {
  console.error('usage: node scripts/lan-proxy.mjs <host-ip> [port]')
  console.error('   or: set OCR_INFERENCE_HOST in .env and run it with no arguments')
  process.exit(2)
}

let active = 0
let total = 0

const server = net.createServer((client) => {
  active++
  total++

  const upstream = net.connect(port, target)

  // Both directions piped, and both sides torn down together. A half-open
  // connection here would strand a request that takes twenty minutes to answer.
  client.pipe(upstream)
  upstream.pipe(client)

  const close = () => {
    client.destroy()
    upstream.destroy()
  }

  upstream.on('error', (error) => {
    console.error(`  upstream error: ${error.message}`)
    close()
  })
  client.on('error', close)
  client.on('close', () => {
    active--
    close()
  })
  upstream.on('close', close)
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n  Port ${port} is already in use on this machine.`)
    console.error(`  Either the proxy is already running, or Ollama is installed locally.\n`)
    process.exit(1)
  }
  throw error
})

// Loopback only. Binding 0.0.0.0 would turn a local workaround into an open
// relay to the inference host for anything on the network.
server.listen(port, '127.0.0.1', () => {
  console.log(`\n  forwarding  127.0.0.1:${port}  →  ${target}:${port}`)
  console.log(`  point OLLAMA_BASE_URL at http://127.0.0.1:${port}`)
  console.log(`  leave this running; Ctrl+C to stop\n`)
})

setInterval(() => {
  if (active > 0) process.stdout.write(`\r  ${active} open, ${total} total   `)
}, 2000).unref()
