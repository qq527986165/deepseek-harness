/**
 * Validated lifecycle configuration and its Loader schema.
 * @module @deepseek-ai/dsh-memory-lifecycle/config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** The distillation instruction families the settings card switches between. */
export type DistillMode = 'concise' | 'detailed'

/** Deployment- and settings-owned cost and noise controls for the automatic memory lifecycle. */
export interface Config {
  /** Whether finished turns are distilled at all. Defaults to true. */
  distill?: boolean
  /** Which fixed distillation instruction the auxiliary call uses. Defaults to `concise`. */
  distillMode?: DistillMode
  /** Minimum non-whitespace characters across a finished turn's text to distill. Defaults to 40. */
  minTurnChars?: number
  /** Auxiliary distillation output-token cap (circuit breaker, not a user knob). Defaults to 2048. */
  maxDistillTokens?: number
  /** End-to-end auxiliary distillation deadline in milliseconds. Defaults to 30000. */
  distillTimeoutMs?: number
  /** Optional explicit auxiliary route; must be paired with `model`. */
  provider?: string
  /** Optional explicit auxiliary model; must be paired with `provider`. */
  model?: string
  /** Journal calendar timezone. Omitted means the Node process timezone. */
  timeZone?: string
  /** Maximum UTF-8 bytes of the complete session-start injected context. Defaults to 16384. */
  maxInjectBytes?: number
  /** Cap on project→global upgrade candidates one `/memory-review` run proposes. Defaults to 5. */
  maxReviewCandidates?: number
  /** Age in days after which the panel marks a note with a review badge. Defaults to 30. */
  reviewAfterDays?: number
}

/** Schemastery schema for Loader defaults, the settings namespace, and generated configuration docs. */
export const Config: z<Config> = z.object({
  distill: z.boolean().default(true),
  distillMode: z.union(['concise', 'detailed'] as const).default('concise'),
  minTurnChars: z.number().step(1).min(1).default(40),
  maxDistillTokens: z.number().step(1).min(1).default(2048),
  distillTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  provider: z.string(),
  model: z.string(),
  timeZone: z.string(),
  maxInjectBytes: z.number().step(1).min(1).default(16_384),
  maxReviewCandidates: z.number().step(1).min(1).default(5),
  reviewAfterDays: z.number().step(1).min(1).default(30),
})

/** Fully resolved validated lifecycle parameters. */
export interface ResolvedConfig {
  readonly distill: boolean
  readonly distillMode: DistillMode
  readonly minTurnChars: number
  readonly maxDistillTokens: number
  readonly distillTimeoutMs: number
  readonly provider?: string
  readonly model?: string
  readonly timeZone: string
  readonly maxInjectBytes: number
  readonly maxReviewCandidates: number
  readonly reviewAfterDays: number
}

/**
 * Validate raw plugin config and fill defaults.
 * @param config - raw plugin config.
 * @returns resolved immutable parameters.
 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const candidate: Config = config ?? {}
  for (const key of ['minTurnChars', 'maxDistillTokens', 'distillTimeoutMs', 'maxInjectBytes', 'maxReviewCandidates', 'reviewAfterDays'] as const) {
    const value = candidate[key]
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`memory-lifecycle: ${key} must be a positive integer`)
    }
  }
  const timeout = candidate.distillTimeoutMs ?? 30_000
  if (timeout > MAX_TIMER_DELAY_MS) {
    throw new Error(`memory-lifecycle: distillTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  // The raw cordis.yml value is unvalidated runtime input; widen past the
  // declared union before comparing so the check stays real for hostile config.
  const mode = (candidate.distillMode ?? 'concise') as string
  if (mode !== 'concise' && mode !== 'detailed') {
    throw new Error(`memory-lifecycle: distillMode must be "concise" or "detailed", got ${JSON.stringify(candidate.distillMode)}`)
  }
  const hasProvider = candidate.provider !== undefined
  const hasModel = candidate.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('memory-lifecycle: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof candidate.provider !== 'string' || candidate.provider.length === 0
      || typeof candidate.model !== 'string' || candidate.model.length === 0)) {
    throw new Error('memory-lifecycle: provider and model overrides must be non-empty strings')
  }
  let formatter: Intl.DateTimeFormat
  try {
    formatter = new Intl.DateTimeFormat('en-US', candidate.timeZone === undefined ? {} : { timeZone: candidate.timeZone })
  } catch {
    throw new Error(`memory-lifecycle: invalid IANA timeZone ${JSON.stringify(candidate.timeZone)}`)
  }
  return {
    distill: candidate.distill ?? true,
    distillMode: mode,
    minTurnChars: candidate.minTurnChars ?? 40,
    maxDistillTokens: candidate.maxDistillTokens ?? 2048,
    distillTimeoutMs: timeout,
    ...(hasProvider ? { provider: candidate.provider, model: candidate.model } : {}),
    timeZone: formatter.resolvedOptions().timeZone,
    maxInjectBytes: candidate.maxInjectBytes ?? 16_384,
    maxReviewCandidates: candidate.maxReviewCandidates ?? 5,
    reviewAfterDays: candidate.reviewAfterDays ?? 30,
  }
}
