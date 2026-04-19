#!/usr/bin/env bun
// llm-terminal-cli — wraps docker/podman to run claude code in container
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const BIN_NAME = "llm-terminal-cli";
const CONFIG_DIR = process.env.LLM_TERMINAL_CONFIG_DIR || join(homedir(), ".config", "llm-terminal-cli");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

type Config = {
  image: string;
  config_dir: string;       // host dir mounted as container $HOME (configs, login, plugins)
  runtime: "auto" | "docker" | "podman";
  selinux: "auto" | "on" | "off";  // adds :Z to mounts
  extra_args: string[];      // extra args appended to runtime run
};

const DEFAULT_CONFIG: Config = {
  image: "ghcr.io/onixldlc/llm-terminal:latest",
  config_dir: join(homedir(), ".local", "share", "llm-terminal-cli", "config"),
  runtime: "auto",
  selinux: "auto",
  extra_args: [],
};

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

function which(bin: string): string | null {
  const r = spawnSync("which", [bin], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function detectRuntime(pref: Config["runtime"]): "docker" | "podman" {
  if (pref === "docker" || pref === "podman") {
    if (!which(pref)) throw new Error(`runtime '${pref}' not found in PATH`);
    return pref;
  }
  // auto: prefer podman if both (rootless safer), else docker
  if (which("podman")) return "podman";
  if (which("docker")) return "docker";
  throw new Error("neither docker nor podman found in PATH");
}

function detectSelinux(pref: Config["selinux"]): boolean {
  if (pref === "on") return true;
  if (pref === "off") return false;
  // auto: check if SELinux enforcing/permissive
  const r = spawnSync("getenforce", [], { encoding: "utf8" });
  if (r.status !== 0) return false;
  const mode = r.stdout.trim().toLowerCase();
  return mode === "enforcing" || mode === "permissive";
}

function getUid(): number { return process.getuid?.() ?? 1000; }
function getGid(): number { return process.getgid?.() ?? 1000; }

function buildRunArgs(opts: {
  runtime: "docker" | "podman";
  cfg: Config;
  selinux: boolean;
  interactive: boolean;
  extraCmdArgs: string[];
}): string[] {
  const { runtime, cfg, selinux, interactive, extraCmdArgs } = opts;
  const cwd = process.cwd();
  const hostConfig = resolve(cfg.config_dir.replace(/^~/, homedir()));

  // ensure host config dir exists
  mkdirSync(hostConfig, { recursive: true });

  const z = selinux ? ":Z" : "";
  const args: string[] = ["run", "-it", "--rm"];

  // user mapping
  if (runtime === "podman") {
    args.push("--userns=keep-id");
  } else {
    args.push("--user", `${getUid()}:${getGid()}`);
  }

  // mounts
  args.push("-v", `${hostConfig}:/home/dev${z}`);
  args.push("-v", `${cwd}:/home/dev/work${z}`);
  args.push("-w", "/home/dev/work");

  // env passthrough
  args.push("-e", `TERM=${process.env.TERM || "xterm-256color"}`);
  if (process.env.ANTHROPIC_API_KEY) {
    args.push("-e", `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY}`);
  }

  // extra args from config
  args.push(...cfg.extra_args);

  // interactive shell vs claude
  if (interactive) {
    args.push("--entrypoint=/bin/bash");
    args.push(cfg.image);
  } else {
    args.push(cfg.image);
    args.push(...extraCmdArgs);
  }

  return args;
}

function printHelp() {
  console.log(`${BIN_NAME} — run Claude Code in a container

Usage:
  ${BIN_NAME}                  Run claude (mount cwd, persist config)
  ${BIN_NAME} -i, --shell      Drop into interactive bash inside container
  ${BIN_NAME} -h, --help       Show this help
  ${BIN_NAME} --config         Print config file path and current values
  ${BIN_NAME} --edit-config    Open config in $EDITOR
  ${BIN_NAME} [...args]        Pass extra args to claude (e.g. ${BIN_NAME} --version)

Config file: ${CONFIG_FILE}
Default host config dir: ${DEFAULT_CONFIG.config_dir}
`);
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv.includes("-h") || argv.includes("--help")) {
    printHelp();
    return;
  }

  const cfg = loadConfig();

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

  const interactive = argv.includes("-i") || argv.includes("--shell");
  const passthrough = argv.filter(a => a !== "-i" && a !== "--shell");

  const runtime = detectRuntime(cfg.runtime);
  const selinux = detectSelinux(cfg.selinux);

  const runArgs = buildRunArgs({ runtime, cfg, selinux, interactive, extraCmdArgs: passthrough });

  if (process.env.LLM_DEBUG) {
    console.error(`[${BIN_NAME}] runtime=${runtime} selinux=${selinux}`);
    console.error(`[${BIN_NAME}] cmd: ${runtime} ${runArgs.join(" ")}`);
  }

  const result = spawnSync(runtime, runArgs, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

main().catch(e => {
  console.error(`[${BIN_NAME}] error: ${e.message}`);
  process.exit(1);
});
