import type { DocumentStatus, DocumentType, UiSchema } from '@ocr/shared'

export interface DocumentRecord {
  id: string
  fileId: string
  type: DocumentType
  rawText: string | null
  structuredData: Record<string, unknown> | null
  editedStructuredData: Record<string, unknown> | null
  confidence: number | null
  classificationReason: string | null
  status: DocumentStatus
  error: string | null
  createdAt: string
  updatedAt: string
  /** Present on a single-document fetch. Null for read-only types. */
  uiSchema?: UiSchema | null
  duplicate?: boolean
}

/** What POST /api/documents returns now: a run to poll, not a document. */
export interface StartedRun {
  runId: string
  workflowId: string
  sha256: string
  /** Present when the file was already processed; there is nothing to wait for. */
  duplicate?: boolean
  id?: string
}

export interface RunStatus {
  workflowId: string
  runId: string
  /** Temporal's own vocabulary: RUNNING, COMPLETED, FAILED, TERMINATED… */
  status: string
  startedAt: string | null
  closedAt: string | null
  result?: { documentId: string; type: string; status: string }
  error?: string
}

export interface HealthResponse {
  ok: boolean
  ollamaBaseUrl: string
  extractReachable: boolean | null
  roles: Record<string, { provider: string; model: string } | null>
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init)
  if (!response.ok) {
    // The server distinguishes a rejected upload from an unreachable inference
    // host from a timeout, and that distinction is the whole value of the
    // message -- so surface its text rather than the status code.
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new Error(body?.error ?? `Request failed (${response.status})`)
  }
  return (await response.json()) as T
}

export const api = {
  health: () => request<HealthResponse>('/api/health'),

  list: (filter: { type?: string; status?: string } = {}) => {
    const params = new URLSearchParams()
    if (filter.type) params.set('type', filter.type)
    if (filter.status) params.set('status', filter.status)
    const query = params.toString()
    return request<DocumentRecord[]>(`/api/documents${query ? `?${query}` : ''}`)
  },

  get: (id: string) => request<DocumentRecord>(`/api/documents/${id}`),

  /**
   * Returns a run to poll, not a document.
   *
   * Extraction takes minutes on local hardware, so the server answers 202 with a
   * run id rather than holding the connection open (FR-1.5). A re-upload of a
   * file already processed answers 200 with the stored document instead, and
   * carries `duplicate` to say so.
   */
  upload: (file: File, pages?: string) => {
    const form = new FormData()
    form.append('file', file)
    if (pages) form.append('pages', pages)
    return request<StartedRun>('/api/documents', { method: 'POST', body: form })
  },

  run: (workflowId: string) => request<RunStatus>(`/api/runs/${workflowId}`),

  ask: (documentId: string, question: string) =>
    request<AskAnswer>(`/api/documents/${documentId}/ask`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question }),
    }),

  save: (id: string, data: unknown) =>
    request<DocumentRecord>(`/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }),

  fileUrl: (fileId: string) => `/api/files/${fileId}`,
}

export interface AskAnswer {
  answer: string
  /** Pages the answer drew on. The reason chunking is page-aware. */
  citations: number[]
  /** Every query tried, original first — shows the self-corrective loop ran. */
  queries: string[]
  rewrites: number
}
