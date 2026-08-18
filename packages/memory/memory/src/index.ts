/**
 * Memory capability seam: sole-provider registration, session scope resolution,
 * and the write/read/search/traverse service surface. The service owns the
 * product rules (which vaults a session may reach); the registered provider
 * owns file layout and indexing inside each vault.
 * @module @deepseek-ai/dsh-memory
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import z from '@deepseek-ai/schemastery'
import { join, resolve } from 'node:path'
// Type-only: makes `ctx.get('workspaceRegistry')` resolve to the WorkspaceRegistry
// augmentation. The registry stays optional at runtime — see `resolveScopes`.
import type {} from '@deepseek-ai/dsh-workspace'
import type {
  MemoryNote,
  MemoryProvider,
  MemoryScope,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryTraversal,
  MemoryTraverseOptions,
  MemoryWriteInput,
  MemoryWriteResult,
} from './types.ts'

export type {
  MemoryLinkKind,
  MemoryLinkTarget,
  MemoryNote,
  MemoryProvider,
  MemoryScope,
  MemorySearchHit,
  MemorySearchOptions,
  MemoryTraversal,
  MemoryTraversalNode,
  MemoryTraverseOptions,
  MemoryWriteInput,
  MemoryWriteResult,
} from './types.ts'
export { MemoryNoteId } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Machine-routable memory service failures. */
export type MemoryErrorCode =
  | 'DUPLICATE_PROVIDER'
  | 'NO_PROVIDER'
  | 'NO_PROJECT_SCOPE'
  | 'NOT_FOUND'

/** Error carrying a stable {@link MemoryErrorCode}. */
export class MemoryError extends Error {
  constructor(message: string, readonly code: MemoryErrorCode) {
    super(message)
    this.name = 'MemoryError'
  }
}

/** Validated service configuration. */
export interface Config {
  /** Global vault directory; defaults to `memory/` under the harness home. */
  dir?: string
  /** Harness home used when `dir` is omitted; defaults to `$DSH_HOME` or `~/.dsh`. */
  dshHome?: string
}

/** The project vault subpath under a workspace: the capability-level product location. */
export const PROJECT_MEMORY_DIR = '.dsh/memory'

interface ProviderRegistration {
  readonly provider: MemoryProvider
  closing: boolean
}

/** Resolve the global vault directory from config, defaulting under the harness home. */
function resolveGlobalDir(config: Config): string {
  return resolve(config.dir ?? join(resolveDshHome(config.dshHome), 'memory'))
}

/** The project vault directory for one session cwd. */
function projectDir(cwd: string): string {
  return join(cwd, PROJECT_MEMORY_DIR)
}

/**
 * Sole-provider memory service (`ctx.memory`). Without a registered provider
 * every operation fails loudly; scope resolution degrades deliberately to
 * global-only when no workspace registry is composed.
 */
export class MemoryService extends Service {
  static Config: z<Config> = z.object({
    dir: z.string(),
    dshHome: z.string(),
  })

