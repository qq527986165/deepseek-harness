# Agent Note: Memory Phase 2 — the automatic lifecycle and the journal append primitive

Status: implemented

English | [中文](2026-08-18-memory-phase-2-automatic-lifecycle.zh.md)

## Problem

The [first-party memory proposal](../../proposed/feature/2026-08-18-first-party-pluggable-memory.md) fixed Phase 2's four behaviors up front — session-start auto-load, every-turn distillation with scope classification, `memory/*` session events, and a guidance section — but left one interface open: appending to a day's journal file needs a primitive that the Phase 1 `write` ("replace by id, wholesale") cannot express. Journal appends must also serialize through the provider's exclusive chain, or two sessions distilling at once would corrupt the same day file. Phase 1's real-chokidar watcher additionally ignored every subdirectory (its `ignored` predicate filtered paths that were not `.md`, and chokidar hands predicates directory paths without stats), so vault subfolders were never actually watched.

## Decision

Phase 2 ships four packages worth of change: service and provider primitives, a new `dsh-memory-lifecycle` consumer package, two `memory/*` session events, one Cordis event, and a guidance section. The four proposal-frozen behaviors are implemented without widening them; the journal append is the one newly designed interface.

### The journal append primitive

`ctx.memory.appendJournal(input, cwd, signal?)` is a service-level method routed by `input.scope` exactly like `write` (`project` requires a resolved workspace). The provider executes it on the target vault's single exclusive chain: it reads the day's `journal/YYYY-MM-DD.md` (creating it with a `type: journal` frontmatter when absent), appends one `## heading` plus markdown body entry, writes the file, and re-indexes it under its `adopted:journal/<date>.md` identity. The day defaults to the UTC date and validates as a real calendar day; titles must be a single non-empty line and bodies non-empty. Concurrent appends therefore serialize instead of interleaving.

The lifecycle's other reads became service primitives beside it: `readPersona(scope, cwd)` reads one vault's `MEMORY.md` whole, `recent(opts, cwd)` lists the project vault's topic notes newest first, and `readInScope(ref, scope, cwd)` resolves within exactly one vault. `MemoryProvider` also owns `commitDistill`, the whole-turn atomic path used for new nodes and their journal entries.

### `memory-lifecycle` — the automation consumer

`@deepseek-ai/dsh-memory-lifecycle` (`packages/memory/memory-lifecycle/`) injects `memory`, `llm`, and `systemPrompt`; all contributions are effects, so disposing the plugin fiber removes every listener and section registration, aborts in-flight work, and drains it. Config fields: `distill`, `distillMode` (`concise` default | `detailed`; selects one of the two fixed distillation instructions), `minTurnChars`, `maxDistillTokens` (default 2048), `distillTimeoutMs`, paired optional `provider`/`model`, `timeZone` (IANA, host time zone by default), `maxInjectBytes`, `maxReviewCandidates` (default 5), and `reviewAfterDays` (default 30). The six user-owned knobs (`distill`, `distillMode`, `minTurnChars`, `maxInjectBytes`, `maxReviewCandidates`, `reviewAfterDays`) register as the `memory-lifecycle` settings namespace and apply live; the token cap, timeout, route, and time zone stay composition config.

- **Session start.** An `agent/session-start` listener reads each resolved scope's `MEMORY.md` in full plus each scope's note catalog (title, tags, updated date, first-line excerpt, newest first), assembles one context text, and hands it to `agent.inject()` — the injected content rides the ordinary `user/message` log event, and a log-only `memory/inject` event records the loaded files, the reason (`start`/`change`), and the byte count. The byte cap applies to the complete assembled text including the truncation marker; the journal never enters the set because listing skips journal rows.
- **Watcher reloads.** `memory-local` reports each watcher-driven reconciliation as the `memory/change` Cordis event (vault directory plus vault-relative changed paths; an empty batch marks the ready-time full pass). The lifecycle tracks each agent's injected files and rebuilds the context when a loaded file changed; content equality against the last injected text makes unchanged rebuilds no-ops, which also makes ready passes harmless.
- **Every-turn distillation.** A `turn/end` listener starts one non-blocking auxiliary `ctx.llm.stream()` call whose messages replay the finished turn (system prompt, tool schemas, and surface messages) with the distillation instruction appended as the final user message — the call is a genuine prefix of the routed request, so the provider's KV cache stays warm (`purpose: 'memory-distill'`, mapped to disabled thinking in `llm-deepseek`). One reply emits candidate topic notes each classified `project`/`global` plus one journal entry; a project-classified candidate in a global-only session degrades to the global vault.
- **Additive atomic commit.** Every durable candidate creates a new short-ID-suffixed node; a same-title predecessor remains unchanged and may be linked by exact path. The host groups candidates by resolved scope and commits all participating vaults together, with one precisely anchored journal entry per scope and exact bidirectional links. The configured IANA time zone selects the journal day, falling back to the host time zone.
- **Commit receipt.** Only after every file, index row, read, and link verifies does the pass append `memory/distill` naming the new nodes, one journal entry per participating scope, and the auxiliary route. Zero candidates write no node, journal, or event; a pre-commit failure restores the whole turn and emits no receipt. A companion invariant validates every `memory/*` record during the append's pre-commit dispatch phase, so a malformed record rejects the append instead of corrupting reconstruction.
- **Review command.** A `memory-review` command (registered only while a command registry is composed) runs one auxiliary call over the project note catalog that proposes project→global upgrade candidates bounded by `maxReviewCandidates`, lands them as the log-only `memory/review` event, and points the command result at that event; the `memoryReview.decide` remote validates the decision against the live session log, promotes accepted notes write-first, and appends `memory/review-decided`.
- **Guidance section.** A short `tool:memory` section (order 114) tells the model to consult memory before assuming past context and to write explicitly when asked or when a durable fact lands.

