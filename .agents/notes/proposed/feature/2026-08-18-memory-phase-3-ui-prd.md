# Agent Note: Memory Phase 3 UI — PRD and decision record

Status: proposed

English | [中文](2026-08-18-memory-phase-3-ui-prd.zh.md)

## Problem

Phase 2 shipped the automatic mechanism — session-start injection, every-turn distillation with scope classification, journal appends, the `memory/inject` and `memory/distill` session events, and the guidance section — but users see memory only through Obsidian, the `memory_read`/`memory_search` tool results, and the session log. The proposal reserves Phase 3 as the first user-visible surface, and the design discussion for it needs a living record: the frozen scope, the open questions to settle, and every decision as it lands, so development starts only after all open questions are decided and the implementation plan is signed off. Each discussion round appends to the decisions log and re-records the bilingual pair. The design source of truth is the [first-party memory proposal](2026-08-18-first-party-pluggable-memory.md) (`Automatic memory lifecycle`, `Phasing`, `Acceptance criteria`); the shipped Phase 2 baseline is the [automatic lifecycle note](../../implemented/feature/2026-08-18-memory-phase-2-automatic-lifecycle.md).

## Proposal

The Phase 3 window owns exactly five surfaces, from the proposal's Phasing and the original window instructions:

1. **Management panel** for both scopes — list, read, edit global and project notes.
2. **`/memory review`** promotion flow — the model proposes project→global upgrades, the user confirms.
3. **`memory_delete`** with the lifecycle policy — review, TTL, and link repair.
4. **Conversation nodes** showing distilled writes.
5. **Settings page** for the memory mechanism (config surface for users).

Nothing else enters without an explicit user request. The open questions below are the discussion agenda; each settled item moves to the decisions log.

### A. Panel shape and entry points

- Entry: a sidebar slot, a command-bar entry, a workspace panel, or a dedicated route?
- Layout: one panel with scope tabs, or side-by-side with the conversation?
- Listing: sort/group by scope, tags, or updated time; an inline search box wired to `memory_search`?
- Note view: rendered MarkdownText plus an edit mode; what should a `[[wikilink]]` click do (navigate inside the panel, highlight backlinks)?

### B. UI style and copy

- Chinese product copy, `--dsw-*` tokens, CSS Modules, no Tailwind — the repo client rules apply unchanged.
- Visual language follows `ui-workspace`/`ui-settings`; decide card/list density and which frontmatter facts get badges (scope, tags, updated).

### C. Conversation nodes

- A `ConversationNodeDefinition` over the `memory/distill` event family (match/update/state discipline, no full-log scans).
- Presentation: chips per written note that open the panel at that note; the journal entry's links.
- Scope: chat view only, or also the trajectory table?

### D. Commands

- `/memory review` rides `ctx.commands`; what does the confirmation surface look like (candidate cards → confirm/reject), and where does the result land (panel, conversation, or both)?
- Command arguments (scope filter, candidate count)?

### E. Remote surface for the browser

- The panel is browser code: list/read/write/delete need a new Typert Remote service over `ctx.memory`; `message-feedback`'s `@Remote` unary convention is the template.
- Which methods to expose, and how panel mutations authorize — panel operations are session-independent, so the approval flow must not require a live agent turn.

### F. Deletion and lifecycle

- `memory_delete` arguments (ref?) and semantics: physical file removal versus soft delete/recycle.
- Lifecycle policy: TTL defaults, review triggers, and repair of dangling `[[wikilinks]]` after deletion (dangling marks already exist).
- Model deletion authorization: silent versus user-confirmed.

### G. Settings and permissions

- Settings-card fields: `distill` toggle, `minTurnChars`, `maxDistillTokens`, `distillTimeoutMs`, `maxInjectBytes`, `recentNoteCount`, and a read-only vault directory display.
- Whether panel edits and global-vault writes need a permission preset; per-scope visibility rules.

### H. Composition and defaults

- The new `ui-memory` client package joins the web-app bundle: default-visible or opt-in?
- Degradation when no memory provider is mounted.

### I. Verification

- Keyless snapshots for the panel projection, the review flow, and deletion.
- Per-file 100% coverage (client packages are inside the gate), `test:gui`, and the web snapshot pair for visible changes.

## Decisions log

| # | Date | Topic | Decision | Rationale |
|---|---|---|---|---|
| — | — | — | (empty — filled by the discussion window) | — |

## Alternatives considered

- **A generic in-dsh file viewer instead of a dedicated memory panel.** Rejected as the sole surface: the panel must know scope ownership, note identity, and the later promotion/deletion flows, which a generic viewer cannot express. A generic viewer remains a separate plugin decision and is not a Phase 3 dependency; the panel's read/edit view may reuse shared markdown primitives.
- **Obsidian only, no GUI surface.** Rejected: visibility of what was silently distilled and the `/memory review` promotion flow are user-facing promises of the proposal; without a panel they stay invisible outside the vault folders.
- **Config through cordis.yml only, no settings card.** Rejected: deployment-level config already exists, but the window instructions reserve a settings page; a settings card is the repo-standard way to give users the same knobs without editing patch files.

## Acceptance criteria

- The panel lists both scopes, opens a note, and edits persist through the provider's watcher reconciliation.
- `/memory review` shows candidates and a user confirmation promotes a note to the global vault.
- `memory_delete` removes a note with index and link cleanup.
- The conversation node reconstructs from `memory/distill` events alone.
- The settings card changes the deployment-level config fields.
- Repository gates pass: per-file coverage, keyless snapshots, bilingual docs.

## Risks

- **Remote surface widening.** Exposing memory list/write/delete to the browser is the panel's largest new attack surface; the authorization design for session-independent mutations is the riskiest piece and settles first.
- **Deletion irreversibility.** Physical deletes have no recycle bin, and a TTL could destroy user-edited notes if the policy is careless; soft delete or review-first defaults bound the damage.
- **Concurrent edits.** The panel, Obsidian, and distillation can write the same note; the provider guarantees last-write-wins at file level, so the panel must re-read before save and surface the updated timestamp to avoid clobbering.
- **Model-side deletion authority.** A silent `memory_delete` could remove user-edited notes; the authorization model decides whether deletion needs user confirmation.

## Out of scope

- Semantic retrieval (Phase 4).
- A generic in-dsh file viewer (a separate plugin decision, not a Phase 3 blocker).
- Open-sourcing or extracting the plugin (revisit after the plugin is complete).
