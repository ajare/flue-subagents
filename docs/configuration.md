# Configuration

Runtime configuration is resolved and validated before repository preflight or
workspace creation. Sources are applied in this order (highest precedence
first): CLI options, environment variables, `flue-agent.config.json` in the
repository root, and built-in defaults.

The project file is a JSON object using the option names below. Durations accept
`ms`, `s`, `m`, `h`, and `d`; sizes accept decimal (`mb`, `gb`) and binary
(`mib`, `gib`) suffixes. Unsuffixed values are milliseconds and bytes.

| Project/CLI option | Environment variable | Default |
|---|---|---:|
| `model` | `FLUE_AGENT_MODEL` | `halogen/qwen-3.8-flash-next` |
| `endpoint` | `FLUE_AGENT_ENDPOINT` | `http://localhost:8731/v1` |
| `contextWindow` | `FLUE_AGENT_CONTEXT_WINDOW` | `262144` |
| `maxOutputTokens` | `FLUE_AGENT_MAX_OUTPUT_TOKENS` | `65536` |
| `reasoningEffort` | `FLUE_AGENT_REASONING_EFFORT` | `high` |
| `readOnlyConcurrency` | `FLUE_AGENT_READ_ONLY_CONCURRENCY` | `4` |
| `implementerConcurrency` | `FLUE_AGENT_IMPLEMENTER_CONCURRENCY` | `1` |
| `maxDelegations` | `FLUE_AGENT_MAX_DELEGATIONS` | `20` |
| `maxRepairCycles` | `FLUE_AGENT_MAX_REPAIR_CYCLES` | `2` |
| `runTimeoutMs` | `FLUE_AGENT_RUN_TIMEOUT` | `30m` |
| `commandTimeoutMs` | `FLUE_AGENT_COMMAND_TIMEOUT` | `10m` |
| `connectivityTimeoutMs` | `FLUE_AGENT_CONNECTIVITY_TIMEOUT` | `5s` |
| `retentionMs` | `FLUE_AGENT_RETENTION` | `7d` |
| `workspaceLimitBytes` | `FLUE_AGENT_WORKSPACE_LIMIT` | `10gib` |

`maxOutputTokens` is a per-request output budget, separate from `contextWindow`.
The default fits the local server's 65,536-token policy cap. If your server uses
a different cap, set `FLUE_AGENT_MAX_OUTPUT_TOKENS` accordingly; project and
environment overrides can still exceed server policy.

`model` uses `provider/model` syntax. `reasoningEffort` is one of `off`,
`minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Mutating work remains
serialized, so `implementerConcurrency` must be `1`.

`runTimeoutMs` sets the application run deadline and is also passed to Flue as
the orchestrator's `durability.timeoutMs`, overriding Flue's independent
one-hour default. This applies when creating an orchestrator for a new run or
resume. The application deadline remains the overall limit across delegations
and continuation/review attempts; dispatching another response does not extend
that application deadline.

Before creating a workspace, callers must run `checkModelConnectivity()`.
Failures are reported as `InfrastructureError` with code `model_unavailable`.
`configurationForDiagnostics()` returns the complete effective configuration;
it contains no credential fields.

Agent command environments retain Flue's restricted local allowlist only:
`PATH`, basic user/shell/locale values, terminal settings, and temporary-directory
variables. Tokens, cloud credentials, SSH agent sockets, and other host secrets
are not inherited. Application-side model connectivity is separate from this
command environment.
