#!/usr/bin/env bun
// llm-terminal-cli — wraps docker/podman to run claude code in container
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BIN_NAME = "llm-terminal-cli";
const CONFIG_DIR = process.env.LLM_TERMINAL_CONFIG_DIR || join(homedir(), ".config", "llm-terminal-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Config = {
  image: string;
  config_dir: string;
  runtime: "auto" | "docker" | "podman";
  selinux: "auto" | "on" | "off";
  extra_args: string[];
};

const DEFAULT_CONFIG: Config = {
  image: "ghcr.io/onixldlc/llm-terminal:latest",
  config_dir: join(homedir(), ".local", "share", "llm-terminal-cli", "config"),
  runtime: "auto",
  selinux: "auto",
  extra_args: [],
};

// ──────────────── config ────────────────

function loadConfig(): Config {
  if (!existsSync(CONFIG_FILE)) {
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_FILE, JSON.stringify(DEFAULT_CONFIG, null, 2));
    console.error(`[${BIN_NAME}] created default config at ${CONFIG_FILE}`);
    return DEFAULT_CONFIG;
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch (e) {
    console.error(`[${BIN_NAME}] failed to parse ${CONFIG_FILE}, using defaults: ${e}`);
    return DEFAULT_CONFIG;
  }
}

function resolveHostConfig(cfg: Config): string {
  return resolve(cfg.config_dir.replace(/^~/, homedir()));
}

// ──────────────── session tracking ────────────────

// sessions.json maps host cwd -> last session id
type SessionMap = Record<string, string>;

function sessionsFile(cfg: Config): string {
  return join(resolveHostConfig(cfg), "sessions.json");
}

function loadSessions(cfg: Config): SessionMap {
  const f = sessionsFile(cfg);
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, "utf8")); }
  catch { return {}; }
}

function saveSessions(cfg: Config, map: SessionMap): void {
  const f = sessionsFile(cfg);
  mkdirSync(resolveHostConfig(cfg), { recursive: true });
  writeFileSync(f, JSON.stringify(map, null, 2));
}

function getLastSessionId(cfg: Config, cwd: string): string | null {
  return loadSessions(cfg)[cwd] ?? null;
}

function setLastSessionId(cfg: Config, cwd: string, id: string): void {
  const map = loadSessions(cfg);
  map[cwd] = id;
  saveSessions(cfg, map);
}

// discover all sessions for current cwd by scanning claude's session dir
// claude stores at: <config_dir>/.claude/projects/<encoded-path>/<uuid>.jsonl
// inside container cwd is always /home/dev/work → encoded: "-home-dev-work"
function listSessionsForProject(cfg: Config): Array<{ id: string; mtime: Date; size: number }> {
  const projectsDir = join(resolveHostConfig(cfg), ".claude", "projects");
  if (!existsSync(projectsDir)) return [];

  // all projects share the -home-dev-work path inside container
  const encoded = "-home-dev-work";
  const dir = join(projectsDir, encoded);
  if (!existsSync(dir)) return [];

  const out: Array<{ id: string; mtime: Date; size: number }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".jsonl")) continue;
    const id = f.replace(/\.jsonl$/, "");
    const s = statSync(join(dir, f));
    out.push({ id, mtime: s.mtime, size: s.size });
  }
  out.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return out;
}

function isWrapperText(s: string): boolean {
  const t = s.trimStart();
  return t.startsWith("<command-message>")
    || t.startsWith("<command-name>")
    || t.startsWith("<command-args>")
    || t.startsWith("<local-command-caveat>")
    || t.startsWith("<system-reminder>")
    || t.startsWith("<command-stdout>")
    || t.startsWith("<command-stderr>");
}

function sessionPreview(cfg: Config, id: string): string {
  const projectsDir = join(resolveHostConfig(cfg), ".claude", "projects", "-home-dev-work");
  const f = join(projectsDir, `${id}.jsonl`);
  if (!existsSync(f)) return "";
  try {
    const content = readFileSync(f, "utf8");
    // first real user message — skip meta entries and wrapper/caveat text
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const obj = JSON.parse(line);
      if (obj.type !== "user" || !obj.message?.content) continue;
      if (obj.isMeta) continue;
      const c = typeof obj.message.content === "string"
        ? obj.message.content
        : obj.message.content[0]?.text ?? "";
      if (!c || isWrapperText(c)) continue;
      return c.replace(/\s+/g, " ").slice(0, 80);
    }
  } catch { /* ignore */ }
  return "";
}

function sessionMeta(cfg: Config, id: string): { hostCwd?: string; gitBranch?: string } {
  // host cwd — reverse lookup from sessions.json (container cwd is always /home/dev/work)
  const map = loadSessions(cfg);
  let hostCwd: string | undefined;
  for (const [k, v] of Object.entries(map)) {
    if (v === id) { hostCwd = k; break; }
  }

  // gitBranch from jsonl
  let gitBranch: string | undefined;
  const f = join(resolveHostConfig(cfg), ".claude", "projects", "-home-dev-work", `${id}.jsonl`);
  if (existsSync(f)) {
    try {
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!line.trim()) continue;
        const obj = JSON.parse(line);
        if (obj.gitBranch) { gitBranch = obj.gitBranch; break; }
      }
    } catch { /* ignore */ }
  }
  return { hostCwd, gitBranch };
}

