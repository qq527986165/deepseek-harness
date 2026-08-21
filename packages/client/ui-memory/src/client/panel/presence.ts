/**
 * Host-side memory remote presence: the client probes `memory.info()` through
 * the gateway's namespace service and republishes the outcome. Absent (the
 * host composition lacks the memory remote, so the endpoint answers a carrier
 * failure) means the plugin registers no trace; present means the footer
 * button and the panel mount. Re-probes on every connection reset, because a
 * reconnect is the one live signal that can carry a changed host composition.
 * @module @deepseek-ai/dsh-client-ui-memory/client/panel/presence
 */

import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { MemoryRemote } from '../contract/remote.ts'

/** One presence observation: probing, absent (hidden), or present (mounted). */
export type MemoryRemotePresence = 'probing' | 'absent' | 'present'

/**
 * Presence tracker over the memory Remote. Registrations gate on the snapshot
 * flipping to `present`; nothing ever renders an error for an absent remote.
 */
export class MemoryRemotePresenceTracker implements HostObservable<MemoryRemotePresence> {
  private snapshot: MemoryRemotePresence = 'probing'
  private readonly listeners = new Set<() => void>()
  private disposed = false

  /**
   * @param remote - reader resolving the `memory` Remote namespace service.
   * The gateway provides the namespace service one tick before its methods
   * install, so every attempt re-resolves through the reader.
   */
  constructor(private readonly remote: () => MemoryRemote) {}

  /** @returns the current presence (stable reference until it flips). */
  getSnapshot(): MemoryRemotePresence {
    return this.snapshot
  }

  /**
   * Observe presence flips.
   * @param listener - invoked after each change.
   * @returns the disposer removing this listener.
   */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  /** Release listeners; in-flight probes stop publishing. */
  dispose(): void {
    this.disposed = true
    this.listeners.clear()
  }

  /** Run one probe; an info() answer flips present, a failure flips absent. */
  probe(): void {
    if (this.disposed) return
    this.publish('probing')
    const attempt = (): void => {
      if (this.disposed) return
      try {
        void this.remote().info().then((result) => {
          if (this.disposed) return
          this.publish(result.ok ? 'present' : 'absent')
        }, () => {
          // A transport-level rejection (connection dropped mid-probe) also
          // settles the probe absent; connection/reset re-arms it.
          if (this.disposed) return
          this.publish('absent')
        })
      } catch {
        // The client assembly provides the namespace service before its
        // methods install; retry on the next microtask until they do.
        queueMicrotask(attempt)
      }
    }
    attempt()
  }

  /** Re-probe after a connection reset: the host composition may have changed. */
  rearm(): void {
    if (this.disposed) return
    this.probe()
  }

  private publish(next: MemoryRemotePresence): void {
    if (next === this.snapshot) return
    this.snapshot = next
    for (const listener of [...this.listeners]) listener()
  }
}
