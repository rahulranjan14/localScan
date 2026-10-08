import { Annotation, END, START, StateGraph } from '@langchain/langgraph'
import { z } from 'zod'
import type { LlmProvider } from '../providers/types.js'
import { formatContext } from '../rag/index.js'

/**
 * Self-corrective retrieval, as a graph.
 *
 * LangGraph is here and not in the extraction pipeline, and the distinction is
 * the point: extraction is a fixed sequence, so a graph framework would add
 * machinery and no capability. Here the control flow genuinely depends on model
 * output — whether to answer or to rewrite the question and search again — which
 * is the thing a graph is for.
 *
 *   retrieve → grade ─┬─ sufficient ──→ generate → END
 *                     └─ insufficient → rewrite → retrieve  (bounded)
 */

export interface RetrievedContext {
  page: number
  content: string
  documentType?: string
  documentId?: string
}

export interface QaOptions {
  /** Searches the corpus and returns the closest chunks. */
  retrieve: (query: string) => Promise<RetrievedContext[]>
  provider: LlmProvider
  /** Bounded: two rewrites is the point at which more attempts stop helping. */
  maxRewrites?: number
  signal?: AbortSignal
}

export interface QaAnswer {
  answer: string
  /** Page numbers the answer drew on, for citation (FR-6.5). */
  citations: number[]
  /** Every query tried, original first. Shows the loop actually ran. */
  queries: string[]
  rewrites: number
  context: RetrievedContext[]
}

const GradeSchema = z.object({
  sufficient: z.boolean(),
  reason: z.string().max(300),
})

const AnswerSchema = z.object({
  answer: z.string().max(4000),
  /** The model names which sources it used, so citations are its claim. */
  sourcesUsed: z.array(z.number().int()).max(20),
})

const RewriteSchema = z.object({
  query: z.string().min(1).max(400),
})

const State = Annotation.Root({
  question: Annotation<string>(),
  query: Annotation<string>(),
  queries: Annotation<string[]>({ reducer: (a, b) => [...a, ...b], default: () => [] }),
  context: Annotation<RetrievedContext[]>({ reducer: (_, b) => b, default: () => [] }),
  sufficient: Annotation<boolean>({ reducer: (_, b) => b, default: () => false }),
  rewrites: Annotation<number>({ reducer: (a, b) => a + b, default: () => 0 }),
  answer: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  citations: Annotation<number[]>({ reducer: (_, b) => b, default: () => [] }),
})

export async function answerQuestion(
  question: string,
  options: QaOptions,
): Promise<QaAnswer> {
  const maxRewrites = options.maxRewrites ?? 2
  const call = { ...(options.signal ? { signal: options.signal } : {}) }

  const graph = new StateGraph(State)
    .addNode('retrieve', async (state) => ({
      context: await options.retrieve(state.query),
      queries: [state.query],
    }))

    .addNode('grade', async (state) => {
      if (state.context.length === 0) return { sufficient: false }
      const graded = await options.provider.chatStructured({
        schema: GradeSchema,
        prompt:
          `Can the question below be answered using only the sources?\n\n` +
          `Question: ${state.question}\n\n${formatContext(state.context)}\n\n` +
          `Answer sufficient=true only if the sources contain the information. ` +
          `Partial relevance is not sufficient — saying false costs one more search, ` +
          `saying true wrongly produces an answer that is not supported by the document.`,
        ...call,
      })
      return { sufficient: graded.sufficient }
    })

    .addNode('rewrite', async (state) => {
      const rewritten = await options.provider.chatStructured({
        schema: RewriteSchema,
        prompt:
          `A search for the question below did not find the answer. Write a ` +
          `different search query for the same question.\n\n` +
          `Question: ${state.question}\nAlready tried: ${state.queries.join(' | ')}\n\n` +
          `Use words likely to appear in the document itself rather than the ` +
          `question's phrasing — a document says "GSTIN", a person asks about a ` +
          `"tax number".`,
        ...call,
      })
      return { query: rewritten.query, rewrites: 1 }
    })

    .addNode('generate', async (state) => {
      // Answered even when grading said insufficient, because by this point the
      // loop is exhausted and "here is what I found, it may not cover it" is
      // more useful than silence. The prompt requires it to say so.
      const generated = await options.provider.chatStructured({
        schema: AnswerSchema,
        prompt:
          `Answer the question using only the sources below.\n\n` +
          `Question: ${state.question}\n\n${formatContext(state.context)}\n\n` +
          `Rules: use only what the sources say. If they do not contain the ` +
          `answer, say so plainly rather than supplying one from general ` +
          `knowledge. List in sourcesUsed the id of every source you drew on.`,
        ...call,
      })

      const used = new Set(generated.sourcesUsed)
      const cited = state.context
        .filter((_, i) => used.has(i + 1))
        .map((c) => c.page)

      return {
        answer: generated.answer,
        // Falling back to every retrieved page when the model names none: a
        // citation that is too broad can be checked, and none cannot.
        citations: [...new Set(cited.length > 0 ? cited : state.context.map((c) => c.page))],
      }
    })

    .addEdge(START, 'retrieve')
    .addEdge('retrieve', 'grade')
    .addConditionalEdges('grade', (state) =>
      state.sufficient || state.rewrites >= maxRewrites ? 'generate' : 'rewrite',
    )
    .addEdge('rewrite', 'retrieve')
    .addEdge('generate', END)
    .compile()

  const final = await graph.invoke({ question, query: question })

  return {
    answer: final.answer,
    citations: final.citations,
    queries: final.queries,
    rewrites: final.rewrites,
    context: final.context,
  }
}
