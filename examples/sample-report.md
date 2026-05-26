# Sample Skill Cleaner Report

> Excerpt from an actual audit, with skill names and paths anonymised.
> Run `node --experimental-strip-types scripts/skill-cleaner.ts` to produce a real one against your own setup.

```
# Skill Cleaner Report

generated: 2026-05-26T12:50:18.627Z
months_log_window: 3
skills_discovered: 102, considered: 102
  - claude: 70
  - claude-plugin: 28
  - claude-project: 4
log_files_scanned: 234

## Prompt Budget

model: claude-opus-4-7
context_tokens: 200,000 (claude-default:claude-opus-4-7)
2%_budget_tokens: 4,000
rendered_chars_total: 39,781
rendered_tokens_total: 10,004
description_chars_total: 37,640
used_of_2%_budget: 250.1%
used_of_context: 5.0%
effective_context_tokens: 190,000 (95%)
used_of_effective_2%_budget: 263.3%

## Heaviest Skills (by rendered tokens)

- 234 tok | claude | <internal-db-query-skill>
- 232 tok | claude | <video-framework-migration-skill>
- 222 tok | claude | <link-outreach-skill>
- 222 tok | claude | <image-gen-skill>
- 211 tok | claude | <video-composer-skill>
- 209 tok | claude | <blog-engine-skill>
- 200 tok | claude | <chart-renderer-skill>
- 194 tok | claude | <client-analysis-skill>
- 158 tok | claude | <serp-data-skill>
- 153 tok | claude | <ai-search-audit-skill>
  ...

## Long Descriptions (>=200 chars)

- <skill-A> (907 chars, 234 tok)
  current: Use this skill whenever the user wants to query, explore, or pull data from <product>'s database via the <mcp> MCP. Trigger on phrases like ... (905 more chars)
- <skill-B> (896 chars, 232 tok)
  current: Translate an existing <framework-A> composition into a <framework-B> HTML composition. Use ONLY when ... (894 more chars)
- ... (28 long descriptions total)

## Duplicate Names

- access (3 copies)
  keep-default: claude-plugin :: .../external_plugins/discord/skills/access/SKILL.md
  diverged: claude-plugin :: .../external_plugins/imessage/skills/access/SKILL.md  (body=79%, desc=93%)
  delete-candidate: claude-plugin :: .../external_plugins/telegram/skills/access/SKILL.md  (body=95%, desc=93%)
- configure (3 copies)
  keep-default: claude-plugin :: .../external_plugins/discord/skills/configure/SKILL.md
  diverged: claude-plugin :: .../external_plugins/imessage/skills/configure/SKILL.md  (body=37%, desc=63%)
  diverged: claude-plugin :: .../external_plugins/telegram/skills/configure/SKILL.md  (body=81%, desc=94%)

## Unused Candidates (no usage in last 3 months)

- <skill-name> | claude | calls=0, slash=0, reads=0, text=0
- <skill-name> | claude | calls=0, slash=0, reads=0, text=0
- ... (50 unused candidates across video, image, and SEO skill families)

## Roots

- ~/.claude/skills (70 skills, scope=claude)
- ~/.claude/plugins (28 skills, scope=claude-plugin)
- <project>/.claude/skills (4 skills, scope=claude-project)
```

## Reading the report

| Section | What it tells you |
|---|---|
| **Prompt Budget** | How many tokens your skill descriptions are adding to every system prompt, vs the 2% rough convention |
| **Heaviest Skills** | Which individual skills cost the most. Long descriptions are usually trigger-keyword-stuffed and can be trimmed without breaking discovery |
| **Long Descriptions** | Descriptions ≥200 chars. Often the cheapest wins — trim trigger lists, drop redundant examples |
| **Duplicate Names** | Same skill name across multiple roots. Decide which copy is canonical, delete the rest |
| **Near-Identical Bodies** | Different names but the same body — often forks that drifted. Pick one |
| **Unused Candidates** | No usage signal in the last N months. Highest-confidence delete candidates |
| **Roots** | Every skill root the scanner found. Useful for sanity-checking that a project-local root is actually being picked up |
