import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import {
  InputRejected,
  ProviderTimeoutError,
  ProviderUnreachableError,
  loadUiSchema,
} from '@ocr/core'
import { DEFAULT_INPUT_LIMITS } from '@ocr/core'
import { listDocumentTypes } from '@ocr/shared'
import {
  findDocumentById,
  listDocuments,
  updateEditedData,
} from './repositories/documents.js'
import { findFileById } from './repositories/files.js'
import { dataDir, readStoredFile } from './storage/fileStore.js'
import {
  DuplicateDocument,
  describeRun,
  startExtraction,
  temporalHealth,
} from './services/runs.js'
import { askDocument } from './services/qa.js'
import { handleMcpRequest } from './mcp.js'
import { probeStructuredOutput, systemReport } from './services/system.js'
import { ROLES, type Role } from '@ocr/shared'
import { RoleUnconfiguredError, providerForRole, type ServerConfig } from './config.js'

/**
 * One Express application. REST now; the agent surface mounts on this same app
 * and port in Phase 5, so there is never a second listener with its own access
 * rules to keep in step (FR-7.1).
 */

// In memory, not to a temp file: the guards need the bytes before anything
// touches the filesystem, and the size ceiling is already enforced here.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: DEFAULT_INPUT_LIMITS.maxBytes, files: 1 },
})

export function createApp(config: ServerConfig): Express {
  const app = express()
  app.use(express.json({ limit: '1mb' }))

  // The agent surface, on this same app and port (FR-7.1). Mounted before the
  // REST routes only so it is visible first when reading the file.
  app.post('/mcp', async (req, res, next) => {
    try {
      await handleMcpRequest(config, req, res)
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/health', async (_req, res) => {
    const binding = config.roles.extract
    let extractReachable: boolean | null = null
    if (binding) {
      extractReachable = await providerForRole(config, 'extract')
        .ping()
        .catch(() => false)
    }
    const temporal = await temporalHealth()
    res.json({
      // Not ok when nothing can execute a run: an upload would be accepted and
      // then sit forever, which is worse than refusing it.
      ok: temporal.reachable && (temporal.workers ?? 0) > 0,
      roles: config.roles,
      ollamaBaseUrl: config.ollamaBaseUrl,
      textMode: config.textMode,
      allowReprocess: process.env.OCR_ALLOW_REPROCESS === 'true',
      extractReachable,
      temporal,
    })
  })

  /** Cheap checks only — this is polled every 30 seconds (FR-9.4). */
  app.get('/api/system', async (_req, res, next) => {
    try {
      res.json(await systemReport(config))
    } catch (error) {
      next(error)
    }
  })

  /** On demand: this one calls a model, which the poll must never do. */
  app.post('/api/system/probe/:role', async (req, res, next) => {
    try {
      const role = req.params.role as Role
      if (!(ROLES as readonly string[]).includes(role)) {
        res.status(400).json({ error: `Unknown role "${role}"` })
        return
      }
      res.json(await probeStructuredOutput(config, role))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/document-types', (_req, res) => {
    res.json(listDocumentTypes().map(({ slug, label }) => ({ slug, label })))
  })

  /** Multipart fields arrive as strings, so "false" must not read as true. */
  const parseFlag = (value: unknown): boolean =>
    value === true || value === 'true' || value === '1' || value === 'on'

  app.post(
    '/api/documents',
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with "file".' })
          return
        }
        const pages = parsePageSelection(req.body?.pages)
        // 202 and a run id, not a held-open connection. Extraction takes minutes
        // on local hardware, which is far too long for an HTTP request (FR-1.5).
        const run = await startExtraction({
          bytes: new Uint8Array(req.file.buffer),
          filename: req.file.originalname,
          mime: req.file.mimetype,
          pages: pages ?? undefined,
          reprocess: parseFlag(req.body?.reprocess),
        })
        res.status(202).json(run)
      } catch (error) {
        next(error)
      }
    },
  )

  /** Poll a run. Temporal is the run history, so this reads from it directly. */
  app.get('/api/runs/:workflowId', async (req, res, next) => {
    try {
      res.json(await describeRun(req.params.workflowId))
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/documents', async (req, res, next) => {
    try {
      res.json(
        await listDocuments({
          type: typeof req.query.type === 'string' ? req.query.type : undefined,
          status: typeof req.query.status === 'string' ? req.query.status : undefined,
        }),
      )
    } catch (error) {
      next(error)
    }
  })

  app.get('/api/documents/:id', async (req, res, next) => {
    try {
      const document = await findDocumentById(req.params.id)
      if (!document) {
        res.status(404).json({ error: 'No such document' })
        return
      }
      // Layout travels with the document so the interface needs no knowledge of
      // document types at all (FR-5.2). Null for `generic`, which is read-only.
      res.json({ ...document, uiSchema: await loadUiSchema(document.type) })
    } catch (error) {
      next(error)
    }
  })

  app.patch('/api/documents/:id', async (req, res, next) => {
    try {
      const document = await findDocumentById(req.params.id)
      if (!document) {
        res.status(404).json({ error: 'No such document' })
        return
      }

      // Rejected by the API, not merely hidden in the interface (FR-5.7). There
      // is no schema to validate a generic document's edit against, so accepting
      // one would imply a guarantee that does not exist.
      if (document.type === 'generic') {
        res.status(400).json({
          error: 'Generic documents are read-only: there is no schema to validate an edit against.',
        })
        return
      }

      const updated = await updateEditedData(req.params.id, req.body)
      res.json(updated)
    } catch (error) {
      next(error)
    }
  })

  /** Q&A over one document, or over the whole corpus when id is 'all'. */
  app.post('/api/documents/:id/ask', async (req, res, next) => {
    try {
      const question = typeof req.body?.question === 'string' ? req.body.question.trim() : ''
      if (!question) {
        res.status(400).json({ error: 'Send { "question": "..." }' })
        return
      }
      const answer = await askDocument({
        question,
        ...(req.params.id === 'all' ? {} : { documentId: req.params.id }),
        config,
      })
      res.json(answer)
    } catch (error) {
      next(error)
    }
  })

  /** Served inline so the review screen can display it beside the form. */
  app.get('/api/files/:id', async (req, res, next) => {
    try {
      const file = await findFileById(req.params.id)
      if (!file) {
        res.status(404).json({ error: 'No such file' })
        return
      }
      const bytes = await readStoredFile(file.path)
      res.setHeader('content-type', file.mime)
      res.setHeader('content-disposition', `inline; filename="${encodeURIComponent(file.filename)}"`)
      res.send(Buffer.from(bytes))
    } catch (error) {
      next(error)
    }
  })

  // The built interface, when there is one.
  //
  // In development Vite serves it on its own port with hot reload. A built
  // deployment has no Vite, and serving the bundle here means the API, the MCP
  // surface and the interface share one origin -- so no CORS, no second port,
  // and no reverse proxy to explain.
  const webDist = process.env.OCR_WEB_DIST ?? resolve(dataDir(), '..', 'packages/web/dist')
  if (existsSync(join(webDist, 'index.html'))) {
    app.use(express.static(webDist, { index: false }))
    // A single-page app owns its routes: anything not matched above is the
    // interface asking for a deep link, not a missing file. API paths are
    // excluded so a typo there still answers 404 rather than HTML.
    app.get(/^(?!\/api\/|\/mcp).*/, (_req, res) => {
      res.sendFile(join(webDist, 'index.html'))
    })
  }

  app.use(errorHandler)
  return app
}