### The watcher fix

`VaultWatcher.ignored` now excludes only the index file and `.obsidian/`; markdown filtering moved into the `all` event handler, which drops `addDir`/`unlinkDir` events and non-`.md` paths. The predicate compares unix-normalized paths because chokidar hands predicates normalized paths. Reconcile now stores vault-relative forward-slash paths for both native-separator walk entries and absolute watcher batches, keeping `notes/`-prefix queries and collision checks consistent on Windows.

## Consequences

Phase 2 acceptance criterion 10 is pinned by replay-driven assembled coverage: a real `cordis.yml` boots the memory packages through the Loader and drives real agent-loop turns against scripted adapters, showing both persona injections, zero-candidate no-writes/no-event behavior, project/global committed receipts with new nodes and scope-local journal entries, repeated-title predecessor links, configured-calendar selection, and node reconstruction from `memory/distill` alone while journals stay out of the injected set. The provider, service, and lifecycle packages each hold per-file 100% coverage, including HMR/disposal proofs that unloading the lifecycle fiber removes its listeners and section and aborts in-flight work.

## Testing

- **Service and provider:** routing of `readInScope`/`readPersona`/`recent`/`appendJournal` by scope (including `NO_PROJECT_SCOPE` and `NO_PROVIDER`), journal date/title/body validation, concurrent appends serializing into one day file, adopted-notes recency bodies, watcher batch reporting with vault-relative paths, and the real-chokidar `memory/change` emission.
- **Lifecycle:** injection assembly byte caps with multibyte truncation, journal exclusion, watcher reload dedup, distillation route resolution, turn-message collection, minimum-length gating, JSON reply parsing and validation, zero-candidate no-op, scope fallback, whole-turn atomic commit and receipt gating, configured-calendar selection, listener unload, and disposal draining in-flight work.
- **Replay acceptance:** the assembled criterion-10 test above.
- **Invariant:** well-formed `memory/*` records pass; malformed distill receipts, including empty or cross-reference-inconsistent receipts, reject at append.

## Alternatives considered

**Appending inside the provider's `write`.** Rejected: `write` replaces by id and derives topic-note paths from titles; a journal file is dated, append-only, and must not be minted with a note identity.

**Lifecycle-owned file I/O.** Rejected: the lifecycle consumer does not know the vault directories — the service owns which vaults a session may reach — and writing outside the provider's exclusive chain would reintroduce interleaving corruption.

**A second model call for the classifier.** Rejected: the proposal fixes one call per turn, and the classifier needs no more context than the distillation itself.

**Host-side merge or substring suppression.** Rejected: the model proposes only new durable facts, and the host always creates a new node for each accepted candidate. Related facts keep chronology through optional predecessor links instead of merging old files or suppressing same-title candidates.

## Risks

**Distillation cost rides the routed model.** One auxiliary call per turn reuses the session's routed provider/model unless config overrides it; the token cap and minimum-length gate bound the cost, and the config off switch removes it entirely.

**Silent wrong memories.** Auto-written notes are model output; correction paths are Obsidian edits today and Phase 3's review flow. The `memory/distill` write record makes every silent mutation reconstructable regardless.

**Watcher reload noise.** A loaded file's change re-injects its full context message; content equality keeps unchanged rebuilds silent, but frequent edits to an injected note still surface repeatedly — the same tradeoff the AGENTS.md change pattern makes.
