/**
 * Parsing and validation of one distillation call's JSON output: candidate
 * topic notes with the classifier's scope per candidate, plus the journal
 * entry. Model text is untrusted input — every field is validated here.
 * @module @deepseek-ai/dsh-memory-lifecycle/parse
 */

/** Scope the classifier may assign one candidate. */
export type CandidateScope = 'project' | 'global'

/** One validated candidate topic note from a distillation pass. */
export interface DistillCandidate {
  readonly scope: CandidateScope
  readonly title: string
  readonly content: string
  readonly tags: readonly string[]
  readonly related: readonly string[]
}

/** One validated journal entry from a distillation pass. */
export interface DistillJournal {
  readonly title: string
  readonly body: string
}

/** The validated distillation call output. */
export interface DistillOutput {
  readonly notes: readonly DistillCandidate[]
  readonly journal: DistillJournal
}

/** One candidate id/reason pair a review call proposes for promotion. */
export interface ReviewCandidateProposal {
  readonly id: string
  readonly reason: string
}

/** The validated review call output. */
export interface ReviewOutput {
  readonly candidates: readonly ReviewCandidateProposal[]
}

/** The model-reply kinds that share the object-extraction contract. */
type ModelReplyKind = 'distillation' | 'review'

/**
 * Extract the first balanced JSON object from a model text reply, tolerating
 * surrounding prose and code fences.
 * @param text - complete model output.
 * @returns the raw JSON substring, or `undefined` without an object.
 */
export function extractJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start === -1) return undefined
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = start; index < text.length; index += 1) {
    const char = text.charAt(index)
    if (inString) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }
    if (char === '"') inString = true
    else if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, index + 1)
    }
  }
  return undefined
}

/**
 * Parse and validate one distillation reply into candidates and a journal
 * entry. A reply with no JSON value yields `undefined` (nothing extractable);
 * a reply whose value violates the distillation contract fails loudly.
 * @param text - complete model text output.
 * @returns the validated output, or `undefined` without a JSON value.
 */
export function parseDistillOutput(text: string): DistillOutput | undefined {
  return parseModelObject(text, 'distillation', validateDistillObject)
}

/**
 * Parse and validate one review reply into candidate proposals. A reply with
 * no JSON value yields `undefined` (nothing extractable); a reply whose value
 * violates the review contract fails loudly.
 * @param text - complete model text output.
 * @returns the validated output, or `undefined` without a JSON value.
 */
export function parseReviewOutput(text: string): ReviewOutput | undefined {
  return parseModelObject(text, 'review', validateReviewObject)
}

/**
 * Extract one model reply's first JSON object and hand it to a kind-specific
 * validator. Absent JSON yields `undefined`; non-object JSON or an unbalanced
 * brace fails loudly.
 * @param text - complete model text output.
 * @param kind - which contract the reply must satisfy, for diagnostics.
 * @param validate - kind-specific validator over the parsed object root.
 * @returns the validated output, or `undefined` without a JSON value.
 */
function parseModelObject<T>(
  text: string,
  kind: ModelReplyKind,
  validate: (value: Record<string, unknown>) => T,
): T | undefined {
  const raw = extractJsonObject(text)
  if (raw !== undefined) return validate(parseJson(raw, kind) as Record<string, unknown>)
  if (text.includes('{')) {
    throw new Error(`memory-lifecycle: ${kind} output is not valid JSON (unbalanced object)`)
  }
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  try {
    // A brace-less reply can still be a bare JSON value. An object always
    // carries braces, so extraction already handled it: anything that parses
    // here is a non-object and violates the contract.
    JSON.parse(trimmed)
    throw new Error(`memory-lifecycle: ${kind} JSON must be an object`)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith(`memory-lifecycle: ${kind} JSON`)) throw error
    return undefined
  }
}

/** Parse one extracted raw JSON substring with a loud failure. */
function parseJson(raw: string, kind: ModelReplyKind): unknown {
  try {
    return JSON.parse(raw)
  } catch (error: unknown) {
    throw new Error(`memory-lifecycle: ${kind} output is not valid JSON: ${String(error)}`)
  }
}

/**
 * Validate one parsed JSON object root against the distillation contract.
 * @param value - a `JSON.parse`d object (extraction guarantees the braces).
 * @returns the validated output.
 */
function validateDistillObject(value: Record<string, unknown>): DistillOutput {
  if (!Array.isArray(value.notes)) {
    throw new Error('memory-lifecycle: distillation output requires a notes array')
  }
  const notes = (value.notes as unknown[]).map(parseCandidate)
  const journal = parseJournal(value.journal)
  return { notes, journal }
}

/**
 * Validate one parsed JSON object root against the review contract.
 * @param value - a `JSON.parse`d object (extraction guarantees the braces).
 * @returns the validated output.
 */
function validateReviewObject(value: Record<string, unknown>): ReviewOutput {
  if (!Array.isArray(value.candidates)) {
    throw new Error('memory-lifecycle: review output requires a candidates array')
  }
  return { candidates: (value.candidates as unknown[]).map(parseReviewCandidate) }
}

/** Validate one review candidate entry. */
function parseReviewCandidate(value: unknown): ReviewCandidateProposal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memory-lifecycle: each review candidate must be an object')
  }
  const record = value as Record<string, unknown>
  return {
    id: nonEmptyString(record.id, 'review candidate id'),
    reason: nonEmptyString(record.reason, 'review candidate reason'),
  }
}

/** Validate one candidate note entry. */
function parseCandidate(value: unknown): DistillCandidate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memory-lifecycle: each distillation note must be an object')
  }
  const record = value as Record<string, unknown>
  if (record.scope !== 'project' && record.scope !== 'global') {
    throw new Error(`memory-lifecycle: distillation note scope must be "project" or "global", got ${JSON.stringify(record.scope)}`)
  }
  const title = nonEmptyString(record.title, 'note title')
  const content = nonEmptyString(record.content, 'note content')
  return {
    scope: record.scope,
    title,
    content,
    tags: stringArray(record.tags, 'note tags'),
    related: stringArray(record.related, 'note related'),
  }
}

/** Validate the journal entry. */
function parseJournal(value: unknown): DistillJournal {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('memory-lifecycle: distillation output requires a journal entry object')
  }
  const record = value as Record<string, unknown>
  return {
    title: nonEmptyString(record.title, 'journal title'),
    body: nonEmptyString(record.body, 'journal body'),
  }
}

/** Validate one required non-empty string field. */
function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`memory-lifecycle: distillation ${label} must be a non-empty string`)
  }
  return value
}

/** Validate an optional string-array field; absent or empty yields `[]`. */
function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
    throw new Error(`memory-lifecycle: distillation ${label} must be an array of strings`)
  }
  return value as string[]
}