  private readonly globalDir: string
  private registration: ProviderRegistration | undefined
  private readonly inFlight = new Set<Promise<unknown>>()

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'memory')
    this.globalDir = resolveGlobalDir(config)
    ctx.effect(() => async () => {
      await this.drain()
    }, 'memory lifecycle')
  }

  /**
   * Register the sole storage provider. Disposal closes the registration and
   * waits for every tracked in-flight operation before a later provider may
   * register.
   * @param provider - provider implementing the write/read/search/traverse contract.
   * @returns exact Cordis effect disposer, which settles after in-flight calls quiesce.
   */
  register(provider: MemoryProvider): () => Promise<void> {
    this.validateProvider(provider)
    if (this.registration !== undefined) {
      throw new MemoryError('a memory provider is already registered', 'DUPLICATE_PROVIDER')
    }
    const registration: ProviderRegistration = { provider, closing: false }
    const dispose = this.ctx.effect(function* (this: MemoryService) {
      this.registration = registration
      yield async () => {
        registration.closing = true
        await this.drain()
        this.registration = undefined
      }
    }.bind(this), 'memory.register()')
    return dispose
  }

  /**
   * Resolve the scope chain for one session cwd: `['project', 'global']` when
   * the cwd matches a registered workspace, `['global']` otherwise. A missing
   * workspace registry, an unregistered path, or a registry lookup failure all
   * fall back to global-only — scope resolution must never block memory access.
   * @param cwd - session working directory, or `undefined` for global-only sessions.
   * @returns the ordered scope chain, project first.
   */
  async resolveScopes(cwd: string | undefined): Promise<MemoryScope[]> {
    if (cwd === undefined) return ['global']
    const registry = this.ctx.get('workspaceRegistry')
    if (registry === undefined) return ['global']
    try {
      await registry.resolveByPath(cwd)
      return ['project', 'global']
    } catch {
      // Not a registered workspace (missing path, non-directory, or a registry
      // fault): the session keeps global memory only.
      return ['global']
    }
  }

  /**
   * Create or replace one note. `scope: 'project'` requires the caller's cwd
   * to resolve to a registered workspace.
   * @param input - note content; `id` present means replace that note.
   * @param cwd - caller session working directory.
   * @param signal - caller cancellation.
   * @returns the committed note reference.
   */
  async write(input: MemoryWriteInput, cwd: string | undefined, signal?: AbortSignal): Promise<MemoryWriteResult> {
    signal?.throwIfAborted()
    const dir = input.scope === 'project'
      ? await this.projectVaultOrThrow(cwd)
      : this.globalDir
    return this.track(this.expectProvider().write(input, dir, signal))
  }

  /**
   * Read one note by id or exact title across the caller's scope chain.
   * @param ref - note id or exact title.
   * @param cwd - caller session working directory.
   * @param signal - caller cancellation.
   * @returns the resolved note with both link directions.
   */
  async read(ref: string, cwd: string | undefined, signal?: AbortSignal): Promise<MemoryNote> {
    return this.readScoped(ref, await this.dirsFor(cwd), signal)
  }

  /**
   * Ranked full-text search across the caller's scope chain, project hits first.
   * @param query - FTS query terms.
   * @param opts - optional limit, bounded above by provider config.
   * @param cwd - caller session working directory.
   * @param signal - caller cancellation.
   * @returns ranked hits with snippets and tags.
   */
  async search(
    query: string,
    opts: MemorySearchOptions | undefined,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]> {
    return this.searchScoped(query, opts, await this.dirsFor(cwd), signal)
  }

  /**
   * Bounded link adjacency around one note, resolved across the caller's scope
   * chain and traversed within the note's own vault.
   * @param ref - start note id or exact title.
   * @param opts - optional depth (1-2) and link-kind filter.
   * @param cwd - caller session working directory.
   * @param signal - caller cancellation.
   * @returns the start note and its adjacency nodes.
   */
  async traverse(
    ref: string,
    opts: MemoryTraverseOptions | undefined,
    cwd: string | undefined,
    signal?: AbortSignal,
  ): Promise<MemoryTraversal> {
    return this.traverseScoped(ref, opts, await this.dirsFor(cwd), signal)
  }

  /** Resolve the ordered vault directories for one cwd: project first, global last. */
  private async dirsFor(cwd: string | undefined): Promise<string[]> {
    const scopes = await this.resolveScopes(cwd)
    return scopes[0] === 'project' && cwd !== undefined
      ? [projectDir(cwd), this.globalDir]
      : [this.globalDir]
  }

  /** Resolve the project vault for a project-scope write, failing loudly without one. */
  private async projectVaultOrThrow(cwd: string | undefined): Promise<string> {
    if (cwd === undefined) {
      throw new MemoryError('project-scope write requires a session working directory', 'NO_PROJECT_SCOPE')
    }
    const scopes = await this.resolveScopes(cwd)
    if (!scopes.includes('project')) {
      throw new MemoryError(`project-scope write outside a registered workspace: ${cwd}`, 'NO_PROJECT_SCOPE')
    }
    return projectDir(cwd)
  }

  /** Read across an explicit directory chain (test/consumer surface). */
  private readScoped(ref: string, dirs: readonly string[], signal?: AbortSignal): Promise<MemoryNote> {
    signal?.throwIfAborted()
    return this.track(this.expectProvider().read(ref, dirs, signal))
  }

  /** Search across an explicit directory chain (test/consumer surface). */
  private searchScoped(
    query: string,
    opts: MemorySearchOptions | undefined,
    dirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemorySearchHit[]> {
    signal?.throwIfAborted()
    return this.track(this.expectProvider().search(query, opts, dirs, signal))
  }

  /** Traverse around one note across an explicit directory chain (test/consumer surface). */
  private traverseScoped(
    ref: string,
    opts: MemoryTraverseOptions | undefined,
    dirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<MemoryTraversal> {
    signal?.throwIfAborted()
    return this.track(this.expectProvider().traverse(ref, opts, dirs, signal))
  }

  private expectProvider(): MemoryProvider {
    const registration = this.registration
    if (registration === undefined || registration.closing) {
      throw new MemoryError('no memory provider is registered', 'NO_PROVIDER')
    }
    return registration.provider
  }

  private track<T>(promise: Promise<T>): Promise<T> {
    this.inFlight.add(promise)
    void promise.then(
      () => this.inFlight.delete(promise),
      () => this.inFlight.delete(promise),
    )
    return promise
  }

  private async drain(): Promise<void> {
    await Promise.allSettled([...this.inFlight])
  }

  private validateProvider(provider: unknown): asserts provider is MemoryProvider {
    const candidate = provider as Record<string, unknown> | null
    if (candidate === null || typeof candidate !== 'object') {
      throw new Error('memory provider must be an object')
    }
    for (const method of ['write', 'read', 'search', 'traverse']) {
      if (typeof candidate[method] !== 'function') {
        throw new Error(`memory provider must implement ${method}()`)
      }
    }
  }
}

export default MemoryService
