/**
 * The registrant-private open-request source: conversation nodes publish one
 * request, the panel entry's inject hooks compartment binds it as
 * useMemoryPanelOpen, and the panel acknowledges (clears) it after handling.
 * A bare observable with one publisher per plugin application — nodes reach
 * it through their own inject faces, never by mounting the panel store.
 * @module @deepseek-ai/dsh-client-ui-memory/client/panel/open-source
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryPanelOpenRequest } from '../contract/slots.ts'

/** One-request publisher consumed by the panel and fed by the conversation nodes. */
export class MemoryPanelOpenSource implements HostObservable<MemoryPanelOpenRequest | null> {
  private request: MemoryPanelOpenRequest | null = null
  private readonly listeners = new Set<() => void>()

  /** @returns the latest unacknowledged request, or null. */
  getSnapshot(): MemoryPanelOpenRequest | null {
    return this.request
  }

  /**
   * Observe request arrivals and clears.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /**
   * Publish one open request, replacing any unacknowledged one.
   * @param request - the request the panel should handle.
   */
  publish(request: MemoryPanelOpenRequest): void {
    this.request = request
    for (const listener of [...this.listeners]) listener()
  }

  /** Clear the current request after the panel handled it. */
  clear(): void {
    if (this.request === null) return
    this.request = null
    for (const listener of [...this.listeners]) listener()
  }
}
