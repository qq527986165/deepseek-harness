// Real-composition proof: a cordis.yml boots the memory service, the local
// provider, and the model tools through the real Loader; tool calls then write,
// read, search, and traverse durable vault files with no model key.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as MemoryLocal from '@deepseek-ai/dsh-memory-local'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('memory-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

async function boot(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
  const vault = join(root, 'vault')
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-memory'",
    `  config: { dir: ${JSON.stringify(vault)} }`,
    "- name: '@deepseek-ai/dsh-memory-local'",
    '  config: { watch: false }',
    "- name: '@deepseek-ai/dsh-tool-memory'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-memory', MemoryService],
    ['@deepseek-ai/dsh-memory-local', MemoryLocal],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('memory real Loader composition through cordis.yml', () => {
  it('writes durable vault files and reads, searches, and traverses them end to end', async () => {
    const ctx = await boot()
    const owner = agent(ctx)
    const execute = (name: string, args: unknown) => ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(name),
      name,
      arguments: args,
      agent: owner,
    })

    const written = await execute('memory_write', { title: 'Vitest setup', content: 'We use vitest for unit tests.' })
    expect(written.isError).toBe(false)
    expect(resultText(written)).toContain('Wrote memory note "Vitest setup"')

    const vaultFile = join(root!, 'vault', 'notes', 'vitest-setup.md')
    const file = await readFile(vaultFile, 'utf8')
    expect(file).toContain('id:')
    expect(file).toContain('We use vitest for unit tests.')

    await execute('memory_write', { title: 'Linked note', content: 'See [[Vitest setup]].', related: ['Vitest setup'] })

    const read = await execute('memory_read', { ref: 'Vitest setup' })
    expect(read.isError).toBe(false)
    expect(resultText(read)).toContain('Backlinks: Linked note')

    const search = await execute('memory_search', { query: 'vitest' })
    expect(search.isError).toBe(false)
    expect(resultText(search)).toContain('Vitest setup (global)')

    const traverse = await execute('memory_traverse', { ref: 'Linked note', kinds: ['related'] })
    expect(traverse.isError).toBe(false)
    expect(resultText(traverse)).toContain('Vitest setup (out related)')
  }, 30_000)

  it('answers tool calls loudly when no provider row is mounted', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-memory-loader-'))
    const vault = join(root, 'vault')
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-memory'",
      `  config: { dir: ${JSON.stringify(vault)} }`,
      "- name: '@deepseek-ai/dsh-tool-memory'",
      '',
    ].join('\n'))
    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRuntime],
      ['@deepseek-ai/dsh-memory', MemoryService],
      ['@deepseek-ai/dsh-tool-memory', ToolMemory],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()

    const owner = agent(ctx)
    const failed = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('no-provider'),
      name: 'memory_write',
      arguments: { title: 'T', content: 'C' },
      agent: owner,
    })
    expect(failed.isError).toBe(true)
    expect(resultText(failed)).toContain('no memory provider is registered')
  }, 30_000)
})
