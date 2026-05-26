# claude-skill-debloater

**Audit your Claude Code skills. Find out what they actually cost.**

Every Claude Code skill you install adds its description to the system prompt that ships on **every turn**. With a few dozen skills, that's easy to balloon to 10K+ tokens — and you'll never see it unless you look.

`debloater` is a single TypeScript file that walks your skill roots, reads recent session transcripts, and tells you:

- How many tokens your skill descriptions are costing per turn
- Which skills are the heaviest offenders
- Which descriptions are bloated (long trigger lists, redundant examples)
- Which skills haven't been used in N months
- Which skills are duplicated across roots

It does **not** auto-delete anything. It produces a markdown report you read and act on.

## Why this exists

Anthropic's [internal convention](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) is that the skills block should fit in **~2% of the model's context window** — about 4,000 tokens on a 200K-context Claude Opus / Sonnet / Haiku. That's a soft target, not a hard limit; you can blow past it without anything breaking, but the cost is real.

On the author's setup, the first audit returned:

| Metric | Value |
|---|---|
| Skills discovered | **102** |
| Rendered tokens (system prompt) | **10,004** |
| % of 2% notional budget | **250.1%** |
| % of full 200K context | **5.0%** |

That's 10K tokens of trigger-keyword soup riding along on every single request — before the user has even typed anything. Most of it for skills the author hadn't touched in months.

### What that costs

For Claude Code subscribers, the answer is "context room and latency, not money" — the subscription covers usage. But if you were paying API rates instead, here's the magnitude:

| Operation | Opus 4.7 rate | Cost of 10K skill-description tokens |
|---|---|---|
| Cached input read (typical mid-session turn) | $1.50 / M tokens | **$0.015 / turn** |
| Uncached input (cold cache) | $15 / M tokens | **$0.15 / turn** |
| Cache write (first turn of a session) | $18.75 / M tokens | **$0.188 / session** |

A heavy user doing ~100 turns/day across warm sessions: **~$45/month** in skill-description tokens alone, at API rates. Half of that is recoverable just by deleting the skills you don't use.

For subscribers, the equivalent saving is in the form of:

- **Context room** for actual conversation history (5% of context back is meaningful past turn 30)
- **First-token latency** (smaller system prompt = faster TTFB)
- **Cache efficiency** (smaller prefix = less to invalidate when you swap skills mid-session)

## Install

```bash
git clone https://github.com/pmf111/claude-skill-debloater ~/.claude/skills/skill-cleaner
```

Requires Node 22+ (uses `--experimental-strip-types` to run the `.ts` file directly with no compile step).

The script discovers skills across the three default Claude Code roots automatically:

- `~/.claude/skills/` (personal skills)
- `~/.claude/plugins/` (plugin-provided skills, marketplace layout supported)
- `<cwd>/.claude/skills/` (project-local skills)

Extra roots can be passed with `--root <path>`.

## Run

```bash
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts
```

Output goes to stdout. Pipe to a file if you want to keep it:

```bash
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts > skill-audit.md
```

See [`examples/sample-report.md`](examples/sample-report.md) for what the output looks like.

### Common recipes

```bash
# Fast audit (no transcript scan — skips usage detection but ~10x faster)
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --no-logs

# Wider lookback (6 months) + include archived sessions
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --months 6 --deep-logs

# Test budget against Sonnet 1M context
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --model claude-sonnet-1m

# JSON for further processing
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --json --no-logs \
  | jq '.skills[] | select(.scope == "claude") | {name, descChars: (.description | length)}'
```

### All flags

| Flag | Default | Effect |
|---|---|---|
| `--months N` | `3` | log window for usage scan |
| `--no-logs` | off | skip transcript scan (much faster) |
| `--deep-logs` | off | also scan `~/.claude/_archive/` and `~/.claude/sessions/` |
| `--all` | off | include skills marked `enabled: false` in `~/.claude/settings.json` |
| `--json` | off | machine-readable output |
| `--model NAME` | `claude-opus-4-7` | recognises `sonnet` / `haiku` / `sonnet-1m` substrings |
| `--context-tokens N` | from model | override context window |
| `--budget-percent N` | `2` | budget as % of context |
| `--max-log-mb N` | `300` | cap total transcript bytes read |
| `--root PATH` | — | add an extra skill root (repeatable) |

## What it actually does

Five passes, in order:

1. **Discover** all `SKILL.md` files across known roots. Realpath-dedupe so symlinks don't show as duplicates.
2. **Parse frontmatter** (`name`, `description`) and hash the body for similarity matching.
3. **Compute rendered cost** — `ceil(utf8_bytes(rendered_line) / 4)` per skill, summed. This approximates how Claude tokenises the system prompt to within a few %.
4. **Scan recent session transcripts** (`~/.claude/projects/**/*.jsonl`) for usage signals:
   - `"skill":"<name>"` in tool-call JSON
   - `/<name>` slash-command mentions
   - `skills/<name>/SKILL.md` file reads
   - `use|using|load|read <name> skill` natural-language mentions
5. **Cluster** by basename (cross-root duplicates) and body-hash (near-identical forks), then emit a markdown report.

Output sections, in order:

```
## Prompt Budget               <- top-line magnitude
## Heaviest Skills             <- top 20 by rendered tokens
## Long Descriptions           <- candidates for trimming
## Duplicate Names             <- same name across roots
## Near-Identical Bodies       <- different names, same body
## Unused Candidates           <- no recent usage signal
## Roots                       <- where skills were discovered
```

## Notes & caveats

- **Token math is an approximation.** Claude's tokeniser isn't `bytes/4`, but it's close enough for relative comparison and budget headroom. Don't quote the absolute number as gospel; the deltas are reliable.
- **Usage detection is heuristic.** A skill that fires once in conversation might leave no signal in the transcript if the user invokes it implicitly (no `/name`, no `Skill("name")` call). Treat unused candidates as a starting list, not a verdict.
- **Plugin skills are protected.** Marked `claude-plugin` in the report and excluded from the unused list — usually you can't delete those individually anyway, you'd uninstall the whole plugin.
- **Anthropic's 2% convention is soft.** Going over it doesn't break anything; it just means your skills block is competing harder with conversation history for context room. If your skills are genuinely valuable, the cost is fine. The point of the audit is to see *what* you're paying for, not to force a specific budget.

## Acknowledgements

Concept and report structure inspired by [steipete/agent-scripts](https://github.com/steipete/agent-scripts/tree/main/skills/skill-cleaner) — Peter Steinberger's original Codex/OpenClaw tool. `debloater` is a clean reimplementation for Claude Code's filesystem layout, transcript format, plugin marketplace structure, and model context defaults.

## License

[MIT](LICENSE).
