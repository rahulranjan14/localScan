import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { z } from 'zod'
import { listDocumentTypes } from '@ocr/shared'
import { loadUiSchema } from '@ocr/core'
import type { Request, Response } from 'express'
import { findDocumentById, listDocuments } from './repositories/documents.js'
import { countChunks } from './repositories/chunks.js'
import { ingestDocument } from './services/ingest.js'
import { askDocument } from './services/qa.js'
import { providerForRole, type ServerConfig } from './config.js'

/**
 * The agent surface: six tools, mounted on the same Express app and port as REST.
 *
 * One process, one port, deliberately. The predecessor ran REST on 8001 and MCP
 * on 8002 as separate services, and the MCP one had no authentication — so the
 * REST authorisation was bypassable by changing port. A single mount point
 * removes that class of bug rather than guarding against it.
 *
 * Every tool is a thin wrapper over the service the HTTP API already uses. No
 * capability exists on one surface and not the other, which is the only way two
 * interfaces stay in step without discipline.
 */

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
})

export function createMcpServer(config: ServerConfig): McpServer {
  const server = new McpServer({ name: 'agentic-ocr', version: '0.1.0' })

  server.registerTool(
    'list_document_types',
    {
      description: 'What kinds of document this engine can extract into typed data.',
      inputSchema: {},
    },
    async () =>
      text({
        types: listDocumentTypes().map((t) => ({ slug: t.slug, label: t.label })),
        generic:
          'Anything else is extracted as flat key-values, stored and made queryable, but is read-only.',
      }),
  )

  server.registerTool(
    'extract_document',
    {
      description:
        'Run the full pipeline over a PDF: transcription if needed, classification, ' +
        'then typed extraction. Takes minutes on local hardware.',
      inputSchema: {
        filename: z.string().describe('Name of the file, used for display only'),
        content_base64: z.string().describe('The PDF bytes, base64 encoded'),
        pages: z.string().optional().describe('Page numbers to process, e.g. "1,2,5"'),
      },
    },
    async ({ filename, content_base64, pages }) => {
      const document = await ingestDocument({
        bytes: new Uint8Array(Buffer.from(content_base64, 'base64')),
        filename,
        mime: 'application/pdf',
        config,
        ...(pages
          ? { pages: pages.split(',').map((p) => Number(p.trim())).filter(Number.isInteger) }
          : {}),
      })
      return text({
        id: document.id,
        type: document.type,
        status: document.status,
        confidence: document.confidence,
        data: document.structuredData,
        error: document.error,
      })
    },
  )

  server.registerTool(
    'get_document',
    {
      description: 'Fetch a stored document by id, with its data and form layout.',
      inputSchema: { id: z.string().describe('Document id') },
    },
    async ({ id }) => {
      const document = await findDocumentById(id)
      if (!document) return text({ error: 'No such document' })
      return text({
        ...document,
        // The layout travels with the document here as it does over HTTP, so an
        // agent rendering a form sees the same contract the browser does.
        uiSchema: await loadUiSchema(document.type),
      })
    },
  )

  server.registerTool(
    'list_documents',
    {
      description: 'Browse stored documents, optionally filtered by type or status.',
      inputSchema: {
        type: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      },
    },
    async ({ type, status, limit }) => {
      const documents = await listDocuments({ type, status, ...(limit ? { limit } : {}) })
      // Deliberately without raw_text: a listing of twenty documents would
      // otherwise return hundreds of kilobytes into a model's context.
      return text(
        documents.map(({ rawText: _, ...rest }) => ({
          ...rest,
          textLength: _?.length ?? 0,
        })),
      )
    },
  )

  server.registerTool(
    'ask_document',
    {
      description:
        'Ask a question about one document, or about every stored document. ' +
        'Answers cite the page they came from.',
      inputSchema: {
        question: z.string(),
        document_id: z
          .string()
          .optional()
          .describe('Omit to search the whole corpus'),
      },
    },
    async ({ question, document_id }) =>
      text(await askDocument({ question, documentId: document_id, config })),
  )

  server.registerTool(
    'get_engine_status',
    {
      description: 'Which models serve which role, and whether they are reachable.',
      inputSchema: {},
    },
    async () => {
      const reachable = await providerForRole(config, 'extract')
        .ping()
        .catch(() => false)
      return text({
        roles: config.roles,
        inferenceHost: config.ollamaBaseUrl,
        textMode: config.textMode,
        reachable,
        indexedChunks: await countChunks().catch(() => null),
      })
    },
  )

  return server
}

/**
 * Streamable HTTP, stateless.
 *
 * A fresh transport per request rather than a session map: every tool here is a
 * single request/response with no state between calls, so sessions would add
 * bookkeeping and a leak to manage for no behaviour.
 */
export async function handleMcpRequest(
  config: ServerConfig,
  req: Request,
  res: Response,
): Promise<void> {
  const server = createMcpServer(config)
  // `sessionIdGenerator: undefined` is what makes the transport stateless. With
  // a generator set it expects an mcp-session-id header on every request after
  // initialize -- and since a fresh server is built per request here, that
  // session never exists and every subsequent call sees an empty server. The
  // symptom is tools/list returning zero tools rather than an error.
  // The SDK types sessionIdGenerator as required, so under
  // exactOptionalPropertyTypes it cannot be written as undefined directly. The
  // cast is to the SDK's own options type and changes nothing at runtime.
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  } as unknown as ConstructorParameters<typeof StreamableHTTPServerTransport>[0])

  res.on('close', () => {
    void transport.close()
    void server.close()
  })

  // The SDK declares Transport's optional callbacks as non-optional properties,
  // which this project's exactOptionalPropertyTypes rejects. The cast is to the
  // SDK's own type and changes nothing at runtime.
  await server.connect(transport as unknown as Parameters<typeof server.connect>[0])
  await transport.handleRequest(req, res, req.body)
}
