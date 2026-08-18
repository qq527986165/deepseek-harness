/**
 * Model-facing memory tools over the memory capability seam: write, read,
 * search, and traverse. The caller's session cwd resolves the scope chain;
 * the provider owns every storage detail.
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { MemoryNoteId } from '@deepseek-ai/dsh-memory'
import type { MemoryNote, MemoryScope, MemoryTraversal } from '@deepseek-ai/dsh-memory'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'tool-memory'

/** Capability services required by the model-facing consumer. */
export const inject = ['memory', 'tools']

/** The caller session's working directory; memory tools require an agent caller. */
function callerCwd(exec: ToolRunContext): string | undefined {
  if (exec.agent === undefined) throw new Error('memory tools require an agent caller')
  return exec.agent.session.header.cwd
}

/** Resolve the effective write scope: explicit value, else project when available. */
async function resolveWriteScope(ctx: Context, exec: ToolRunContext, scope: string | undefined): Promise<MemoryScope> {
  const cwd = callerCwd(exec)
  if (scope !== undefined) {
    if (scope !== 'project' && scope !== 'global') {
      throw new Error(`memory_write: scope must be "project" or "global", got "${scope}"`)
    }
    return scope
  }
  const scopes = await ctx.memory.resolveScopes(cwd)
  return scopes.includes('project') ? 'project' : 'global'
}

/**
 * Render one written note reference for the model.
 * @param scope - the vault scope the note landed in.
 * @param title - note title.
 * @param path - note path relative to its vault root.
 * @returns one text content block.
 */
export function renderWrite(scope: MemoryScope, title: string, path: string): ContentBlock[] {
  return [{ type: 'text', text: `Wrote memory note "${title}" (${scope} scope) at ${path}.` }]
}

/**
 * Render one read note for the model: body plus both link directions.
 * @param note - the resolved note.
 * @returns one text content block.
 */
