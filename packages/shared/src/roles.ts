import { z } from 'zod'

/**
 * A pipeline stage that is served by a model. Each role is bound independently,
 * so OCR can run on one host and extraction on another.
 */
export const ROLES = ['ocr', 'classify', 'extract', 'fallback', 'embed'] as const
export type Role = (typeof ROLES)[number]

export const PROVIDER_IDS = ['ollama', 'openai', 'google'] as const
export type ProviderId = (typeof PROVIDER_IDS)[number]

/**
 * Credentials belong to a provider; model choice belongs to a role. Keeping
 * these apart is what lets a provider be added without touching role bindings,
 * and a role be reassigned without re-entering a credential.
 */
export const ProviderConfigSchema = z.object({
  /** Masked whenever this is read back over HTTP — never returned in full. */
  apiKey: z.string().nullable().default(null),
  /**
   * Inference usually lives on another machine here, so this is routine
   * configuration rather than an advanced option (FR-8.3).
   */
  baseUrl: z.string().url().nullable().default(null),
})
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>

export const RoleBindingSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().min(1),
})
export type RoleBinding = z.infer<typeof RoleBindingSchema>

export const AppConfigSchema = z.object({
  providers: z.record(z.enum(PROVIDER_IDS), ProviderConfigSchema),
  roles: z.record(z.enum(ROLES), RoleBindingSchema.nullable()),
})
export type AppConfig = z.infer<typeof AppConfigSchema>

/**
 * Seven states, not one boolean. Each maps to exactly one user action, because
 * "unhealthy" forces the user to guess which of these it is (FR-9.2).
 */
export const ROLE_STATUSES = [
  'ready',
  'not_installed',
  'wont_fit',
  'unreachable',
  'no_api_key',
  'incapable',
  'unconfigured',
] as const
export type RoleStatus = (typeof ROLE_STATUSES)[number]

/**
 * Whether a model honours a requested JSON schema.
 *
 * This cannot be read from model metadata — unlike vision support, there is no
 * field that reports it — so it is established by probing and cached per model
 * (FR-8.9).
 */
export type StructuredOutputTier = 'strict' | 'loose' | 'none'

export interface ModelCapabilities {
  vision: boolean
  embedding: boolean
  structuredOutput: StructuredOutputTier
}
