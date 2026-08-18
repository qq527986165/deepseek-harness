# @deepseek-ai/dsh-memory-local

English | [中文](README.zh.md)

File-first memory provider: Obsidian-compatible markdown vaults with a derived SQLite full-text/link index and chokidar reconciliation. Every directory becomes one vault handle whose writes and reconciles run on a single exclusive operation chain. The markdown files are the authoritative data; the index is rebuildable derived state.

## Config

| Field | Meaning | Default |
|---|---|---|
| `watch` | Watch each vault and reconcile external edits | `true` |
| `debounceMs` | Watcher write-settle window in milliseconds | `100` |
| `maxSearchResults` | Search result cap | `20` |
| `maxTraverseNodes` | Traversal node cap | `50` |

## Behavior

- **Two vault shapes.** The service hands this provider explicit directories: the global vault at `$DSH_HOME/memory/` and project vaults at `<project>/.dsh/memory/`. Both are ordinary Obsidian-openable folders: `MEMORY.md`, `notes/` topic notes, and an adoptable `journal/`.
- **Notes are markdown.** A provider write stores frontmatter (`id`, `scope`, `title`, `created`, `updated`, `tags`, `related`) plus body; `[[wikilinks]]` in the body and `related` frontmatter entries become typed link rows. Files without our frontmatter are adopted under a deterministic `adopted:<path>` identity, so any existing markdown folder becomes searchable memory.
- **Journal appends serialize.** `appendJournal` adds one `## heading` entry to the day's `journal/YYYY-MM-DD.md` on the vault's single exclusive chain — concurrent sessions never interleave inside one file — creating the file with a `type: journal` frontmatter when absent. The day defaults to UTC.
- **Lifecycle reads.** `readPersona` reads `MEMORY.md` whole; `recentNotes` lists topic notes under `notes/`, newest first, capped by the config bound.
- **The index is derived state.** `.memory-index.sqlite` holds note rows, a `links` table queried in both directions, and an FTS5 table. A schema-version mismatch or a deleted index file triggers a full rebuild; the index never outranks the files.
- **External edits reconcile.** A chokidar watcher with the settings-file discipline (debounce, ready-time full pass, contained errors, close-before-dispose) keeps the index current; reads also re-check mtimes, and deletions drop rows. Each watcher batch is then reported as `memory/change` with vault-relative paths.
- **Bounded results.** Search returns at most `maxSearchResults` hits (an explicit lower `limit` is honored, an invalid one fails loudly); traversal returns at most `maxTraverseNodes` nodes with a truthful `truncated` flag.
- **Unload keeps data.** Disposal stops watchers, drains operation chains, and closes databases; vault files and index files stay on disk and a remount restores recall.

## Model Experience

Indirectly, through the `tool-memory` consumer: this provider registers no tools and injects no prompt text; it only serves the four service operations.

#### KV Cache effect

No direct invalidation; the tool consumer owns any model-visible surface.

## Known Limitations and Deferred Work

- **Journal files are adopted rows** — journal entries are indexed under their `adopted:journal/<date>.md` identity like any foreign markdown; first-class journal frontmatter parsing is deferred.
- **FTS recall only** — search matches exact terms and phrases, not semantically equivalent wording; an embedding-backed retrieval provider is the deferred Phase 4 slot.
- **No deletion or TTL** — `memory_delete` and lifecycle policy (review, TTL, link repair) arrive in Phase 3; files can still be deleted by hand or through Obsidian and the watcher drops their rows.
- **Full reconciles scan the vault** — a very large adopted folder makes opens and ready passes slower; incremental watcher batches already avoid rescans between them.