export function renderRead(note: MemoryNote): ContentBlock[] {
  const lines = [`# ${note.title}`, '', note.body]
  const related = note.related.map(target => target.id === undefined ? target.title : `${target.title} (resolved)`)
  const backlinks = note.backlinks.map(target => target.title)
  if (related.length > 0) lines.push('', `Related: ${related.join(', ')}`)
  if (backlinks.length > 0) lines.push(`Backlinks: ${backlinks.join(', ')}`)
  lines.push('', `Tags: ${note.tags.join(', ') || '(none)'}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Render one search hit list for the model.
 * @param hits - ranked hits, project first.
 * @returns one text content block.
 */
export function renderSearch(hits: readonly { scope: MemoryScope; title: string; snippet: string }[]): ContentBlock[] {
  if (hits.length === 0) return [{ type: 'text', text: 'No memory notes matched the query.' }]
  const lines = hits.map((hit, index) => `${index + 1}. ${hit.title} (${hit.scope}): ${hit.snippet}`)
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * Render one traversal result for the model.
 * @param traversal - start note and bounded adjacency.
 * @returns one text content block.
 */
export function renderTraverse(traversal: MemoryTraversal): ContentBlock[] {
  const lines = [`From "${traversal.start.title}":`]
  if (traversal.nodes.length === 0) {
    lines.push('No linked notes.')
  } else {
    for (const node of traversal.nodes) {
      const target = node.id === undefined ? `${node.title} (dangling)` : node.title
      lines.push(`- ${target} (${node.via.direction} ${node.via.kind})`)
    }
    if (traversal.truncated) lines.push('(More linked notes exist; the result is truncated.)')
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Mutable canonical value the read tool returns to the registry. */
interface ReadNoteValue {
  id: string
  scope: string
  title: string
  path: string
  tags: string[]
  body: string
  related: Array<{ title: string; id?: string }>
  backlinks: Array<{ title: string; id?: string }>
}

const WRITE_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      id: { type: 'string' as const, required: true as const },
      scope: { type: 'string' as const, required: true as const },
      title: { type: 'string' as const, required: true as const },
      path: { type: 'string' as const, required: true as const },
      created: { type: 'string' as const, required: true as const },
      updated: { type: 'string' as const, required: true as const },
    },
  },
  render: (_args: unknown, value: unknown) => {
    const result = value as { scope: MemoryScope; title: string; path: string }
    return renderWrite(result.scope, result.title, result.path)
  },
}

const LINK_TARGET_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    title: { type: 'string' as const, required: true as const },
    id: { type: 'string' as const },
  },
}

const NOTE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    id: { type: 'string' as const, required: true as const },
    scope: { type: 'string' as const, required: true as const },
    title: { type: 'string' as const, required: true as const },
    path: { type: 'string' as const, required: true as const },
    tags: { type: 'array' as const, items: { type: 'string' as const }, required: true as const },
    body: { type: 'string' as const, required: true as const },
    related: { type: 'array' as const, items: LINK_TARGET_SCHEMA, required: true as const },
    backlinks: { type: 'array' as const, items: LINK_TARGET_SCHEMA, required: true as const },
  },
}

const READ_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: { note: { ...NOTE_SCHEMA, required: true as const } },
  },
  render: (_args: unknown, value: unknown) => renderRead((value as { note: MemoryNote }).note),
}

const SEARCH_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      hits: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            id: { type: 'string' as const, required: true as const },
            scope: { type: 'string' as const, required: true as const },
            title: { type: 'string' as const, required: true as const },
            snippet: { type: 'string' as const, required: true as const },
            tags: { type: 'array' as const, items: { type: 'string' as const }, required: true as const },
          },
        },
        required: true as const,
      },
    },
  },
  render: (_args: unknown, value: unknown) => {
    const result = value as { hits: readonly { scope: MemoryScope; title: string; snippet: string }[] }
    return renderSearch(result.hits)
  },
}

const TRAVERSE_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      start: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          id: { type: 'string' as const, required: true as const },
          title: { type: 'string' as const, required: true as const },
        },
        required: true as const,
      },
      nodes: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          additionalProperties: false,
          properties: {
            id: { type: 'string' as const },
            title: { type: 'string' as const, required: true as const },
            via: {
              type: 'object' as const,
              additionalProperties: false,
              properties: {
                kind: { type: 'string' as const, required: true as const },
                direction: { type: 'string' as const, required: true as const },
              },
              required: true as const,
            },
          },
        },
        required: true as const,
      },
      truncated: { type: 'boolean' as const, required: true as const },
    },
  },
  render: (_args: unknown, value: unknown) => renderTraverse(value as MemoryTraversal),
}

/**
 * Register the four memory tools on the shared registry.
 * @param ctx - Cordis context carrying the memory service and tool registry.
 */
export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'memory_write',
    description: 'Create a memory note or replace one by id. Notes hold durable facts about the user, preferences, and project decisions. Call when the user asks to remember something; keep each note one topic and link related notes with [[wikilinks]].',
    parameters: {
      id: { type: 'string', description: 'Optional id of an existing note to replace. Omit to create a new note.' },
      scope: { type: 'string', description: 'Optional vault scope: "project" (default when the session has a project) or "global".' },
      title: { type: 'string', required: true, description: 'Exact note title; wikilinks and lookups resolve by this title.' },
      content: { type: 'string', required: true, description: 'Note body in markdown; may contain [[wikilinks]].' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional topic tags.' },
      related: { type: 'array', items: { type: 'string' }, description: 'Optional titles of related notes to link.' },
    },
    output: WRITE_OUTPUT,
    execute: async (args, exec) => {
      const scope = await resolveWriteScope(ctx, exec, args.scope)
      return ctx.memory.write({
        ...(args.id !== undefined ? { id: MemoryNoteId(args.id) } : {}),
        scope,
        title: args.title,
        content: args.content,
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.related !== undefined ? { related: args.related } : {}),
      }, callerCwd(exec), exec.signal)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_read',
    description: 'Read one memory note by id or exact title, including its related links and backlinks.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Note id or exact title.' },
    },
    output: READ_OUTPUT,
    /* v8 ignore next -- invoked by the registry for sibling-call overlap only. */
    isConcurrencySafe: () => true,
    execute: (args, exec) => ctx.memory.read(args.ref, callerCwd(exec), exec.signal)
      .then(note => ({ note: note as unknown as ReadNoteValue })),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: 'Search memory across the project and global vaults (project hits first) and return ranked hits with snippets.',
    parameters: {
      query: { type: 'string', required: true, description: 'Search terms; results must contain them.' },
      limit: { type: 'integer', description: 'Optional maximum hit count; bounded by deployment config.' },
    },
    output: SEARCH_OUTPUT,
    execute: (args, exec) => ctx.memory.search(
      args.query,
      args.limit === undefined ? undefined : { limit: args.limit },
      callerCwd(exec),
      exec.signal,
    ).then(hits => ({ hits: hits as unknown as Array<{ id: string; scope: string; title: string; tags: string[]; snippet: string }> })),
  }))

  ctx.tools.register(defineTool({
    name: 'memory_traverse',
    description: 'List notes linked to one memory note — outgoing wikilink/related targets and incoming backlinks — one or two hops out.',
    parameters: {
      ref: { type: 'string', required: true, description: 'Start note id or exact title.' },
      depth: { type: 'integer', description: 'Hops to walk: 1 (default) or 2.' },
      kinds: { type: 'array', items: { type: 'string' }, description: 'Optional link kinds to include: "wikilink" and/or "related". Default: both.' },
    },
    output: TRAVERSE_OUTPUT,
    /* v8 ignore next -- invoked by the registry for sibling-call overlap only. */
    isConcurrencySafe: () => true,
    execute: (args, exec) => ctx.memory.traverse(
      args.ref,
      { ...(args.depth !== undefined ? { depth: args.depth as 1 | 2 } : {}), ...(args.kinds !== undefined ? { kinds: args.kinds as ['wikilink' | 'related'] } : {}) },
      callerCwd(exec),
      exec.signal,
    ).then(value => value as unknown as {
      start: { id: string; title: string }
      nodes: Array<{ id?: string; title: string; via: { kind: string; direction: string } }>
      truncated: boolean
    }),
  }))
}
