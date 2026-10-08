import { answerQuestion, type QaAnswer } from '@ocr/core'
import { searchChunks } from '../repositories/chunks.js'
import { providerForRole, type ServerConfig } from '../config.js'

/**
 * Wires the retrieval graph to the database.
 *
 * The graph takes a `retrieve` function rather than a database client, so this is
 * the only place the two meet. It is also what lets the graph be used from the
 * harness or an agent without a server running.
 */
export async function askDocument(input: {
  question: string
  /** Omitted searches the whole corpus (FR-6.6). */
  documentId?: string | undefined
  config: ServerConfig
}): Promise<QaAnswer> {
  const embedProvider = providerForRole(input.config, 'embed')
  const chatProvider = providerForRole(input.config, 'extract')

  return answerQuestion(input.question, {
    provider: chatProvider,
    retrieve: async (query) => {
      const [embedding] = await embedProvider.embed([query])
      if (!embedding) return []
      const hits = await searchChunks({
        embedding,
        limit: 6,
        documentId: input.documentId,
      })
      return hits.map((h) => ({
        page: h.page,
        content: h.content,
        documentType: h.documentType,
        documentId: h.documentId,
      }))
    },
  })
}
