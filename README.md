# ai_tools

Development of AI tools in order to improve development quality and better AI usage.

## Prompt router — Phase 1: measure

A Claude Code `UserPromptSubmit` hook that reads every prompt you submit, classifies
it with **zero-cost code heuristics**, and appends one JSONL record saying what it
would have recommended — the model, the effort level, and whether the work belongs
outside the session at all.

**It recommends nothing to anybody and changes nothing.** That is the point of this
phase. A router needs thresholds, and thresholds need a log of real prompts, the
decisions actually taken, and what the rules would have said. The two sibling
projects that already do this kind of thing both learned it the same way:
`triagem_vagas` states it outright — *"o ponto não é o fluxo, é a medição"* — and the
Jev prototype in `portal_brasileirao` measured itself against zero-cost regex before
anyone wired it in, and found the regex still winning.

So: no model is called here. Not Claude, not Jev. Phase 2 earns that with this log.

| File | What it is |
|---|---|
| `prompt-router-core.ts` | pure: facts, heuristics, thresholds, the decision. No network, no clock, no filesystem — `tests/` enforces it by reading the source |
| `router-log.ts` | the I/O half: where the record goes, and the few things the router must leave the module to learn |
| `user-prompt-submit.ts` | the hook entry. Reads stdin, appends one line, always exits 0 |
| `tests/prompt-router-core.test.ts` | fixed inputs, one case per branch, each verified by deleting its rule and watching the test go red |

### Running it

No build step and no runtime dependencies: Node strips the types itself (stable
since Node 23; this repo is tested on Node 26). That is why every module here uses
erasable syntax only — no enums, no namespaces, no parameter properties — and imports
its neighbours with the `.ts` extension.

```bash
npm test                                   # 18 tests, ~90 ms
echo '{"prompt":"formata o arquivo"}' | node user-prompt-submit.ts --dry-run
```

Register it in `~/.claude/settings.json`. The path must be absolute: the hook runs
with the working directory of whichever project submitted the prompt.

```json
"UserPromptSubmit": [
  { "hooks": [{ "type": "command",
                "command": "node /home/mpb/Documents/GitHub/ai_tools/user-prompt-submit.ts",
                "timeout": 5 }] }
]
```

Measured cost: **~80 ms per prompt**, of which ~60 ms is Node stripping the types of
these three modules and ~20 ms is Node starting at all. If that ever matters,
precompiling to JS is the fix; at 80 ms it does not.

### Switches

| Variable | Default | Effect |
|---|---|---|
| `PROMPT_ROUTER_LOG` | `~/.claude/prompt-router/records.jsonl` | where records go |
| `PROMPT_ROUTER_LOG_TEXT` | on | `0` keeps only the SHA-256 and a 200-character preview |
| `PROMPT_ROUTER_ADVISE` | off | `1` prints one advisory line per prompt, to `systemMessage` — the human sees it, the model does not |
| `PROMPT_ROUTER_EFFORT` | read from `settings.json` | the effort level to treat as the session default |

Advice is off by default, and even switched on it never writes to
`additionalContext`. A hook that alters the conversation it is measuring corrupts the
measurement it exists to produce.

### The log holds your prompts in full

By default, because an eval set cannot be built from hashes. It lives under
`~/.claude/`, outside this repository, but it is still plain text on disk — and
anything you paste into a prompt lands there too, keys and customer names included.
`PROMPT_ROUTER_LOG_TEXT=0` reduces it to a hash and a preview.

### What it decides, and why in that order

1. **Effort before model.** Prompt caches are model-scoped, so switching models
   mid-conversation forfeits the cache — which is what actually dominates a Claude
   Code session's bill. Effort trades quality for tokens *within* one model.
2. **Route before model.** The real saving is moving bulk and one-shot work out of the
   interactive session entirely, not shaving the session's per-token rate.
3. **Model last**, and only for work that has already left the session.

Low classifier confidence keeps the session default and records `fellBack: true`,
never a cheaper guess: a cheap route that needs a retry costs more than the
expensive one taken once. A high fallback rate is itself a Phase 2 finding.

The four routes are `in_session`, `headless_cheap` (`claude -p --model …`),
`deterministic_script`, and `n8n_webhook` — the last one being the shape the live
`triagem_vagas` flow already serves at `127.0.0.1:5678`.

### Heuristics

Bilingual on purpose: prompts here are written in pt-BR and English
interchangeably, and a router that only read English would mis-score half of them.
Patterns match conjugation stems (`avali\w*`, `format\w*`) because whole-word
Portuguese verbs miss most of their own forms.

`isBulk` is a flag, not a task kind. A batch of judgments is still judgment, and
while `bulk` competed in the argmax every judgment-heavy batch classified as
`design` and skipped the batch routes silently.

`HEURISTICS_VERSION` is written into every record. A log that cannot say which rules
produced it cannot be re-scored later, which is most of why it is kept.

### Known limits

- Heuristics only. Every reading here is regex over one prompt, with no session
  history, no repository facts, and no model.
- `estTokens` is `chars / 3.5`, the ratio the Jev cost note uses. The real number
  needs `messages.count_tokens`, which needs the network.
- No git facts. `git status` per prompt would cost more than the whole hook, for a
  signal whose predictive value is unmeasured.
- `actual.model` is only as good as `ANTHROPIC_MODEL`; `actual.effort` is read from
  the global setting and is wrong for a session that changed it. The authoritative
  record is the transcript, whose path every record carries — that is the join
  Phase 2 uses.
