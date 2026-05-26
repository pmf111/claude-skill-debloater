#!/usr/bin/env -S node --experimental-strip-types
// Audit Claude Code skills across all loaded roots.
// Reports prompt-budget cost, duplicate skills, unused skills, long descriptions.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

type Skill = {
  name: string;          // display name; "<plugin>:<base>" for plugin skills
  baseName: string;      // raw `name:` from frontmatter (or parent dir)
  description: string;
  body: string;
  path: string;
  realPath: string;
  root: string;
  scope: "claude" | "claude-plugin" | "claude-project" | "extra";
  enabled: boolean;
  bodyHash: string;
  bodyKey: string;       // normalized words for similarity
};

type Usage = { skillCall: number; slash: number; fileRead: number; text: number };

const HOME = os.homedir();
const CWD = process.cwd();
const argv = process.argv.slice(2);
const argSet = new Set(argv);
const argVal = (name: string, fallback: string) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1]! : fallback;
};
const argAll = (name: string) =>
  argv.flatMap((a, i, all) => (a === name && all[i + 1] !== undefined ? [all[i + 1]!] : []));

const MONTHS = Number(argVal("--months", "3"));
const NO_LOGS = argSet.has("--no-logs");
const DEEP_LOGS = argSet.has("--deep-logs");
const INCLUDE_DISABLED = argSet.has("--all");
const JSON_OUT = argSet.has("--json");
const MODEL = argVal("--model", "claude-opus-4-7");
const CONTEXT_TOKENS = Number(argVal("--context-tokens", "0"));
const BUDGET_PCT = Number(argVal("--budget-percent", "2"));
const MAX_LOG_BYTES = Number(argVal("--max-log-mb", "300")) * 1024 * 1024;
const CUTOFF_MS = Date.now() - Math.max(0, MONTHS) * 31 * 24 * 60 * 60 * 1000;
const EXTRA_ROOTS = argAll("--root").map(expandHome);