// ──────────────── runtime detection ────────────────

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function detectRuntime(pref: Config["runtime"]): "docker" | "podman" {
  if (pref === "docker" || pref === "podman") {
    if (!which(pref)) throw new Error(`runtime '${pref}' not found in PATH`);
    return pref;
  }
  if (which("podman")) return "podman";
  if (which("docker")) return "docker";
  throw new Error("neither docker nor podman found in PATH");
}

function detectSelinux(pref: Config["selinux"]): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  const r = spawnSync("getenforce", [], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const mode = r.stdout.trim().toLowerCase();
  return mode === "enforcing" || mode === "permissive";
}

function getUid(): number { return process.getuid?.() ?? 1000; }
function getGid(): number { return process.getgid?.() ?? 1000; }

// ──────────────── run args builder ────────────────

function buildRunArgs(opts: {
  runtime: "docker" | "podman";
  cfg: Config;
  selinux: boolean;
  interactive: boolean;
  claudeArgs: string[];
}): string[] {
  const { runtime, cfg, selinux, interactive, claudeArgs } = opts;
  const cwd = process.cwd();
  const hostConfig = resolveHostConfig(cfg);

  // only Claude-related paths persist; everything else ephemeral (container --rm wipes it)
  const claudeDir = join(hostConfig, ".claude");
  const claudeJson = join(hostConfig, ".claude.json");
  mkdirSync(claudeDir, { recursive: true });
  if (!existsSync(claudeJson)) writeFileSync(claudeJson, "{}");

  const z = selinux ? ":Z" : "";
  const args: string[] = ["run", "-it", "--rm"];

  if (runtime === "podman") {
    args.push("--userns=keep-id");
  } else {
    args.push("--user", `${getUid()}:${getGid()}`);
  }

  args.push("-v", `${claudeDir}:/home/dev/.claude${z}`);
  args.push("-v", `${claudeJson}:/home/dev/.claude.json${z}`);
  args.push("-v", `${cwd}:/home/dev/work${z}`);
  args.push("-w", "/home/dev/work");

  args.push("-e", `TERM=${process.env.TERM || "xterm-256color"}`);
  if (process.env.ANTHROPIC_API_KEY) {
    args.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  }

  args.push(...cfg.extra_args);

  if (interactive) {
    args.push("--entrypoint=/bin/bash");
    args.push(cfg.image);
  } else {
    args.push(cfg.image);
    args.push(...claudeArgs);
  }

  return args;
}

// ──────────────── help ────────────────

function printHelp() {
  console.log(`${BIN_NAME} — run Claude Code in a container

Usage:
  ${BIN_NAME}                    Resume last session in this dir (or start fresh)
  ${BIN_NAME} --new              Start a new session (don't resume)
  ${BIN_NAME} --sessions         List all sessions for this dir
  ${BIN_NAME} --sessions -v      List sessions with host path + git branch
  ${BIN_NAME} --sessions <id>    Resume specific session by id (or prefix)
  ${BIN_NAME} --remote [args]    Run \`claude remote [args]\` (skips local session resume/tracking)
  ${BIN_NAME} -i, --shell        Drop into interactive bash inside container
  ${BIN_NAME} -h, --help         Show this help
  ${BIN_NAME} --config           Print config file path and current values
  ${BIN_NAME} --edit-config      Open config in $EDITOR
  ${BIN_NAME} [...args]          Pass extra args to claude (e.g. --version)

Session tracking:
  Per-directory. Last session id stored in sessions.json in your config_dir.
  Sessions themselves are stored by claude in config_dir/.claude/projects/.

Config file: ${CONFIG_FILE}
Default host config dir: ${DEFAULT_CONFIG.config_dir}
`);
}

function printSessions(cfg: Config, cwd: string, verbose = false) {
  const sessions = listSessionsForProject(cfg);
  const last = getLastSessionId(cfg, cwd);

  if (sessions.length === 0) {
    console.log("no sessions found.");
    console.log(`(looked in: ${join(resolveHostConfig(cfg), ".claude", "projects", "-home-dev-work")})`);
    return;
  }

  console.log(`sessions (${sessions.length}) — * = last used here:\n`);
  for (const s of sessions) {
    const marker = s.id === last ? "*" : " ";
    const preview = sessionPreview(cfg, s.id) || "(no user message yet)";
    const short = s.id.slice(0, 8);
    const when = s.mtime.toISOString().slice(0, 16).replace("T", " ");
    console.log(`${marker} ${short}  ${when}  ${preview}`);
    if (verbose) {
      const meta = sessionMeta(cfg, s.id);
      const path = meta.hostCwd ?? "(unknown — not tracked in sessions.json)";
      const branch = meta.gitBranch ? ` [${meta.gitBranch}]` : "";
      console.log(`             path: ${path}${branch}`);
    }
  }
  console.log(`\nresume: ${BIN_NAME} --sessions <id-or-prefix>`);
}

