/**
 * Prompt-side handling of untrusted document text.
 *
 * Be clear about what this does and does not achieve. Fencing is **not** a
 * security boundary -- a sufficiently persuasive payload can still steer a 3B
 * model, and no amount of delimiter discipline changes that. What actually
 * contains an injection here is that the model has no tools: it emits JSON or
 * prose and cannot act, and its output is schema-validated before anything uses
 * it (FR-11.4). Fencing raises the cost; containment is the control.
 */

/** Patterns worth counting. Never used to block -- see `scanForInjection`. */
const INJECTION_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'instruction_override', pattern: /\b(ignore|disregard|forget)\s+(all\s+)?(previous|prior|above)\b/i },
  { name: 'role_reassignment', pattern: /\byou\s+are\s+now\b|\bact\s+as\s+(a|an)\b/i },
  { name: 'system_prompt_probe', pattern: /\b(system\s+prompt|your\s+instructions)\b/i },
  { name: 'chat_control_token', pattern: /<\|(im_start|im_end|endoftext|eot_id)\|>/ },
  { name: 'fence_break', pattern: /<\/document>/i },
]

export interface InjectionScan {
  /** Pattern names that matched. Emitted as a metric, not acted on. */
  matched: string[]
}

/**
 * Detect and count, never block (FR-11.2).
 *
 * Real documents trip these patterns -- a security report quotes attack strings,
 * a contract says "disregard previous agreements". Refusing to process a
 * document because of its subject matter is a worse failure than the attack we
 * would be preventing, given the model cannot act on it anyway.
 */
export function scanForInjection(text: string): InjectionScan {
  return {
    matched: INJECTION_PATTERNS.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name),
  }
}

/**
 * Neutralises the one thing that is structural rather than persuasive: text that
 * closes the fence early and continues outside it. Everything else is left
 * exactly as written, because altering document content would corrupt the
 * extraction we are trying to perform.
 */
export function fence(text: string): string {
  return text.replace(/<\/?document>/gi, (match) => match.replace(/</g, '‹'))
}

/**
 * Prompts live as markdown beside their schema, so tuning one is a text edit
 * rather than a code change (FR-4.2). The document is substituted in fenced.
 */
export function renderPrompt(template: string, documentText: string): string {
  if (!template.includes('{{DOCUMENT}}')) {
    throw new Error('Prompt template has no {{DOCUMENT}} placeholder')
  }
  return template.replace('{{DOCUMENT}}', fence(documentText))
}
