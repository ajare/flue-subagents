# Podman

Build from the application's checkout:

```sh
podman build -t flue-subagents .
```

Podman supports the standard `Dockerfile` and `.dockerignore` included here.
The base image uses a fully qualified registry name to avoid short-name prompts.
The image includes Node 24, npm, Git and CA certificates, and runs as the
non-root `node` user by default. It executes TypeScript sources directly.
It does not include local model configuration, credentials or the target
repository. Install additional language runtimes, build tools or optional CLIs
(such as `gh` for GitHub issue lookup) in a derived image as needed.

## Helper scripts

The scripts work from any working directory:

```sh
/path/to/flue-subagents/scripts/podman-build.sh
/path/to/flue-subagents/scripts/podman-run.sh /path/to/trusted/repo \
  "Explain the architecture. Do not modify files or create commits." --json
```

`podman-build.sh` accepts additional build options (such as `--no-cache`).
`podman-run.sh` requires a repository directory and one quoted, nonempty prompt;
remaining arguments are agent options. It mounts the checkout at `/repo`, maps
your UID/GID with `--userns keep-id`, and creates private persistent storage
outside the repository. Run rootless, without `sudo`.

| Environment variable | Default / purpose |
| --- | --- |
| `FLUE_PODMAN_IMAGE` | `flue-subagents` (used by both scripts) |
| `FLUE_PODMAN_STATE_DIR` | `${XDG_DATA_HOME:-$HOME/.local/share}/flue-subagents-podman` |
| `FLUE_AGENT_ENDPOINT` | `http://host.containers.internal:8731/v1` |
| `FLUE_AGENT_MODEL` | `halogen/qwen-3.8-flash-next` |
| `FLUE_PODMAN_ENV_FILE` | Optional Podman `--env-file` for credentials, Git identity and runtime settings |

An env file is passed at runtime, never included in the image. When one is
provided, the scripts do not supply default model/endpoint overrides; explicit
`FLUE_AGENT_ENDPOINT` and `FLUE_AGENT_MODEL` shell variables still take precedence.
Other shell variables, including API keys, are not automatically forwarded. Keep
credential files outside the repository and restrict their permissions.
For custom mounts, host networking or management commands, use the manual
commands below. Model configuration endpoint caveats below also apply to scripts.

## Start with a repository and prompt

On Linux with a POSIX shell, select an existing **trusted, clean Git checkout**
and a private state directory outside that checkout:

```sh
REPO=/absolute/path/to/trusted/repository
STATE="$HOME/.local/share/flue-subagents-podman"
mkdir -p "$STATE/home" "$STATE/runs"
chmod 700 "$STATE"

podman run --rm --init -i --stop-timeout 60 \
  --userns keep-id --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$REPO,target=/repo,relabel=private" \
  --mount "type=bind,source=$STATE,target=/data,relabel=private" \
  -e FLUE_AGENT_ENDPOINT=http://host.containers.internal:8731/v1 \
  -e FLUE_AGENT_MODEL=halogen/qwen-3.8-flash-next \
  flue-subagents \
  "Explain this repository's architecture and test workflow. Do not modify files or create commits."
```

Replace the final quoted argument with your task, for example:

```text
Fix the parser bug described in issue 123 and add regression tests. Run the relevant tests, obtain independent review, and report the changes and validation results. Do not create a commit.
```

Podman performs the bind mounts at startup; the Dockerfile cannot mount a host
path itself. The entrypoint automatically executes:

```sh
node /opt/flue-subagents/src/cli.ts --repo /repo "<your prompt>"
```

Arguments after the image name are passed through, so use, for example,
`flue-subagents --json "<prompt>"` or `flue-subagents --commit "<prompt>"`.
For stdin prompts with manual commands, keep `-i` and omit the prompt argument.
The CLI rejects an empty prompt. A writable repository mount is necessary for
Git worktree metadata and publication, even when the task is read-only.

`--userns keep-id` preserves host ownership for rootless bind mounts. Both mounts
must be writable by that user. If access relies on supplemental groups, Podman
with the `crun` runtime supports `--group-add keep-groups` in a manual command.
Do not work around ownership issues with global `safe.directory=*` settings.

`relabel=private` gives bind mounts a private SELinux label (equivalent to `:Z`)
on SELinux-enabled hosts. Use dedicated checkouts and state directories: relabeling
can affect other host services and concurrent containers sharing those paths.
On macOS/Windows, start `podman machine` first and ensure these directories are
shared into its VM; host permissions and networking may differ from native Linux.

Use a normal checkout with `.git` inside the mounted tree. A linked host worktree
or submodule checkout can reference Git metadata outside the mount; use a
standalone clone instead. Avoid concurrent host edits during a run.

## Model connectivity and configuration

`localhost` inside the container refers to the container, not the host.
Podman normally provides `host.containers.internal` automatically (no Docker
`host-gateway` flag is needed). Ensure the model server is reachable via this
address; depending on Podman's network backend, the server may need to listen
on a non-loopback interface. Restrict access with your firewall. If Podman cannot
determine the host gateway, configure an explicit host mapping in a manual command.
Alternatively, on native Linux use `--network host` and the server's localhost
URL. With `podman machine`, host networking refers to the VM, not the physical host.

The CLI discovers `/repo/flue-agent.config.json`. To use another configuration,
mount it read-only and pass `--config /config/models.json`. Adjust **every**
explicit specialist endpoint in that configuration: specialist endpoints can
override `FLUE_AGENT_ENDPOINT`, so an environment override does not rewrite all
model definitions. For authenticated models, pass only required variables with,
for example, `-e OPENROUTER_API_KEY` after exporting the key on the host.
Never bake API keys into the image.

For commits, set repository-local Git identity or pass `GIT_AUTHOR_NAME`,
`GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME` and `GIT_COMMITTER_EMAIL` via `-e`.
Host-global Git configuration and hooks' external dependencies are not
implicitly available inside the container.

## Persistent state and management

The `/data` bind mount preserves run records, worktrees and checkpoints after
`--rm` removes the container. Reuse the same repository, state directory and
container mount paths for continuation. Management commands need to be first
in the CLI argument list, so bypass the default `--repo` entrypoint:

```sh
podman run --rm --init -i --stop-timeout 60 \
  --userns keep-id --user "$(id -u):$(id -g)" \
  --mount "type=bind,source=$REPO,target=/repo,relabel=private" \
  --mount "type=bind,source=$STATE,target=/data,relabel=private" \
  --entrypoint node \
  flue-subagents /opt/flue-subagents/src/cli.ts resume RUN_ID "Answer to the clarification"
```

Use `list` or `inspect RUN_ID --json` instead of `resume ...` to inspect runs.
Resume uses persisted model configuration; pass required API-key environment
variables again. State can contain private code, prompts and command output.
Do not delete it while a run is active or while you need to resume.

## Safety

Use trusted repositories and trusted prompts only. This image is packaging, not
an adversarial-code sandbox: the agent can modify the writable mounted checkout,
read mounted state and process credentials, and access the network. Do not mount
your home directory, SSH credentials or container-engine sockets. See
[security limitations](security.md).