function expandHome(p: string): string {
  return p.replace(/^~(?=$|[/\\])/, HOME);
}
function exists(p: string): boolean {
  try { fs.accessSync(p); return true; } catch { return false; }
}
function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}
function tokenCost(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}
function fnv1a(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
function normalize(input: string): string {
  return input.toLowerCase().replace(/[`"'’().,;:!?/\\[\]{}_-]+/g, " ").replace(/\s+/g, " ").trim();
}
function wordSet(input: string): Set<string> {
  return new Set(normalize(input).split(" ").filter((w) => w.length >= 2));
}
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let hit = 0;
  for (const x of a) if (b.has(x)) hit++;
  return hit / (a.size + b.size - hit);
}
function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
function pct1(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
function num(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

// --- Discovery ----------------------------------------------------------------

function discoverRoots(): string[] {
  const byReal = new Map<string, string>();
  for (const candidate of [
    path.join(HOME, ".claude/skills"),
    path.join(HOME, ".claude/plugins"),
    path.join(CWD, ".claude/skills"),
    ...EXTRA_ROOTS,
  ]) {
    if (!exists(candidate)) continue;
    let real: string;
    try { real = fs.realpathSync(candidate); } catch { continue; }
    const existing = byReal.get(real);
    if (!existing || candidate.length < existing.length) byReal.set(real, candidate);
  }
  return [...byReal.values()].sort();
}

function scopeForRoot(root: string): Skill["scope"] {
  const p = toPosix(root);
  const home = toPosix(HOME);
  if (p === `${home}/.claude/plugins` || p.startsWith(`${home}/.claude/plugins/`)) return "claude-plugin";
  if (p === `${home}/.claude/skills` || p.startsWith(`${home}/.claude/skills/`)) return "claude";
  if (p.includes("/.claude/skills")) return "claude-project";
  return "extra";
}

function pluginPrefix(file: string): string | null {
  const parts = file.split(path.sep);
  const pluginsIdx = parts.indexOf("plugins");
  if (pluginsIdx <= 0 || parts[pluginsIdx - 1] !== ".claude") return null;
  const skillsIdx = parts.lastIndexOf("skills");
  if (skillsIdx <= pluginsIdx) return null;
  return parts[skillsIdx - 1] ?? null;
}

function walkSkillMd(root: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string, depth: number) => {
    if (depth > 12) return;
    let real: string;
    try { real = fs.realpathSync(dir); } catch { return; }
    if (seen.has(real)) return;
    seen.add(real);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name === "node_modules" || e.name === ".git") continue;
      const f = path.join(dir, e.name);
      if (e.isDirectory() || e.isSymbolicLink()) {
        try { if (fs.statSync(f).isDirectory()) visit(f, depth + 1); } catch {}
      } else if (e.isFile() && e.name === "SKILL.md") {
        out.push(f);
      }
    }
  };
  if (exists(root)) visit(root, 0);
  return out;
}

function parseFrontmatter(file: string): { name?: string; description?: string; body: string } | null {
  const text = fs.readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return null;
  const fm: string[] = [];
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") { end = i; break; }
    fm.push(lines[i] ?? "");
  }
  if (end < 0) return null;
  const sanitize = (s: string) => s.replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  const unquote = (s: string) => {
    const t = s.trim();
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) return t.slice(1, -1);
    return t;
  };
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < fm.length; i++) {
    const line = fm[i] ?? "";
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "name") name = sanitize(unquote(m[2] ?? ""));
    if (m[1] === "description") {
      const raw = (m[2] ?? "").trim();
      if (raw === "|" || raw === ">") {
        const block: string[] = [];
        for (let j = i + 1; j < fm.length; j++) {
          if (/^[A-Za-z0-9_-]+:\s*/.test(fm[j] ?? "")) break;
          block.push((fm[j] ?? "").replace(/^\s{2}/, ""));
        }
        description = sanitize(block.join(" "));
      } else {
        description = sanitize(unquote(raw));
      }
    }
  }
  return { name, description, body: lines.slice(end + 1).join("\n") };
}

function readDisabled(): { plugins: Set<string>; paths: Set<string> } {
  const plugins = new Set<string>();
  const paths = new Set<string>();
  const settings = path.join(HOME, ".claude/settings.json");
  if (!exists(settings)) return { plugins, paths };
  try {
    const j = JSON.parse(fs.readFileSync(settings, "utf8")) as Record<string, unknown>;
    const disabled = (j.disabledPlugins ?? []) as unknown;
    if (Array.isArray(disabled)) for (const item of disabled) if (typeof item === "string") plugins.add(item);
    const skills = j.skills as Record<string, { enabled?: boolean; path?: string }> | undefined;
    if (skills) for (const v of Object.values(skills)) {
      if (v?.enabled === false && typeof v.path === "string") paths.add(expandHome(v.path));
    }
  } catch {}
  return { plugins, paths };
}

function discoverSkills(): { skills: Skill[]; roots: string[] } {
  const roots = discoverRoots();
  const { plugins: disabledPlugins, paths: disabledPaths } = readDisabled();
  const byReal = new Map<string, Skill>();
  for (const root of roots) {
    for (const file of walkSkillMd(root)) {
      const parsed = parseFrontmatter(file);
      if (!parsed) continue;
      const baseName = parsed.name || path.basename(path.dirname(file));
      const prefix = pluginPrefix(file);
      const name = prefix ? `${prefix}:${baseName}` : baseName;
      const description = parsed.description ?? "";
      const bodyKey = normalize(parsed.body);
      const skill: Skill = {
        name,
        baseName,
        description,
        body: parsed.body,
        path: file,
        realPath: fs.realpathSync(file),
        root,
        scope: scopeForRoot(root),
        enabled: !disabledPaths.has(file) && !(prefix && disabledPlugins.has(prefix)),
        bodyHash: fnv1a(bodyKey),
        bodyKey,
      };
      const existing = byReal.get(skill.realPath);
      if (!existing || skill.path.length < existing.path.length) byReal.set(skill.realPath, skill);
    }
  }
  return { skills: [...byReal.values()], roots };
}

// --- Budget -------------------------------------------------------------------

function modelContext(): { tokens: number; source: string; effectivePct: number | null } {
  if (CONTEXT_TOKENS > 0) return { tokens: CONTEXT_TOKENS, source: "--context-tokens", effectivePct: null };
  const lower = MODEL.toLowerCase();
  // Claude Sonnet 4.6: 200K default, 1M with beta header. Opus 4.7: 200K. Haiku 4.5: 200K.
  if (lower.includes("sonnet") && lower.includes("1m")) return { tokens: 1_000_000, source: "claude-sonnet-1m", effectivePct: 95 };
  return { tokens: 200_000, source: `claude-default:${MODEL}`, effectivePct: 95 };
}

function skillLine(skill: Skill): string {
  // Approximation of how Claude Code injects skills into the system prompt.
  return skill.description ? `- ${skill.name}: ${skill.description}\n` : `- ${skill.name}\n`;
}

// --- Usage scanning -----------------------------------------------------------

function recentLogs(): string[] {
  if (NO_LOGS) return [];
  const out = new Set<string>();
  const roots = [path.join(HOME, ".claude/projects")];
  if (DEEP_LOGS) {
    roots.push(path.join(HOME, ".claude/_archive"), path.join(HOME, ".claude/sessions"));
  }
  const visit = (dir: string, depth: number) => {
    if (depth > 8) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const f = path.join(dir, e.name);
      let stat: fs.Stats;
      try { stat = fs.statSync(f); } catch { continue; }
      if (e.isDirectory()) {
        if (depth > 0 && stat.mtimeMs < CUTOFF_MS) continue;
        visit(f, depth + 1);
      } else if (e.isFile() && stat.mtimeMs >= CUTOFF_MS && (f.endsWith(".jsonl") || f.endsWith(".log"))) {
        out.add(f);
      }
    }
  };
  for (const r of roots) if (exists(r)) visit(r, 0);
  return [...out].sort();
}

function tally(values: string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1);
  return m;
}

function scanUsage(skills: Skill[], logs: string[]): Map<string, Usage> {
  const usage = new Map<string, Usage>();
  const aliases = new Map<string, string[]>();
  for (const s of skills) {
    usage.set(s.name, { skillCall: 0, slash: 0, fileRead: 0, text: 0 });
    const set = new Set([s.name, s.baseName, s.name.split(":").at(-1) ?? s.name]);
    aliases.set(s.name, [...set].map((a) => a.toLowerCase()));
  }
  let consumed = 0;
  for (const file of logs) {
    let text = "";
    try {
      const stat = fs.statSync(file);
      if (stat.size > 150 * 1024 * 1024) continue;
      if (consumed + stat.size > MAX_LOG_BYTES) break;
      consumed += stat.size;
      text = fs.readFileSync(file, "utf8");
    } catch { continue; }
    // Claude Code transcripts encode Skill tool calls as JSON: "skill":"<name>".
    // Also keep the literal Skill("<name>") form for prose mentions.
    const callCounts = tally([
      ...[...text.matchAll(/"skill"\s*:\s*"([A-Za-z][A-Za-z0-9_.:-]{0,80})"/g)].map((m) => (m[1] ?? "").toLowerCase()),
      ...[...text.matchAll(/Skill\(\s*["']([A-Za-z][A-Za-z0-9_.:-]{0,80})["']/g)].map((m) => (m[1] ?? "").toLowerCase()),
    ]);
    const slashCounts = tally(
      [...text.matchAll(/(?:^|\s)\/([A-Za-z][A-Za-z0-9_.:-]{1,80})\b/g)].map((m) => (m[1] ?? "").toLowerCase()),
    );
    const pathCounts = tally(
      [...text.matchAll(/skills[/\\]([^/\\"'`\s]+)[/\\]SKILL\.md/g)].map((m) => (m[1] ?? "").toLowerCase()),
    );
    const textCounts = tally(
      [...text.matchAll(/\b(?:use|using|load|read|invoke|run)\s+`?(?:the\s+)?([A-Za-z][A-Za-z0-9_.:-]{1,80})`?\s+skill\b/gi)]
        .map((m) => (m[1] ?? "").toLowerCase()),
    );
    for (const [name, names] of aliases) {
      const u = usage.get(name);
      if (!u) continue;
      for (const candidate of names) {
        u.skillCall += callCounts.get(candidate) ?? 0;
        u.slash += slashCounts.get(candidate) ?? 0;
        u.fileRead += pathCounts.get(candidate) ?? 0;
        u.text += textCounts.get(candidate) ?? 0;
      }
    }
  }
  return usage;
}

