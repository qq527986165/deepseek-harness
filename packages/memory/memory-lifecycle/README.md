# @deepseek-ai/dsh-memory-lifecycle

English | [中文](README.zh.md)

Automatic memory lifecycle consumer over the memory capability seam: session-start context injection, watcher-driven reloads of loaded notes, every-turn distillation with `project`/`global` scope classification and journal appends, the `memory/inject` and `memory/distill` session events, and a short guidance section. The plugin never calls the main loop: it listens on `agent/session-start`, `session/event`, and `memory/change`, and injects through `agent.inject()`.

## Composition

One more cordis.yml row alongside the memory family:

```yaml
- name: '@deepseek-ai/dsh-memory'
  config: { dir: !!js require('node:path').join(process.env.DSH_HOME ?? '~/.dsh', 'memory') }
- name: '@deepseek-ai/dsh-memory-local'
- name: '@deepseek-ai/dsh-tool-memory'
- name: '@deepseek-ai/dsh-memory-lifecycle'
```

The plugin injects `memory`, `llm`, and `systemPrompt`, so a composition without them fails at load.

## Config

| Field | Meaning | Default |
|---|---|---|
| `distill` | Distill finished turns at all | `true` |
| `minTurnChars` | Minimum non-whitespace characters across a finished turn's text to distill | `40` |
| `maxDistillTokens` | Auxiliary distillation output-token cap per turn | `1024` |
| `distillTimeoutMs` | End-to-end auxiliary distillation deadline in milliseconds | `30000` |
| `provider` / `model` | Optional explicit auxiliary route; supplied together, else the session's last routed request is reused | unset |
| `maxInjectBytes` | Maximum UTF-8 bytes of the complete session-start injected context | `16384` |
| `recentNoteCount` | Project topic notes loaded into the injected context, newest first | `10` |

## Behavior

- **Session-start injection.** On `agent/session-start` the plugin reads each scope's `MEMORY.md` plus the project recency window and injects them as one byte-capped context message; the matching `memory/inject` event records the loaded files, the reason, and the byte count. The journal never enters the injected set.
- **Watcher reloads.** When `memory/change` reports a file among an agent's injected set (an empty batch means the ready-time full pass), the plugin rebuilds the context and injects the new version — identical content re-injects nothing.
- **Every-turn distillation.** On `turn/end` one non-blocking auxiliary call reuses the turn's system prompt, tools, and messages as its prefix and appends the distillation instruction, so the provider's KV cache stays warm. One pass emits candidate topic notes — facts, decisions, preferences — each classified `project` or `global` in the same reply, plus one journal entry linking the notes it touched.
- **Merge-don't-restate.** A candidate whose title matches an existing note in its scope appends only new facts and unions tags/links; a candidate that restates the existing body writes nothing. A project-classified candidate in a global-only session lands in the global vault.
- **Journal appends.** The turn's journal entry appends to the day's `journal/YYYY-MM-DD.md` through the provider's exclusive chain, so concurrent sessions serialize instead of corrupting the file.
- **Write record.** After every committed write the pass appends a `memory/distill` event naming the notes, the journal entry, and the auxiliary route; a pass that fails after partial commits records the committed prefix plus the error. Failures with nothing committed log a warning only.
- **Guidance section.** A short `tool:memory` prompt section tells the model to consult memory before assuming past context and to write explicitly when asked or when a durable fact lands.

## Model Experience

### Injected context

#### What the model sees

One user-role message per injection: a `Memory context` block with each scope's persona note under a `## Persona (<scope>)` heading, then a `## Recent project notes` section with up to `recentNoteCount` topic notes (title and body). When the byte cap cuts the text, a truncation marker names the cut.

#### Token effect

Bounded by `maxInjectBytes` (default 16 KiB) per injection; a watcher reload injects only when the loaded content actually changed.

#### KV Cache effect

Injected context is a user message entering the turn batch; it shifts the prefix only when content changes.

### Guidance section

#### What the model sees

The `tool:memory` system-prompt section, rendered in the tool guidance band (order 114).

#### Token effect

One fixed paragraph per request while the plugin is mounted.

#### KV Cache effect

Prefix-stable while the section text is unchanged.

## Known Limitations and Deferred Work

- **Slow first injection may miss the first request** — session-start injection is asynchronous, like other session-start context producers; the first request usually includes it but a slow vault read can land it in the next step.
- **Auxiliary calls ride the routed model** — without `provider`/`model` config the distillation call reuses the session's latest routed request; deployment cost policy belongs to that route.
- **Model-quality ceiling** — the classifier and journal narrative are model outputs; wrong or stale notes are corrected through Obsidian edits or Phase 3's review flow.
- **No recall window growth policy** — notes accumulate without TTL; the Phase 3 lifecycle policy owns cleanup.
