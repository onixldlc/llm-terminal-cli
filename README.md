# llm-terminal-cli

Bun-based CLI wrapper for [llm-terminal](https://github.com/onixldlc/llm-terminal). Runs Claude Code in a container with auto-detected runtime (docker/podman), UID mapping, and SELinux support.

## Install

### From release (recommended)

Grab the binary for your platform from [Releases](../../releases/latest):

```bash
# Linux x64
curl -L -o llm-terminal-cli https://github.com/onixldlc/llm-terminal-cli/releases/latest/download/llm-terminal-cli-linux-x64
chmod +x llm-terminal-cli
sudo mv llm-terminal-cli /usr/local/bin/
# or: install -m 755 llm-terminal-cli ~/.local/bin/

# macOS arm64 (Apple Silicon)
curl -L -o llm-terminal-cli https://github.com/onixldlc/llm-terminal-cli/releases/latest/download/llm-terminal-cli-darwin-arm64
chmod +x llm-terminal-cli && sudo mv llm-terminal-cli /usr/local/bin/
```

Available targets: `linux-x64`, `linux-arm64`, `darwin-x64`, `darwin-arm64`, `windows-x64`.

### From source

```bash
git clone https://github.com/onixldlc/llm-terminal-cli
cd llm-terminal-cli
bun install
bun run install-local   # → ~/.local/bin/llm-terminal-cli
```

## Usage

```bash
llm-terminal-cli                    # resume last session in this dir (or start fresh)
llm-terminal-cli --new              # start a new session (don't resume)
llm-terminal-cli --sessions         # list all sessions for this dir
llm-terminal-cli --sessions <id>    # resume specific session (id or prefix)
llm-terminal-cli --secure           # don't mount cwd + least privilege (config still mounted)
llm-terminal-cli --read-only        # mount cwd read-only
llm-terminal-cli -i                 # interactive bash inside container (plugin install, debug)
llm-terminal-cli --shell            # alias for -i
llm-terminal-cli --version          # passes --version to claude
llm-terminal-cli --help             # this help
llm-terminal-cli --config           # show current config
llm-terminal-cli --edit-config      # open config in $EDITOR
```

### Isolation flags

- `--secure` — host cwd is **not** mounted, so the container starts with an empty
  workdir and can't touch your files. Config dir is still mounted, so auth and
  session resume keep working. Also adds `--cap-drop=ALL` and
  `--security-opt=no-new-privileges`. Combinable with `-i`.
- `--read-only` — host cwd mounted `:ro` (`:ro,z` under SELinux). Container can
  read your files but not write them. Config dir stays writable.

Tip: alias it short.

```bash
alias llm='llm-terminal-cli'
```

### Sessions

Per-directory session tracking. The CLI remembers the last session id used in each host directory and auto-resumes on next run.

```bash
cd ~/coding/project-a
llm                          # first run: creates session abc123
# ...do stuff, exit

llm                          # second run: auto-resumes abc123
llm --new                    # ignore last, start fresh session def456
llm --sessions               # list all sessions, * marks last used here
llm --sessions abc           # resume abc123 (prefix match)
```

Session list output:

```
sessions (3) — * = last used here:

* 95979a7c  2026-04-19 17:42  help me debug this auth middleware
  abc12345  2026-04-19 16:10  write a bun cli wrapper
  def67890  2026-04-18 22:33  explain webpack loaders
```

Sessions stored by claude in `config_dir/.claude/projects/-home-dev-work/<uuid>.jsonl`. Per-directory mapping stored in `config_dir/sessions.json`.

## Config

Auto-created on first run at `~/.config/llm-terminal-cli/config.json`:

```json
{
  "image": "ghcr.io/onixldlc/llm-terminal:latest",
  "config_dir": "/home/USER/.local/share/llm-terminal-cli/config",
  "runtime": "auto",
  "selinux": "auto",
  "extra_args": []
}
```

| Field | Values | Notes |
|-------|--------|-------|
| `image` | string | Container image to run |
| `config_dir` | path | Host dir mounted as container `$HOME`. Login, plugins, history persist here. Shared across all invocations. |
| `runtime` | `auto` / `docker` / `podman` | `auto` prefers podman if both installed |
| `selinux` | `auto` / `on` / `off` | `auto` runs `getenforce`, adds shared `:z` to mounts on enforcing/permissive so sessions can run concurrently |
| `extra_args` | string[] | Extra args appended to runtime, e.g. `["--network=host"]` |

## Plugin install (one-time)

```bash
llm-terminal-cli -i
# inside container:
claude plugin marketplace add JuliusBrussee/caveman
claude plugin install caveman@caveman
exit
```

Plugins persist in `config_dir/.claude/plugins/`, auto-loaded next run.

## Debug

```bash
LLM_DEBUG=1 llm-terminal-cli
```

Prints detected runtime + full command before exec.

## Override config dir per-invocation

```bash
LLM_TERMINAL_CONFIG_DIR=/tmp/test-cfg llm-terminal-cli
```

## Releasing

Change the `VERSION` file on `main`, from a local commit or GitHub's web editor:

```text
v0.2.4-r3
```

CI builds binaries for all platforms, creates the git tag, and publishes a GitHub release. No manual tag needed. Use a new value each time, because reusing one updates that existing release.

Manual release: Actions → Release → Run workflow. Leave version empty to read `VERSION`, or uncheck publish to build only.
