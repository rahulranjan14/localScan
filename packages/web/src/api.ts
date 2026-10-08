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

  upload: (file: File) => {
    const form = new FormData()
    form.append('file', file)
    return request<DocumentRecord>('/api/documents', { method: 'POST', body: form })
  },

  save: (id: string, data: unknown) =>
    request<DocumentRecord>(`/api/documents/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    }),

  fileUrl: (fileId: string) => `/api/files/${fileId}`,
}