/**
 * Maps engine errors to status codes in one place.
 *
 * The distinctions matter to whoever reads the response: a rejected input is the
 * caller's problem, an unreachable inference host is the operator's, and a
 * timeout is neither -- it means the work is genuinely slow. Collapsing these
 * into 500 would make all three look like a server bug.
 */
/**
 * Accepts "1,2,5" or "1, 2, 5" and ignores anything that is not a page number.
 *
 * Silently dropping junk rather than rejecting, because this is an optional
 * refinement of a request that is otherwise valid -- failing an upload over a
 * malformed page list would lose the file for no benefit.
 */
function parsePageSelection(value: unknown): number[] | null {
  if (typeof value !== 'string' || value.trim() === '') return null
  const pages = value
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0)
  return pages.length > 0 ? [...new Set(pages)].sort((a, b) => a - b) : null
}

/** Short identifier for the server log, so concurrent uploads stay separable. */
function uploadLabel(req: Request): string {
  return (req.file?.originalname ?? 'upload').slice(0, 24)
}

function errorHandler(error: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if (error instanceof InputRejected) {
    res.status(400).json({ error: error.message, reason: error.reason })
    return
  }
  if (error instanceof DuplicateDocument) {
    // Not an error condition: the caller asked for this document and we have it.
    res.status(200).json({ ...error.existing, duplicate: true })
    return
  }
  if (error instanceof RoleUnconfiguredError) {
    res.status(503).json({ error: error.message, role: error.role })
    return
  }
  if (error instanceof ProviderTimeoutError) {
    res.status(504).json({ error: error.message })
    return
  }
  if (error instanceof ProviderUnreachableError) {
    res.status(502).json({ error: error.message, baseUrl: error.baseUrl })
    return
  }
  // Temporal is the run history, and its history is not kept forever: a dev
  // server restarted or past its retention no longer knows a workflow it once
  // ran. The document survives in Postgres, so this is "the run has aged out",
  // not "something broke" -- and 500 with "Internal error" said the second.
  if (error instanceof Error && error.name === 'WorkflowNotFoundError') {
    res.status(404).json({
      error:
        'No such run. Temporal keeps run history for a limited time, so a run ' +
        'from an earlier session may be gone while its document remains.',
    })
    return
  }
  if (error instanceof Error && 'code' in error && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File is larger than the upload limit.' })
    return
  }

  console.error(error)
  res.status(500).json({ error: 'Internal error' })
}
