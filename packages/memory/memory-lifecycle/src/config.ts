/**
 * Validated lifecycle configuration and its Loader schema.
 * @module @deepseek-ai/dsh-memory-lifecycle/config
 */

import z from '@deepseek-ai/schemastery'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'

/** Deployment-owned cost and noise controls for the automatic memory lifecycle. */
export interface Config {
  /** Whether finished turns are distilled at all. Defaults to true. */
  distill?: boolean
  /** Minimum non-whitespace characters across a finished turn's text to distill. Defaults to 40. */
  minTurnChars?: number
  /** Auxiliary distillation output-token cap. Defaults to 1024. */
  maxDistillTokens?: number
  /** End-to-end auxiliary distillation deadline in milliseconds. Defaults to 30000. */
  distillTimeoutMs?: number
  /** Optional explicit auxiliary route; must be paired with `model`. */
  provider?: string
  /** Optional explicit auxiliary model; must be paired with `provider`. */
  model?: string
  /** Maximum UTF-8 bytes of the complete session-start injected context. Defaults to 16384. */
  maxInjectBytes?: number
  /** Project topic notes loaded into the injected context, newest first. Defaults to 10. */
  recentNoteCount?: number
}

/** Schemastery schema for Loader defaults and generated configuration docs. */
export const Config: z<Config> = z.object({
  distill: z.boolean().default(true),
  minTurnChars: z.number().step(1).min(1).default(40),
  maxDistillTokens: z.number().step(1).min(1).default(1024),
  distillTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(30_000),
  provider: z.string(),
  model: z.string(),
  maxInjectBytes: z.number().step(1).min(1).default(16_384),
  recentNoteCount: z.number().step(1).min(1).default(10),
})

/** Fully resolved validated lifecycle parameters. */
export interface ResolvedConfig {
  readonly distill: boolean
  readonly minTurnChars: number
  readonly maxDistillTokens: number
  readonly distillTimeoutMs: number
  readonly provider?: string
  readonly model?: string
  readonly maxInjectBytes: number
  readonly recentNoteCount: number
}

/**
 * Validate raw plugin config and fill defaults.
 * @param config - raw plugin config.
 * @returns resolved immutable parameters.
 */
export function resolveConfig(config?: Config): ResolvedConfig {
  const candidate: Config = config ?? {}
  for (const key of ['minTurnChars', 'maxDistillTokens', 'distillTimeoutMs', 'maxInjectBytes', 'recentNoteCount'] as const) {
    const value = candidate[key]
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`memory-lifecycle: ${key} must be a positive integer`)
    }
  }
  const timeout = candidate.distillTimeoutMs ?? 30_000
  if (timeout > MAX_TIMER_DELAY_MS) {
    throw new Error(`memory-lifecycle: distillTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
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
  return {
    distill: candidate.distill ?? true,
    minTurnChars: candidate.minTurnChars ?? 40,
    maxDistillTokens: candidate.maxDistillTokens ?? 1024,
    distillTimeoutMs: timeout,
    ...(hasProvider ? { provider: candidate.provider, model: candidate.model } : {}),
    maxInjectBytes: candidate.maxInjectBytes ?? 16_384,
    recentNoteCount: candidate.recentNoteCount ?? 10,
  }
}
