# @deepseek-ai/dsh-memory-lifecycle

English | [中文](README.zh.md)

Automatic memory lifecycle consumer over the memory capability seam: session-start context injection, watcher-driven reloads of loaded notes, every-turn distillation with `project`/`global` scope classification and journal appends, the `/memory-review` promotion flow, the `memory/inject`, `memory/distill`, `memory/review`, and `memory/review-decided` session events, a short guidance section, and the settings namespace host half. The plugin never calls the main loop: it listens on `agent/session-start`, `session/event`, and `memory/change`, and injects through `agent.inject()`.

## Composition

One more cordis.yml row alongside the memory family:

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
```

The plugin injects `memory`, `llm`, and `systemPrompt`, so a composition without them fails at load. The review command registers only while a command registry is composed, and the settings namespace registers only while a settings service is composed; neither is required.

## Config

| Field | Meaning | Default |
|---|---|---|
| `distill` | Distill finished turns at all | `true` |
| `distillMode` | Which fixed distillation instruction the auxiliary call uses: `concise` or `detailed` | `concise` |
| `minTurnChars` | Minimum non-whitespace characters across a finished turn's text to distill | `40` |
| `maxDistillTokens` | Auxiliary output-token cap per turn (hidden circuit breaker, also applied to review calls) | `2048` |
| `distillTimeoutMs` | End-to-end auxiliary call deadline in milliseconds | `30000` |
| `provider` / `model` | Optional explicit auxiliary route; supplied together, else the session's last routed request is reused | unset |
| `timeZone` | IANA time zone used to select the distillation journal day | host time zone |
| `maxInjectBytes` | Maximum UTF-8 bytes of the complete session-start injected context | `16384` |
| `maxReviewCandidates` | Cap on project→global upgrade candidates one `/memory-review` proposes | `5` |
| `reviewAfterDays` | Age in days after which the panel marks a note with a review badge | `30` |

The settings card edits `distill`, `distillMode`, `minTurnChars`, `maxInjectBytes`, `maxReviewCandidates`, and `reviewAfterDays` through the `memory-lifecycle` settings namespace and applies changes live; the token cap, timeout, and route stay deployment config in `cordis.yml`.

## Behavior

- **Session-start injection.** On `agent/session-start` the plugin reads each scope's `MEMORY.md` in full plus every scope's note catalog (title, tags, updated date, first-line excerpt, newest first) and injects them as one byte-capped context message; the matching `memory/inject` event records the loaded files, the reason, and the byte count. The journal never enters the injected set.
- **Watcher reloads.** When `memory/change` reports a file among an agent's injected set (an empty batch means the ready-time full pass), the plugin rebuilds the context and injects the new version — identical content re-injects nothing.
- **Every-turn distillation.** On `turn/end` one non-blocking auxiliary call reuses the turn's system prompt, tools, and messages as its prefix and appends the mode-selected distillation instruction, so the provider's KV cache stays warm. One pass emits candidate topic notes — facts, decisions, preferences — each classified `project` or `global` in the same reply, plus one journal entry linking the notes it touched.
- **Additive nodes.** Every durable candidate creates a new short-ID-suffixed node. A same-title predecessor remains unchanged and the new node links to its exact path; a project-classified candidate in a global-only session lands in the global vault.
- **Atomic journal commit.** One turn groups candidates by resolved scope and commits all participating vaults together. Each group appends one precisely anchored entry to the configured time zone's `journal/YYYY-MM-DD.md`; the new nodes and entry link to each other by exact path and anchor, and no link crosses vaults.
- **Commit receipt.** Only after files, index rows, reads, and links all verify does the pass append one `memory/distill` receipt naming the new nodes, one journal entry per participating scope, and the auxiliary route. Zero candidates write no node, journal, or event; any pre-commit failure rolls the whole turn back and emits no receipt.
- **`/memory-review`.** The command runs one auxiliary call over the project vault's note catalog that proposes project→global upgrade candidates, bounded by `maxReviewCandidates`; the proposal lands as the log-only `memory/review` event and the conversation node renders it. The command takes no arguments, requires a project workspace, and settles through the `memoryReview.decide` remote, which appends `memory/review-decided`.
- **Guidance section.** A short `tool:memory` prompt section tells the model to consult memory before assuming past context and to write explicitly when asked or when a durable fact lands.

## Model Experience

### Injected context

#### What the model sees

One user-role message per injection: a `Memory context` block with each scope's persona note under a `## Persona (<scope>)` heading, then a `## Memory note catalog` section whose entries render title, scope, tags, updated date, and first-line excerpt. When the byte cap cuts the text, a truncation marker names the cut.

#### Token effect

Bounded by `maxInjectBytes` (default 16 KiB) per injection; a watcher reload injects only when the loaded content actually changed. The catalog trades bytes for breadth — the model fetches full note content on demand through `memory_read`.

#### KV Cache effect

Injected context is a user message entering the turn batch; it shifts the prefix only when content changes.

### Guidance section

#### What the model sees

The `tool:memory` system-prompt section, rendered in the tool guidance band (order 114).

#### Token effect

One fixed paragraph per request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the section text is unchanged.

### Distillation and review instructions

#### What the model sees

The final user message of each auxiliary call: one of the two fixed distillation instructions selected by `distillMode` (both texts are pinned verbatim by tests), or the fixed review instruction plus the project note catalog.

#### Token effect

Auxiliary-call-local; bounded by `maxDistillTokens`.

#### KV Cache effect

The distillation call is a genuine prefix of the routed request, so the provider's KV cache stays warm.

## Known Limitations and Deferred Work

- **Slow first injection may miss the first request** — session-start injection is asynchronous, like other session-start context producers; the first request usually includes it but a slow vault read can land it in the next step.
- **Auxiliary calls ride the routed model** — without `provider`/`model` config the auxiliary calls reuse the session's latest routed request; deployment cost policy belongs to that route.
- **Model-quality ceiling** — the classifier and journal narrative are model outputs; wrong or stale notes are corrected through Obsidian edits or the `/memory-review` promotion flow.
- **No automatic deletion** — `reviewAfterDays` only marks stale notes in the panel; deleting them stays a human decision.