function resolveSessionByPrefix(cfg: Config, prefix: string): string | null {
  const all = listSessionsForProject(cfg);
  const matches = all.filter(s => s.id.startsWith(prefix));
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0].id;
  console.error(`[${BIN_NAME}] prefix '${prefix}' ambiguous (${matches.length} matches):`);
  for (const m of matches) console.error(`  ${m.id}`);
  process.exit(1);
}

// ──────────────── main ────────────────

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) { printHelp(); return; }

  const cfg = loadConfig();
  const cwd = process.cwd();

  if (argv.includes("--config")) {
    console.log(`config file: ${CONFIG_FILE}`);
    console.log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (argv.includes("--edit-config")) {
    const editor = process.env.EDITOR || "nano";
    spawnSync(editor, [CONFIG_FILE], { stdio: "inherit" });
    return;
  }

  // --sessions [id]
  const sessionsIdx = argv.indexOf("--sessions");
  if (sessionsIdx !== -1) {
    const verbose = argv.includes("-v") || argv.includes("--verbose");
    const arg = argv[sessionsIdx + 1];
    if (!arg || arg.startsWith("-")) {
      printSessions(cfg, cwd, verbose);
      return;
    }
    // resume specific
    const resolved = resolveSessionByPrefix(cfg, arg);
    if (!resolved) {
      console.error(`[${BIN_NAME}] no session matching '${arg}'`);
      process.exit(1);
    }
    setLastSessionId(cfg, cwd, resolved);
    const runtime = detectRuntime(cfg.runtime);
    const selinux = detectSelinux(cfg.selinux);
    const rest = argv.filter((_, i) => i !== sessionsIdx && i !== sessionsIdx + 1);
    const claudeArgs = ["--resume", resolved, ...rest];
    const runArgs = buildRunArgs({ runtime, cfg, selinux, interactive: false, claudeArgs });
    if (process.env.LLM_DEBUG) console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
    const r = spawnSync(runtime, runArgs, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const interactive = argv.includes("-i") || argv.includes("--shell");
  const forceNew = argv.includes("--new");

  // --remote: translates to `claude remote [args]` — skips local session resume + tracking
  const remoteIdx = argv.indexOf("--remote");
  if (remoteIdx !== -1) {
    const rest = argv.filter((_, i) => i !== remoteIdx);
    const claudeArgs = ["remote", ...rest];
    const runtime = detectRuntime(cfg.runtime);
    const selinux = detectSelinux(cfg.selinux);
    const runArgs = buildRunArgs({ runtime, cfg, selinux, interactive: false, claudeArgs });
    if (process.env.LLM_DEBUG) console.error(`[${BIN_NAME}] remote mode: ${runtime} ${runArgs.join(" ")}`);
    const r = spawnSync(runtime, runArgs, { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }

  const passthrough = argv.filter(a => !["-i", "--shell", "--new"].includes(a));

  // session resolution: --new wins, else last session id if exists
  const claudeArgs: string[] = [];
  if (!interactive && !forceNew) {
    const last = getLastSessionId(cfg, cwd);
    if (last) {
      // verify session file still exists
      const sessionFile = join(resolveHostConfig(cfg), ".claude", "projects", "-home-dev-work", `${last}.jsonl`);
      if (existsSync(sessionFile)) {
        claudeArgs.push("--resume", last);
        if (process.env.LLM_DEBUG) console.error(`[${BIN_NAME}] resuming session ${last}`);
      } else {
        if (process.env.LLM_DEBUG) console.error(`[${BIN_NAME}] stored session ${last} gone, starting fresh`);
      }
    }
  }
  claudeArgs.push(...passthrough);

  const runtime = detectRuntime(cfg.runtime);
  const selinux = detectSelinux(cfg.selinux);
  const runArgs = buildRunArgs({ runtime, cfg, selinux, interactive, claudeArgs });

  if (process.env.LLM_DEBUG) {
    console.error(`[${BIN_NAME}] runtime=${runtime} selinux=${selinux} new=${forceNew}`);
    console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
  }

  const result = spawnSync(runtime, runArgs, { stdio: "inherit" });

  // after exit, if a new session was created, update tracking
  // find most recent session file, if different from what we resumed, save it
  if (!interactive) {
    const sessions = listSessionsForProject(cfg);
    if (sessions.length > 0) {
      const newest = sessions[0].id;
      const last = getLastSessionId(cfg, cwd);
      if (newest !== last) {
        setLastSessionId(cfg, cwd, newest);
        if (process.env.LLM_DEBUG) console.error(`[${BIN_NAME}] saved session ${newest} for ${cwd}`);
      }
    }
  }

  process.exit(result.status ?? 1);
}

main().catch(e => {
  console.error(`[${BIN_NAME}] error: ${e.message}`);
  process.exit(1);
});
