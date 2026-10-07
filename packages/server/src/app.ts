import express, { type Express, type NextFunction, type Request, type Response } from 'express'
import multer from 'multer'
import { InputRejected, ProviderTimeoutError, ProviderUnreachableError } from '@ocr/core'
import { DEFAULT_INPUT_LIMITS } from '@ocr/core'
import { listDocumentTypes } from '@ocr/shared'
import {
  findDocumentById,
  listDocuments,
  updateEditedData,
} from './repositories/documents.js'
import { findFileById } from './repositories/files.js'
import { readStoredFile } from './storage/fileStore.js'
import { DuplicateDocument, ingestDocument } from './services/ingest.js'
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

  app.get('/api/health', async (_req, res) => {
    const binding = config.roles.extract
    let extractReachable: boolean | null = null
    if (binding) {
      extractReachable = await providerForRole(config, 'extract')
        .ping()
        .catch(() => false)
    }
    res.json({
      ok: true,
      roles: config.roles,
      ollamaBaseUrl: config.ollamaBaseUrl,
      extractReachable,
    })
  })

  app.get('/api/document-types', (_req, res) => {
    res.json(listDocumentTypes().map(({ slug, label }) => ({ slug, label })))
  })

  app.post(
    '/api/documents',
    upload.single('file'),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        if (!req.file) {
          res.status(400).json({ error: 'No file uploaded. Send multipart/form-data with "file".' })
          return
        }
        const document = await ingestDocument({
          bytes: new Uint8Array(req.file.buffer),
          filename: req.file.originalname,
          mime: req.file.mimetype,
          config,
        })
        res.status(201).json(document)
      } catch (error) {
        next(error)
      }
    },
  )

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
      res.json(document)
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
  if (error instanceof Error && 'code' in error && error.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: 'File is larger than the upload limit.' })
    return
  }

  console.error(error)
  res.status(500).json({ error: 'Internal error' })
}
