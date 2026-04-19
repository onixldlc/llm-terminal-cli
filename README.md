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
llm-terminal-cli                  # run claude code in current dir
llm-terminal-cli -i               # interactive bash inside container (plugin install, debug)
llm-terminal-cli --shell          # alias for -i
llm-terminal-cli --version        # passes --version to claude
llm-terminal-cli --help           # this help
llm-terminal-cli --config         # show current config
llm-terminal-cli --edit-config    # open config in $EDITOR
```

Tip: alias it short.

```bash
alias llm='llm-terminal-cli'
```

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
| `selinux` | `auto` / `on` / `off` | `auto` runs `getenforce`, adds `:Z` to mounts on enforcing/permissive |
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

Push a tag matching `v*`:

```bash
git tag v0.1.0
git push origin v0.1.0
```

CI builds binaries for all platforms and creates a GitHub release.

Manual release: Actions → Release → Run workflow → enter tag.
