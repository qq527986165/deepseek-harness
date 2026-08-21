// Acceptance criterion 10, replay-driven: a real cordis.yml boots the whole
// memory stack through the Loader and drives real agent-loop turns against a
// scripted adapter. The replay shows (a) session-start injection of both
// persona notes, (b) per-turn distillation writing a project note and
// appending a journal entry that links it, (c) the classifier routing a
// personal fact to the global vault, (d) a memory/distill event reconstructing
// the write, and (e) the journal excluded from the injected set.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { createUserMessage, LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import MemoryService from '@deepseek-ai/dsh-memory'
import * as MemoryLocal from '@deepseek-ai/dsh-memory-local'
import * as ToolMemory from '@deepseek-ai/dsh-tool-memory'
import * as MemoryLifecycle from '@deepseek-ai/dsh-memory-lifecycle'
import { SessionId } from '@deepseek-ai/dsh-session'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LlmRuntime from '@deepseek-ai/dsh-llm'
import { journalDate } from '../src/distill.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const PROVIDER = 'mock'

/** One scripted adapter serving ordinary answers and queued distillation replies. */
class ScriptedAdapter extends LlmAdapter {
  readonly distillReplies: string[] = []
  readonly mainRequests: GenerateOptions[] = []

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: 100_000 } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (options.purpose === 'memory-distill') {
      const reply = this.distillReplies.shift() ?? '{"notes":[],"journal":{"title":"No news","body":"- nothing"}}'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    this.mainRequests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Done.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function textOf(options: GenerateOptions): string {
  return options.messages.map(message => message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join(''))
    .join('\n')
}

async function boot(timeZone: string): Promise<{ ctx: Context; adapter: ScriptedAdapter; cwd: string; globalVault: string }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-memory-lifecycle-loader-'))
  const cwd = join(root, 'work', 'proj')
  const globalVault = join(root, 'home', 'memory')
  const projectVault = join(cwd, '.dsh', 'memory')

  // Seed both persona notes and a foreign journal file that must stay out of
  // the injected set.
  await mkdir(globalVault, { recursive: true })
  await mkdir(projectVault, { recursive: true })
  await mkdir(join(projectVault, 'journal'), { recursive: true })
  await writeFile(join(globalVault, 'MEMORY.md'), '# Persona\nGlobal persona text.\n', 'utf8')
  await writeFile(join(projectVault, 'MEMORY.md'), '# Persona\nProject persona text.\n', 'utf8')
  await writeFile(join(projectVault, 'journal', '1999-01-01.md'), 'SECRET JOURNAL ENTRY\n', 'utf8')

  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    '  config: { agents: [] }',
    "- name: '@deepseek-ai/dsh-memory'",
    `  config: { dir: ${JSON.stringify(globalVault)} }`,
    "- name: '@deepseek-ai/dsh-memory-local'",
    '  config: { watch: false }',
    "- name: '@deepseek-ai/dsh-tool-memory'",
    "- name: '@deepseek-ai/dsh-memory-lifecycle'",
    `  config: { timeZone: ${JSON.stringify(timeZone)} }`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-memory', MemoryService],
    ['@deepseek-ai/dsh-memory-local', MemoryLocal],
    ['@deepseek-ai/dsh-tool-memory', ToolMemory],
    ['@deepseek-ai/dsh-memory-lifecycle', MemoryLifecycle],
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

  // The cwd is a registered workspace: project + global scope chain.
  ctx.provide('workspaceRegistry', {
    resolveByPath: (path: string) => path === cwd
      ? Promise.resolve({ path })
      : Promise.reject(new Error(`no workspace for ${path}`)),
  })

  const adapter = new ScriptedAdapter()
  ctx.llm.registerAdapter([PROVIDER], adapter)
  return { ctx, adapter, cwd, globalVault }
}

