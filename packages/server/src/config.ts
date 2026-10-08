// First, so every variable read below reflects .env as well as the environment.
import './env.js'
import { ROLES, type Role, type RoleBinding } from '@ocr/shared'
import { OllamaProvider, TIMEOUTS, type LlmProvider } from '@ocr/core'

/**
 * Phase 1 reads role bindings from the environment.
 *
 * Phase 7 replaces this with data/config.json written from the settings screen,
 * so bindings change without a restart. The shape is already the final one --
 * credentials per provider, model per role -- so that swap is a new source for
 * the same structure rather than a redesign.
 */

export interface ServerConfig {
  port: number
  ollamaBaseUrl: string
  roles: Record<Role, RoleBinding | null>
}

function envModel(role: Role, fallback: string | null): RoleBinding | null {
  const model = process.env[`OCR_MODEL_${role.toUpperCase()}`] ?? fallback
  return model ? { provider: 'ollama', model } : null
}

export function loadConfig(): ServerConfig {
  // Inference is on another machine in the normal case here, so this is routine
  // configuration rather than an advanced option (FR-8.3). It still defaults to
  // loopback: a default pointing at a specific LAN address would be wrong on
  // every machine but one.
  const ollamaBaseUrl = process.env.OLLAMA_BASE_URL ?? 'http://127.0.0.1:11434'

  const roles = Object.fromEntries(
    ROLES.map((role) => [
      role,
      envModel(
        role,
        role === 'extract' || role === 'classify' ? 'qwen2.5:3b' : null,
      ),
    ]),
  ) as Record<Role, RoleBinding | null>

  return {
    port: Number(process.env.PORT ?? 3000),
    ollamaBaseUrl,
    roles,
  }
}

export class RoleUnconfiguredError extends Error {
  constructor(readonly role: Role) {
    super(`No model is assigned to the "${role}" role`)
    this.name = 'RoleUnconfiguredError'
  }
}

/** Resolves a role to a ready-to-use provider, or says which role is unset. */
export function providerForRole(config: ServerConfig, role: Role): LlmProvider {
  const binding = config.roles[role]
  if (!binding) throw new RoleUnconfiguredError(role)

  switch (binding.provider) {
    case 'ollama':
      return new OllamaProvider({
        model: binding.model,
        baseUrl: config.ollamaBaseUrl,
        // Per role, because vision on CPU and a three-field classification differ
        // by two orders of magnitude (see TIMEOUTS).
        timeoutMs: TIMEOUTS[role],
      })
    default:
      // openai and google arrive in Phase 7. Failing loudly beats falling back
      // to a different provider than the user asked for.
      throw new Error(`Provider "${binding.provider}" is not implemented yet`)
  }
}
