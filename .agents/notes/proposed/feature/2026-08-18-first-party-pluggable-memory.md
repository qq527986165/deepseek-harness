# Agent Note: First-party pluggable memory system

Status: proposed

English | [中文](2026-08-18-first-party-pluggable-memory.zh.md)

## Problem

DSH ships no first-party memory system. The [extension cookbook](../../../../docs/cookbook/extension-cookbook.md) reserves the shape — a system-prompt section provider plus model-facing tools — but no package fills that row. Today's cross-session recall is either the opt-in [`tool-session-query`](../../../../packages/session-query/tool-session-query/README.md) full-text search over past conversations (read-only, cwd-authority-scoped, not mounted by default) or one of the [third-party memory MCP overlays](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md). Both leave the same gap: memory that DSH loads and writes automatically around a session, that lives inside the runtime observability (logged, replayable, projectable), that reuses DSH's compaction for distillation, and whose storage a human can read and edit with everyday tools.

## Proposal

Add a first-party, default-off memory capability as a three-role [capability seam](../../../../docs/architecture.md#capability-seams) under a new `packages/memory/` group: `memory` (Service Definition), `memory-local` (provider: two Obsidian-compatible markdown vaults — one global, one per project — plus a provider-owned SQLite index per vault), and `tool-memory` (Consumer: model tools). Retrieval is file-backed full-text search plus link traversal; no embeddings. The product behavior this seam enables:

- **Auto-load.** When a session starts, the provider injects the global and project persona notes in full plus a note catalog (title, tags, updated date, first-line excerpt) into the first request.
- **Auto-write.** After each user-prompt-to-assistant-answer turn, an auxiliary distillation call either commits one or more new node notes together with their journal entry or writes nothing; a classifier inside the same call routes personal facts and preferences to the global vault and project facts to the project vault.
- **Manage.** A UI panel lists, edits, and later deletes both scopes' notes; a `/memory review` command surfaces global-upgrade candidates.

The storage model follows the file-first memory systems that Claude Code, OpenClaw, and Tencent WorkBuddy demonstrated: human-readable markdown with frontmatter and `[[wikilinks]]`, editable in Obsidian and diffable in git.

## Vault layout and note format

Two symmetric vaults. The global vault lives at `$DSH_HOME/memory/`; the project vault at `<project>/.dsh/memory/`. The product-root-plus-subfolder shape follows `.claude/` (Claude Code) and `.codebuddy/` (WorkBuddy); one provider implementation serves both scopes, and future project-local DSH state has a home beside `memory/`.

The folder name belongs to the capability, not the plugin: plugin identity already lives in the npm package name (`@deepseek-ai/dsh-memory-local`), while the vault path is user data that must survive provider swaps. The sole-provider registration already prevents two memory systems from mounting in one host, and the global `dir` config field is the override when a deployment genuinely needs another location.

```text
$DSH_HOME/memory/          # global scope; project scope: <project>/.dsh/memory/
  MEMORY.md                # persona note: identity, preferences, standing rules
  notes/<title-slug>-<short-id>.md # one new node note per distilled memory unit
  journal/2026-08-18.md    # one local-calendar narrative per active day, linked to node notes
  .memory-index.sqlite     # provider-owned derived state; delete-safe
```

`MEMORY.md` is an ordinary note the provider treats as that scope's persona note; session-start injection reads it whole under a byte cap.

Each note is an Obsidian-compatible markdown file:

```markdown
---
id: 9f3c1c2e-…
scope: project
created: 2026-08-18T10:00:00.000Z
updated: 2026-08-18T10:00:00.000Z
tags: [deepseek, memory]
related:
  - "[[session-query]]"
---

Body text. Facts are stated plainly and may contain [[wikilinks]].
```

A journal file is plain dated markdown:

```markdown
---
type: journal
date: 2026-08-18
---

## Fork sync to upstream
- Merged upstream/master and fixed the node version mismatch.
- Touched facts: [[fork-sync-upstream]]
```

Memory keeps two axes. Node notes under `notes/` hold distilled facts — identity, preferences, decisions — as small lookup units whose body detail follows the `concise`/`detailed` mode. The journal holds the chronological narrative: one file per active local-calendar day, with each remembered turn appending one entry that links to every node created by that turn. Each node links back to that exact journal entry through a stable entry anchor. A day's journal therefore relates to many nodes. A later turn never merges into or rewrites an older node: it creates a new node and journal entry; when the new memory clearly continues an older one, the new node may link to its predecessor while the old file stays unchanged and index backlinks provide the forward path. Node filenames combine the short human summary with a short stable id so repeated summaries cannot collide. The provider indexes markdown files recursively under the vault root, so the `notes/` and `journal/` subfolders are convention, not format rules, and pointing `dir` at an existing markdown folder adopts its files as memory. The provider owns `id`/`created`/`updated` on its own node writes; external edits update the index without the provider rewriting the file. Wikilinks may dangle and traversal marks them unresolved. The plugin never touches git configuration: committing the project vault is the documented way to share team memory, ignoring it keeps memory private.

## Scope resolution

A session's scopes resolve from its `cwd`: a `cwd` whose canonical path matches a registered [`ctx.workspaceRegistry`](../../../../packages/workspace/workspace/README.md) workspace gets that project's vault; sessions without a `cwd` or a workspace get the global vault only. Reads and searches walk the chain project → global, project hits first; links stay scope-local. The global vault is always the second scope, so a global-only session still searches its own memory. Several host-level instances with different `dir` values keep working as independent installations.

## Service interface

`memory` declares `ctx.memory` with branded `MemoryNoteId` and one sole-provider registration modeled on `ctx.sessionTitle.register()` ([session-title](../../../../packages/session/session-title/README.md)): the provider mounts the service and registers its implementation; a second registration fails; disposing the provider aborts its in-flight operations. With no provider registered, tool loading fails loudly.

| Method | Contract |
|---|---|
| `write(input, signal?)` | Create or replace one note by `id` in an explicit `scope` (`project` or `global`); the project scope requires a resolved project vault. Writes the markdown file and the index in one transaction; returns `{ id, scope, title, path, created, updated }`. |
| `read(ref, signal?)` | Resolve a note by `id` or exact title across the session's scope chain; return frontmatter, body, and both link directions. |
| `search(query, opts?, signal?)` | FTS5 over title, tags, and body across the scope chain, project hits ranked first; snippet and tags per hit; item count bounded by provider config, never model-controlled upward. |
| `traverse(ref, opts?, signal?)` | One or two hops from a note over `wikilink` and `related` links, both directions, within the note's scope; bounded node count; dangling links reported. |

Phase 1 adds no `SessionEventMap` members: tool calls and results are already logged. Phase 2 adds `memory/*` events so every distilled write and injected context is reconstructable from the log.

## Model-facing tools

`tool-memory` registers four tools through `defineTool` ([tool authoring reference](../../../../docs/cookbook/adding-a-tool.md)): `memory_write`, `memory_read`, `memory_search`, and `memory_traverse`.

| Tool | Parameters | Canonical output |
|---|---|---|
| `memory_write` | `id?`, `scope?` (`project` default, `global` when no project vault), `title`, `content`, `tags?`, `related?` (wikilink targets) | `{ id, scope, title, path, created, updated }` |
| `memory_read` | `ref` (id or exact title) | `{ note: { id, scope, title, tags, body, related, backlinks } }` |
| `memory_search` | `query`, `limit?` (capped above by config) | `{ hits: [{ id, scope, title, snippet, tags }] }` |
| `memory_traverse` | `ref`, `depth?` (`1` or `2`, default `1`), `kinds?` (`wikilink`/`related`, default both) | `{ start: { id, title }, nodes: [{ id, title, via }] }` |

There is deliberately no `memory_delete` in Phase 1: deletion is a lifecycle decision (review, TTL, link repair) and arrives in Phase 3 with the lifecycle policy. The only model-visible surface in Phase 1 is these four schemas and descriptions — no system-prompt section yet.

## Automatic memory lifecycle

The auto-load and auto-write behaviors are Phase 2, described here to fix the design now:

- **Session start.** A listener on `agent/session-start` reads the global and project `MEMORY.md` in full plus a note catalog of each resolved scope's node notes (title, tags, updated date, first-line excerpt, newest first, byte-capped as one message) and hands them to `agent.inject()`, so the first request sees them as durable injected context — logged as ordinary injected user content, satisfying model-visible-means-logged. A watcher change to a loaded note injects the same way (the AGENTS.md subdirectory-change pattern). The journal stays out of the injected set; recall reaches it through search, and the model fetches full note content on demand through `memory_read`.
- **Every-turn distillation.** A listener on `turn/end` starts one non-blocking auxiliary LLM call over the completed user-prompt-to-assistant-answer turn (the compaction summarizer's architecture: replayed prefix, cache-friendly trailing instruction). The call emits zero or more candidate node notes — facts, decisions, preferences — and classifies each as `project` or `global`: personal identity, preferences, and cross-project rules go global; project facts stay project. Zero candidates discard the whole pass: no node, journal append, or `memory/distill` event is written. Otherwise the lifecycle groups candidates by scope and commits each group's new nodes with one entry in that scope's local-calendar journal; project and global groups never cross-link across vaults. The host, not the model, assigns ids, paths, entry anchors, reciprocal node↔journal links, and optional new-node→predecessor links. One turn is one atomic commit across all participating scopes: any failed write, index update, or read-back/link verification leaves no visible success and is rolled back or completed by recovery. Only after every real file is non-empty, indexed, readable, and reciprocally linked does the lifecycle append `memory/distill`; the event is a commit receipt carrying the stable node refs and exact journal-entry refs, never a progress or partial-failure record.
- **Cost and noise controls.** Distillation is config-gated (on/off, minimum turn length to distill, per-turn token cap, and a `concise`/`detailed` instruction-mode switch); the auxiliary call is one per turn by default.
- **Global hygiene.** `/memory review` (Phase 3) lists project notes the model proposes promoting to global, for the user to confirm; explicit user prompts to remember something always win over the classifier.
- **Guidance section.** Phase 2 adds one short `ctx.systemPrompt.section()` telling the model when to consult and when to write memory explicitly.

## Index and external-edit reconciliation

`memory-local` owns one SQLite index per vault at `.memory-index.sqlite`:

- `notes(id, path, title, created, updated)` — one row per note.
- `links(from_id, to_id, kind)` with `kind IN ('wikilink','related')` — both directions queryable.
- `notes_fts` (FTS5) over title, tags, and body.
- `meta` carrying a monotonic `SCHEMA_VERSION`.

The index is derived state, never authoritative: a version mismatch or a deleted index file triggers a full rebuild from the vault; `:memory:` is supported for tests.

Because humans edit vaults with Obsidian, the provider watches each vault directory with the chokidar discipline of `settings-file` and `credentials-local`: debounced reload, a ready-time reconciliation pass so changes racing watcher startup are not lost, contained watcher errors, and close-before-dispose quiescence. The watcher indexes markdown files only and ignores `.obsidian/` and the index file. Reads also re-check mtimes, so a missed or disabled watcher event reconciles on next use instead of serving stale links.

## Pluggability and unload semantics

Pluggability is the point, and it falls out of DSH's existing rules rather than new machinery:

- **Default-off packages.** None of the three packages joins a shipped composition; mounting is explicit configuration.
- **Optional service.** Third-party consumers read `ctx.get('memory')`; `tool-memory` injects the declared service, so a composition with tools but no provider fails at load — misconfiguration fails loud.
- **Effect-based registration.** Tools, section registrations, and event listeners are `ctx.effect`s: disposing the owning fiber removes them (HMR-safe, covered by the repo's required disposal test).
- **Data survives unload.** Unloading stops watchers and distillation, closes indexes, and unregisters tools. Vault files and index files stay on disk: remounting restores full recall. Data never rides the plugin fiber.

## Phasing

- **Phase 1 (this proposal's build):** the seam, the dual-scope file-first provider with full-text search and links, the four tools, unload semantics.
- **Phase 2:** session-start auto-load, every-turn distillation with the classifier, `memory/*` session events, and the guidance section.
- **Phase 3:** the UI management panel for both scopes (list, read, edit), `/memory review` promotion flow, `memory_delete` with lifecycle policy, and conversation nodes showing distilled writes. The [recallable-compaction note](2026-07-06-recallable-compaction.md) owns the adjacent session-working-memory design; the two remain separate scopes.
- **Phase 4:** an optional semantic-retrieval provider (embeddings) behind the same service. Decided then, not now.

## Alternatives considered

- **Keep the MCP-overlay-only stance** ([third-party memory MCP examples](../../implemented/feature/2026-07-31-third-party-memory-mcp-examples.md)). That note shipped provider overlays and deliberately contains no universal memory service; it stays current and shipped. Rejected here as the first-party answer because MCP memory data stays outside the session log, auto-load and auto-write cannot trigger from session events, and DSH's compaction cannot reach it. This proposal complements, not replaces, the overlays.
- **A single flat global vault.** Rejected: project facts would pollute global recall and cannot follow the project; the dual-scope chain costs one scope-resolution rule the repo already practices (workspace cwd authority).
- **Per-workspace-only memory.** Rejected: persona-level identity and preferences are global by nature, and WorkBuddy's tiering shows both layers earn their keep.
- **Pure daily-log notes (the WorkBuddy file style).** Rejected as the only axis: a journal alone loses precise recall and graph centrality for facts. The hybrid keeps the journal's chronology and narrative while facts stay in linked node notes; its marginal cost is one extra output field in the distillation call the design already pays for.
- **Embedding/vector-first storage as Phase 1.** Rejected: paid or self-hosted dependencies, opaque results, and retrieval-quality work before full-text search plus links have proven insufficient. Phase 4 keeps the door open behind the seam.
- **Notes inside `ctx.storage` KV** ([domain KV storage](../architecture/2026-07-24-domain-kv-storage-and-workspace.md)). Rejected: KV values lose Obsidian compatibility and human editability, which are the point of the file-first model.
- **Fold memory into `session-query`.** Rejected: that seam reads the immutable session log under cwd authority; memory is mutable, user-editable, and cross-session by design.
- **One package, no seam.** Rejected by the capability-seam rule: the Service Definition/Service Provider/Consumer split is what lets Phase 4 swap the retrieval provider without touching tools.
- **A provider-owned JSON store** (the MCP Reference Memory model). Rejected: plain markdown files are more legible, greppable, and Obsidian-compatible.

## Acceptance criteria

1. A keyless test composition boots the three packages through the Loader and drives every tool without a model key; vault files and index rows match after each call, in each scope.
2. Obsidian opens either vault as a valid vault; `[[wikilinks]]` between notes resolve; the watcher ignores `.obsidian/` and the index file.
3. `write` then `read` round-trips one note per scope with stable `id` and provider-owned timestamps; writing without `id` creates a new note; a project-scope write without a resolved project vault fails loudly.
4. `search` returns ranked hits across the scope chain with project hits first; `traverse` returns bounded, scope-local adjacency in both directions and marks dangling links.
5. An external edit to a vault file (no DSH involved) appears in `read`/`search` after reconciliation; an edit racing watcher startup is not lost.
6. Disposing the provider fiber unregisters the tools and closes watchers; vault files and indexes survive; remounting restores the same recall.
7. Two sessions in one host share memory: session A writes, session B reads and searches the note.
8. A missing or unwritable global vault `dir` fails plugin load with a loud error; an unwritable project vault fails loudly when a project-scope write resolves it.
9. Repository gates pass: per-file coverage, HMR-safety/disposal tests, keyless assembled snapshots pinning model-visible schemas and results, package READMEs, invariants, and the subsystem page for the new service.
10. Phase 2 acceptance (recorded now, verified then): replay-driven assembled tests show both persona notes injected at session start; a turn with no durable memory writing no node, journal entry, or event; and a remembered turn atomically creating scope-local node notes plus reciprocal journal-entry links before one `memory/distill` commit receipt appears. A mixed project/global turn commits both vault groups or neither, the event reconstructs every stable ref, a same-kind later memory creates a new predecessor-linked node instead of merging, and the journal stays outside the injected set.

## Risks

- **Vault/index divergence.** External editors and crashes can desynchronize the index; the derived-state design bounds the damage to a rebuild, and mtime re-checks make staleness transient.
- **Concurrent editing and multi-file commit.** Obsidian and git sync may write while distillation stages nodes and journal entries. The provider serializes the whole turn across every participating vault, verifies the staged files and index before publishing the event, and uses recovery metadata to finish or roll back an interrupted commit; external edits still reconcile through the index without silent replacement.
- **Distillation cost and quality.** One auxiliary LLM call per turn is a real per-turn cost; config gates (off switch, minimum turn length, token cap) bound it. Append-only nodes preserve history but can repeat related facts, so predecessor links and later node-oriented views carry the continuity instead of in-place merging.
- **Silent wrong memories.** Auto-written notes can be wrong or stale; the UI panel, `/memory review`, and Obsidian editability are the correction paths, and review of distilled content is the user's ongoing duty.
- **Unbounded growth.** No TTL or cleanup in Phases 1–2; a large vault slows full rebuilds. Phase 3 lifecycle policy addresses it.
- **FTS-only recall.** Substring and token matches miss semantically equivalent wording; accepted until Phase 4 measures the gap.
- **Schema token cost.** Four tool schemas ride every request while mounted; an opt-in package accepts this, and later phases can restrict visibility per session.
- **Scope misattribution.** Sessions without a cwd or workspace fall back to global only; a project opened outside its registered workspace writes no project memory. Documented behavior, not a hidden default.
