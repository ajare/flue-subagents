# Command-line interface

`flue-agent` submits one engineering objective against a local repository:

```sh
flue-agent --repo /path/to/project "add validation to the settings endpoint"
```

With no positional argument, it reads the complete prompt from standard input:

```sh
cat objective.txt | flue-agent --repo /path/to/project
```

`--repo` defaults to the current directory. The path is resolved to its
canonical Git worktree root before configuration or execution begins. Non-Git,
bare, unborn, sparse, conflicted, submodule-containing, and in-progress
repositories are rejected before execution.

The repository must be clean by default. Pass `--allow-dirty` to explicitly
permit staged, unstaged, and untracked (but not ignored) changes. The CLI then
captures HEAD, branch or detached state, index state, worktree state, and a
SHA-256 fingerprint of the complete allowed starting state so later phases can
detect concurrent changes.

Empty prompts, invalid paths, unknown options, configuration failures, and
runtime failures return a non-zero status. Human diagnostics go to stderr;
`--json` emits NDJSON events and structured outcomes to stdout. Use `--help` and
`--version` for command metadata. See [reporting](reporting.md) for stable exit
codes and the `list`, `inspect`, and `cleanup` commands.

Approved mutation runs publish their reviewed patch but leave it uncommitted by
default. Add `--commit`, or directly request a commit in the prompt, to create
one final commit after publication. A prompt may supply a message (for example,
`commit the changes with message "fix: validate settings"`); otherwise a safe
default is generated. Hooks run normally. Hook rejection or hook-modified source
is reported as blocked rather than bypassed or accepted without review.

Each execution is recorded outside the target repository under the platform
user-data directory (`$XDG_DATA_HOME/flue-agent` on Linux,
`~/Library/Application Support/flue-agent` on macOS, or the local application
data directory on Windows). Set `FLUE_AGENT_DATA_DIR` to use another external
location. Run records preserve status, configuration, repository identity,
timestamps, conversation ID, and retained artifact locations.

Agent execution uses a detached temporary worktree recorded in the run, not
this original checkout. Dirty starting changes are reproduced there when
allowed. Completed workspaces remain available until publication is confirmed;
unsuccessful workspaces follow the configured retention period. See
[temporary workspaces](workspaces.md) for limits, cleanup, and trust boundaries.

> **Trusted-local operation only.** Run `flue-agent` only with trusted prompts
> and trusted repositories. The autonomous agent can inspect and modify code
> and invoke development tools in the selected repository.