// --- Reporting ----------------------------------------------------------------

function similarity(a: Skill, b: Skill): { description: number; body: number; overall: number } {
  const description = jaccard(wordSet(a.description), wordSet(b.description));
  const body = a.bodyHash === b.bodyHash ? 1 : jaccard(wordSet(a.bodyKey), wordSet(b.bodyKey));
  return { description, body, overall: 0.8 * body + 0.2 * description };
}

function keepPriority(skill: Skill): number {
  // Lower = stronger preference to KEEP.
  if (skill.scope === "claude") return 1;
  if (skill.scope === "claude-plugin") return 2;
  if (skill.scope === "claude-project") return 3;
  return 4;
}

function preferredKeep(skills: Skill[]): Skill {
  return [...skills].sort((a, b) => {
    const p = keepPriority(a) - keepPriority(b);
    if (p !== 0) return p;
    return a.realPath.length - b.realPath.length || a.realPath.localeCompare(b.realPath);
  })[0]!;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const item of items) m.set(key(item), [...(m.get(key(item)) ?? []), item]);
  return m;
}

function render(skills: Skill[], usage: Map<string, Usage>, logs: string[], roots: string[]): string {
  const considered = skills.filter((s) => INCLUDE_DISABLED || s.enabled);
  const ctx = modelContext();
  const budgetTokens = Math.floor(ctx.tokens * (BUDGET_PCT / 100));
  const linesByScope = groupBy(considered, (s) => s.scope);

  const totalDescChars = considered.reduce((sum, s) => sum + [...s.description].length, 0);
  const totalRenderedTokens = considered.reduce((sum, s) => sum + tokenCost(skillLine(s)), 0);
  const totalRenderedChars = considered.reduce((sum, s) => sum + skillLine(s).length, 0);

  const longDescriptions = [...considered]
    .filter((s) => [...s.description].length >= 200)
    .sort((a, b) => [...b.description].length - [...a.description].length)
    .slice(0, 25);

  const byBase = [...groupBy(considered, (s) => s.baseName.toLowerCase()).entries()]
    .filter(([, list]) => list.length > 1)
    .sort((a, b) => b[1].length - a[1].length);

  const byBody = [...groupBy(considered, (s) => s.bodyHash).entries()]
    .filter(([hash, list]) => list.length > 1 && hash !== fnv1a(""))
    .sort((a, b) => b[1].length - a[1].length);

  const unused = considered
    .filter((s) => s.scope !== "claude-plugin")
    .filter((s) => {
      const u = usage.get(s.name);
      return !u || (u.skillCall + u.slash + u.fileRead + u.text) === 0;
    })
    .sort((a, b) => a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name))
    .slice(0, 80);

  const out: string[] = [];
  out.push("# Skill Cleaner Report", "");
  out.push(`generated: ${new Date().toISOString()}`);
  out.push(`cwd: ${CWD}`);
  out.push(`months_log_window: ${MONTHS}`);
  out.push(`skills_discovered: ${skills.length}, considered: ${considered.length}`);
  for (const [scope, list] of [...linesByScope.entries()].sort()) {
    out.push(`  - ${scope}: ${list.length}`);
  }
  out.push(`log_files_scanned: ${logs.length}`, "");

  out.push("## Prompt Budget", "");
  out.push(`model: ${MODEL}`);
  out.push(`context_tokens: ${num(ctx.tokens)} (${ctx.source})`);
  out.push(`${BUDGET_PCT}%_budget_tokens: ${num(budgetTokens)}`);
  out.push(`rendered_chars_total: ${num(totalRenderedChars)}`);
  out.push(`rendered_tokens_total: ${num(totalRenderedTokens)}`);
  out.push(`description_chars_total: ${num(totalDescChars)}`);
  out.push(`used_of_${BUDGET_PCT}%_budget: ${pct1(totalRenderedTokens / budgetTokens)}`);
  out.push(`used_of_context: ${pct1(totalRenderedTokens / ctx.tokens)}`);
  if (ctx.effectivePct) {
    const eff = Math.floor(ctx.tokens * (ctx.effectivePct / 100));
    const effBudget = Math.floor(eff * (BUDGET_PCT / 100));
    out.push(`effective_context_tokens: ${num(eff)} (${ctx.effectivePct}%)`);
    out.push(`used_of_effective_${BUDGET_PCT}%_budget: ${pct1(totalRenderedTokens / effBudget)}`);
  }
  out.push("");

  out.push("## Heaviest Skills (by rendered tokens)", "");
  const heaviest = [...considered]
    .map((s) => ({ skill: s, cost: tokenCost(skillLine(s)) }))
    .sort((a, b) => b.cost - a.cost)
    .slice(0, 20);
  for (const { skill, cost } of heaviest) {
    out.push(`- ${num(cost)} tok | ${skill.scope} | ${skill.name}`);
    out.push(`  ${skill.path}`);
  }
  out.push("");

  out.push("## Long Descriptions (>=200 chars)", "");
  if (longDescriptions.length === 0) out.push("- none");
  for (const s of longDescriptions) {
    out.push(`- ${s.name} (${[...s.description].length} chars, ${num(tokenCost(skillLine(s)))} tok)`);
    out.push(`  path: ${s.path}`);
    out.push(`  current: ${s.description}`);
  }
  out.push("");

  out.push("## Duplicate Names", "");
  if (byBase.length === 0) out.push("- none");
  for (const [name, list] of byBase.slice(0, 40)) {
    const keep = preferredKeep(list);
    out.push(`- ${name} (${list.length} copies)`);
    out.push(`  keep-default: ${keep.scope} :: ${keep.path}`);
    for (const s of list) {
      if (s.realPath === keep.realPath) continue;
      const sim = similarity(keep, s);
      const verdict = sim.body >= 0.95 || (sim.body >= 0.85 && sim.description >= 0.85) ? "  delete-candidate" : "  diverged";
      out.push(`${verdict}: ${s.scope} :: ${s.path}  (body=${pct(sim.body)}, desc=${pct(sim.description)})`);
    }
  }
  out.push("");

  out.push("## Near-Identical Bodies", "");
  if (byBody.length === 0) out.push("- none");
  for (const [, list] of byBody.slice(0, 20)) {
    out.push(`- ${list.map((s) => s.name).join(", ")}`);
    for (const s of list) out.push(`  - ${s.scope} :: ${s.path}`);
  }
  out.push("");

  out.push(`## Unused Candidates (no usage in last ${MONTHS} months)`, "");
  if (unused.length === 0) out.push("- none");
  for (const s of unused) {
    const u = usage.get(s.name) ?? { skillCall: 0, slash: 0, fileRead: 0, text: 0 };
    out.push(`- ${s.name} | ${s.scope} | calls=${u.skillCall}, slash=${u.slash}, reads=${u.fileRead}, text=${u.text}`);
    out.push(`  ${s.path}`);
  }
  out.push("");

  out.push("## Roots", "");
  for (const r of roots) {
    const count = skills.filter((s) => s.root === r).length;
    out.push(`- ${r} (${count} skills, scope=${scopeForRoot(r)})`);
  }
  return out.join("\n");
}

// --- Main ---------------------------------------------------------------------

const { skills, roots } = discoverSkills();
const logs = recentLogs();
const usage = scanUsage(skills, logs);

if (JSON_OUT) {
  console.log(JSON.stringify({
    skills,
    usage: Object.fromEntries(usage),
    logs,
    roots,
    context: modelContext(),
  }, null, 2));
} else {
  console.log(render(skills, usage, logs, roots));
}
