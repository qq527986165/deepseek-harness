# @deepseek-ai/dsh-memory-remote

English | [中文](README.zh.md)

Browser-facing memory transport: the session-independent `memory` Typert Remote namespace (`list`, `read`, `search`, `write`, `delete`, `info`) over the memory capability seam, and the session-addressed `memoryReview` namespace whose `decide` validates a review against the live session log and promotes accepted notes from the project vault to the global vault. Mounted only in web compositions; without it the browser half (`ui-memory`) hides itself and Phase 2 keeps working.

## Composition

The row joins the memory family in a web composition only:

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
- name: '@deepseek-ai/dsh-memory-remote'
```

The service injects `memory` and `agents`; the gateway discovers both namespaces from the mounted service, and the client-side remote assembly mounts the generated contribution, so `ctx.remote.memory` exists exactly when the host composes this row.

## Namespaces

| Namespace | Methods | Addressing |
|---|---|---|
| `memory` | `info()`, `list`, `read`, `search`, `write`, `delete` | Session-independent; project requests carry an explicit `workspaceDir` resolved through the service's scope chain (non-registered paths fail with `NO_PROJECT_SCOPE`) |
| `memoryReview` | `decide(sessionId, reviewId, decisions)` | Session-addressed; validates against the live session log |

## Behavior

- **Unary convention.** Every method takes one request object (`decide` takes the session id, review id, and decision set) and returns a JSON result; expected business failures on `decide` are result unions with stable codes (`review-not-found`, `review-decided`, `unknown-candidate`, `duplicate-candidate`, `undecided-candidates`, `note-missing`), while service-level failures surface as remote errors.
- **Panel mutations are the console user's acts.** `list`/`read`/`search`/`write`/`delete` execute directly with no approval seam — the approval machinery requires a live agent turn, which session-independent panel operations must not depend on — and record no session events: the vault files plus the index are the record, exactly like external Obsidian edits.
- **Promotion is a move.** `decide` requires the exact live agent, a matching `memory/review` event, and an exact partition of its candidate set. Each accepted note promotes by reading the project note, writing the global note, then removing the project file outright — write first, so a failure never leaves missing content — and the settlement appends `memory/review-decided` to the session log.
- **Decisions serialize per session.** Concurrent `decide` calls on one session run one at a time, so the review-decided check and the promotion commit cannot interleave.
- **Absence is absence.** A web composition without this row serves no `memory/*` descriptors; the browser detects the missing namespace service and hides the panel entry — never an error.

## Model Experience

Indirectly, through the `memory/review-decided` settlement event that chat nodes render when a user decides a review, this service is visible to the model without registering any tools or prompt text of its own.

#### KV Cache effect

No direct invalidation; the lifecycle's auxiliary calls own any prefix impact.

## Known Limitations and Deferred Work

- **Live sessions only** — `decide` appends to the live session log; a review in a cold (persisted-only) session cannot be decided until the session is resumed.
- **No restore primitive** — panel deletion moves files to the sibling trash folder, but restoring them is a hand file move; the watcher re-adopts them.
- **Provider absence renders the panel** — with this row composed but no provider registered, the browser shows a friendly provider-missing banner instead of the list; the remote itself reports `NO_PROVIDER`.
