---
name: skill-cleaner
description: "Audit Claude Code skills: loaded roots, duplicate skills, unused skills, prompt-budget costs, compact descriptions."
---

# Skill Cleaner

Use this when trimming skill prompt budget, finding duplicate skills, auditing enabled/disabled skill roots, or deciding which skills/plugins to remove.

## Workflow

1. Run the analyzer from this skill directory or any project root:

```bash
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --months 3
```

Useful variants:

```bash
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --no-logs
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --months 6 --max-log-mb 800 --deep-logs
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --context-tokens 200000 --budget-percent 2 --no-logs
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --root ~/Dropbox/skills --no-logs
node --experimental-strip-types ~/.claude/skills/skill-cleaner/scripts/skill-cleaner.ts --model claude-sonnet-4-6
```

2. Read the report in this order:
- `Skill Budget`: Claude model context size, 2% skills budget, budgeted usage, and pre-budget full-list pressure.
- `Description candidates`: long descriptions where relaxed grammar saves prompt budget.
- `Duplicates`: same skill name or near-identical description/body across Claude Code personal skills, plugin skills, project-local skills, and any extra roots you pass via `--root`.
- `Unused candidates`: no recent `Skill("name")` tool call, `/skill-name` slash mention, `SKILL.md` read, or text mention in recent `~/.claude/projects/**/*.jsonl` session transcripts.
- `Root summary`: where skills came from and whether config marks them disabled.

3. Before deleting or editing:
- Verify the kept copy exists and is loaded.
- Prefer deleting repo-local duplicates when personal `~/.claude/skills/` copies cover them.
- Keep project-local skills when they encode repo-specific policy.
- Preserve trigger nouns in descriptions: product, tool, action, object.

## Analyzer Notes

- Scans `~/.claude/skills/` (personal), `~/.claude/plugins/` (plugin-provided), and `<cwd>/.claude/skills/` (project-local) by default. Extra roots via `--root <path>`.
- Default model: `claude-opus-4-7` (200K context). Override with `--model claude-sonnet-4-6` or `--context-tokens N`. Fallback model registry recognizes "opus", "sonnet", "haiku" substrings.
- Reads `~/.claude/settings.json` to detect `disabledPlugins` and `skills[].enabled=false` entries.
- Realpath-dedupes roots so symlinked dirs do not create false duplicates.
- For duplicate names, reports description/body similarity (Jaccard over normalized words) and suggests deletion candidates only when bodies are near copies. Keep priority defaults: personal `~/.claude/skills/` → plugins → project-local → repo/agent-scripts → other.
- Scans recent `~/.claude/projects/**/*.jsonl` session transcripts by default. Add `--deep-logs` for archived sessions under `~/.claude/_archive/` and `~/.claude/sessions/`.
- Usage evidence is heuristic: `Skill("name")` tool-call form, `/skill-name` slash mentions, `Use $name`/`use name`/`load name`/`read name` text patterns, and paths like `skills/<name>/SKILL.md`.
- Token cost model is the same `ceil(utf8_bytes / 4)` approximation Anthropic uses for rough budgeting — accurate enough for relative comparison, not for exact billing.

## Output Policy

- Suggest first; edit only when the user asks.
- If asked to apply cleanup, make small grouped commits: descriptions, deletes, config disables.
- Do not delete ignored/untracked skill dirs without naming the destination or confirming they are disposable.