describe('memory Phase 2 replay-driven acceptance (proposal criterion 10)', () => {
  it('replays zero, mixed-scope, predecessor, and configured-calendar commits through the real Loader', async () => {
    const epoch = Date.parse('2026-08-20T23:30:00.000Z')
    vi.spyOn(Date, 'now').mockReturnValue(epoch)
    const utcDate = journalDate(epoch, 'UTC')
    const timeZone = ['Pacific/Kiritimati', 'Etc/GMT+12'].find(zone => journalDate(epoch, zone) !== utcDate)!
    const expectedDate = journalDate(epoch, timeZone)
    const { ctx, adapter, cwd, globalVault } = await boot(timeZone)
    const projectVault = join(cwd, '.dsh', 'memory')

    const runTurn = async (agent: ReturnType<typeof ctx.agentLoop.create>, reply: string, prompt: string): Promise<void> => {
      const requestCount = adapter.mainRequests.length
      adapter.distillReplies.push(reply)
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: prompt }],
        source: { kind: 'user' },
      }))
      await vi.waitFor(() => { expect(adapter.mainRequests).toHaveLength(requestCount + 1) }, { timeout: 10_000 })
      await vi.waitFor(() => { expect(adapter.distillReplies).toHaveLength(0) }, { timeout: 10_000 })
      await agent.whenIdle()
    }

    const zeroAgent = ctx.agentLoop.create(SessionId('zero'), { provider: PROVIDER, model: PROVIDER }, { cwd })
    await vi.waitFor(() => { expect(zeroAgent.session.events.some(event => event.type === 'memory/inject')).toBe(true) }, { timeout: 10_000 })
    await runTurn(
      zeroAgent,
      '{"notes":[],"journal":{"title":"No news","body":"- nothing"}}',
      'Answer this ordinary question without anything durable to remember.',
    )
    expect(zeroAgent.session.events.some(event => event.type === 'memory/distill')).toBe(false)
    await expect(readFile(join(projectVault, 'journal', `${expectedDate}.md`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(globalVault, 'journal', `${expectedDate}.md`), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

    const agent = ctx.agentLoop.create(SessionId('acceptance'), { provider: PROVIDER, model: PROVIDER }, { cwd })
    // (a) session-start injection lands before the first request, carrying both
    // persona notes and none of the journal.
    await vi.waitFor(() => { expect(agent.session.events.some(event => event.type === 'memory/inject')).toBe(true) }, { timeout: 10_000 })
    const injectEvent = agent.session.events.findLast(event => event.type === 'memory/inject')
    expect(injectEvent?.type === 'memory/inject' && injectEvent.data).toMatchObject({
      reason: 'start',
      notes: [
        { scope: 'project', path: 'MEMORY.md' },
        { scope: 'global', path: 'MEMORY.md' },
      ],
    })
    // (e) the journal never enters the injected set.
    const refs = injectEvent?.type === 'memory/inject' ? injectEvent.data.notes : []
    expect(refs.some(ref => ref.path.startsWith('journal/'))).toBe(false)

    // One turn atomically commits project and global groups.
    const firstRequestIndex = adapter.mainRequests.length
    await runTurn(agent, JSON.stringify({
      notes: [
        { scope: 'project', title: 'Vitest setup', content: 'We use vitest for tests.', tags: ['testing'], related: [] },
        { scope: 'global', title: 'User prefers green tea', content: 'Prefers green tea over coffee.', tags: [], related: [] },
      ],
      journal: { title: 'Set up tests', body: '- Configured [[Vitest setup]].' },
    }), 'Please set up vitest for this project.')
    await vi.waitFor(() => { expect(agent.session.events.some(event => event.type === 'memory/distill')).toBe(true) }, { timeout: 10_000 })

    // (a) the first request saw both personas as injected context.
    expect(adapter.mainRequests.length).toBeGreaterThanOrEqual(1)
    const firstRequest = textOf(adapter.mainRequests[firstRequestIndex]!)
    expect(firstRequest).toContain('Memory context')
    expect(firstRequest).toContain('## Persona (project)')
    expect(firstRequest).toContain('Project persona text.')
    expect(firstRequest).toContain('## Persona (global)')
    expect(firstRequest).toContain('Global persona text.')
    expect(firstRequest).not.toContain('SECRET JOURNAL ENTRY')

    const distill = agent.session.events.findLast(event => event.type === 'memory/distill')
    expect(distill?.type).toBe('memory/distill')
    const record = distill?.type === 'memory/distill' ? distill.data : undefined
    expect(record).toMatchObject({
      model: { provider: PROVIDER, model: PROVIDER },
      notes: [
        { scope: 'project', title: 'Vitest setup' },
        { scope: 'global', title: 'User prefers green tea' },
      ],
      journals: [
        { scope: 'project', date: expectedDate, path: `journal/${expectedDate}.md` },
        { scope: 'global', date: expectedDate, path: `journal/${expectedDate}.md` },
      ],
    })
    expect(expectedDate).not.toBe(utcDate)
    const projectRef = record!.notes.find(note => note.scope === 'project')!
    const globalRef = record!.notes.find(note => note.scope === 'global')!
    expect(projectRef.path).toMatch(/^notes\/vitest-setup-[a-f0-9]{8}\.md$/)
    expect(globalRef.path).toMatch(/^notes\/user-prefers-green-tea-[a-f0-9]{8}\.md$/)
    const noteFile = await readFile(join(projectVault, projectRef.path), 'utf8')
    expect(noteFile).toContain('We use vitest for tests.')
    const journalText = await readFile(join(projectVault, 'journal', `${expectedDate}.md`), 'utf8')
    expect(journalText).toContain('## Set up tests')
    expect(journalText).toContain(`[[${projectRef.path.slice(0, -3)}|Vitest setup]]`)
    expect(await readFile(join(globalVault, globalRef.path), 'utf8')).toContain('Prefers green tea over coffee.')

    // A later same-title fact creates a new node and links the untouched predecessor.
    const original = await readFile(join(projectVault, projectRef.path), 'utf8')
    await runTurn(agent, JSON.stringify({
      notes: [{ scope: 'project', title: 'Vitest setup', content: 'Coverage now includes lifecycle commits.', tags: [], related: [] }],
      journal: { title: 'Extended tests', body: '- Added coverage.' },
    }), 'Please remember that lifecycle commit coverage was added to vitest.')
    await vi.waitFor(() => { expect(agent.session.events.filter(event => event.type === 'memory/distill')).toHaveLength(2) }, { timeout: 10_000 })
    const secondDistill = agent.session.events.filter(event => event.type === 'memory/distill').at(-1)
    const later = secondDistill?.type === 'memory/distill' ? secondDistill.data.notes[0] : undefined
    expect(later).toMatchObject({
      scope: 'project', title: 'Vitest setup', previous: { id: projectRef.id, path: projectRef.path },
    })
    expect(later!.path).not.toBe(projectRef.path)
    expect(await readFile(join(projectVault, projectRef.path), 'utf8')).toBe(original)
    expect(await readFile(join(projectVault, later!.path), 'utf8')).toContain(`[[${projectRef.path.slice(0, -3)}|Vitest setup]]`)
  }, 60_000)
})
