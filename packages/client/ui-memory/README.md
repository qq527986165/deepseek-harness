# @deepseek-ai/dsh-client-ui-memory

English | [中文](README.zh.md)

The browser half of the memory feature: the sidebar foot action and the `shell.overlay` drawer over the `memory` Remote (`info`, `list`, `read`, `search`, `write`, `delete`), the memory-lifecycle settings card (namespace `memory-lifecycle`), and the two conversation nodes — `memory-review` over the session-addressed `memoryReview.decide` Remote, and `memory-distill` over the log-only `memory/distill` write records. The panel lists both vaults with scope tabs, a project workspace picker, ranked search, and a compact two-line list; notes open into a `MarkdownText` read view with backlinks, resolved and dangling link marks, and a field-based edit form that re-reads before save and surfaces the changed timestamp on conflict. Deletion confirms, then soft-deletes into the vault's sibling trash folder. The review node renders one `/memory-review` proposal as candidate cards with per-card accept/reject and panel-jump chips; one explicit confirm settles the whole review, and the appended `memory/review-decided` flips every card to its settled mark. The distill node renders one committed receipt as one chip per real node and never renders journal, progress, failure, or partial-write chips.

## Composition

The row ships in the web-app bundle by default and hides itself while the host composition lacks the memory remote:

```yaml
- id: ui-memory
  name: '@deepseek-ai/dsh-client-ui-memory'
```

Presence rides one boot-time `memory.info()` probe through the gateway's namespace service; absent means no trace (no footer button, no drawer), and a reconnect re-probes. With the remote composed but no storage provider registered, the panel shows a friendly provider-missing banner.

## Behavior

- **Four-tier degradation.** No memory rows, or memory rows without `memory-remote`, render no trace (no footer button, no drawer, no conversation nodes); `memory-remote` without a provider shows the banner; everything composed renders the full panel and both nodes. The settings card always registers and the plugins tab skips it while the host serves no `memory-lifecycle` namespace.
- **Console user authority.** Panel reads and writes execute directly over the remote with no approval seam — the console user is the authority, and the service-layer checks (sole provider, workspace-gated project scope) are the boundary. Panel mutations record no session events: the vault files plus the index are the record.
- **Forwarded reconciliation.** The forwarded `memory/change` event reloads the active list when its vault directory matches, so external Obsidian edits and watcher reconciliation feed the UI.
- **Scope addressing.** The project tab lists through the selected registered workspace directory; a missing or unregistered directory stays idle instead of surfacing `NO_PROJECT_SCOPE`. Node-driven open requests carry the review's `workspaceDir` or the distill node's session cwd, so jumps land on the exact project vault.
- **Conflict-aware save.** Saving re-reads the note; a changed `updated` timestamp blocks the write once and shows the changed-elsewhere notice, and the next save commits (overwrite). Adopted files (`adopted:*` ids, journal opens) render read-only without edit or delete affordances.
- **Staged review settle.** The review node folds the `memory/review` start and the `memory/review-decided` update into one Context under the branded `reviewId`. Accept/reject and accept-all stage one partition; the confirm submits it through `memoryReview.decide` only once every candidate is decided, so a last-click accident cannot commit the promotion. Business failures (review gone, already decided, unknown/duplicate candidates, undecided remainder, missing note) each render their own line.
- **Single-event distill fold.** The distill node keys one Context per committed `memory/distill` receipt by `event.seq` — the event carries the complete verified checkpoint, so the node rebuilds from the log alone with no update path. It renders one chip per real committed node; each chip opens that exact Node Memory document. Journal entries are reachable through the node's source links, and empty or failed passes produce no distill node.

## Settings card

The card edits the six user knobs of the memory-lifecycle namespace — `distill`, `distillMode`, `minTurnChars`, `maxInjectBytes`, `maxReviewCandidates`, `reviewAfterDays` — through the revision-fenced settings scope, and shows the read-only global vault directory from `memory.info()`. Changes apply live: the lifecycle re-reads its resolved config per use.

## Model Experience

Indirectly, through the host halves this panel drives: its settings writes feed the memory-lifecycle resolved config (injection content and distillation), and panel mutations append no session events. The review node consumes the log-only `memory/review` and `memory/review-decided` events and drives `memoryReview.decide`; the decide remote's promotion (read project → write global → delete project) never enters a model request.

#### KV Cache effect

No direct invalidation; the lifecycle's auxiliary calls own any prefix impact.

## Known Limitations and Deferred Work

- **In-memory only** — the panel stores viewing state per page load; scope, workspace, and open note do not survive a reload.
- **No restore primitive** — deletion moves files to the sibling trash folder, but restoring them is a hand file move; the watcher re-adopts them.
- **Per-open adjacency cost** — the read view resolves each body wikilink with one remote read, so a note with many links pays one call per link.
- **One-shot review** — the review node settles through exactly one decide call; after the settlement lands there is no re-open path, and the candidate jump is only meaningful while the project note still exists.
- **Project-scope chip jumps need a session cwd** — the distill chip resolves project notes through the owning conversation node's session cwd; without a registered project cwd, the host degrades project-classified candidates to global before committing.
