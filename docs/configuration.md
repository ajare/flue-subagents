# Configuration

Runtime configuration is resolved and validated before repository preflight or
workspace creation. Sources are applied in this order (highest precedence
first): CLI options, environment variables, `flue-agent.config.json` in the
repository root, and built-in defaults. Pass `--config <path>` (or
`--config=<path>`) to replace the discovered project file. Relative paths are
resolved from the invoking directory, not `--repo`. An explicitly selected
missing or invalid file is an error; a missing default file uses built-in defaults.

The project file is a JSON object using the option names below. Durations accept
`ms`, `s`, `m`, `h`, and `d`; sizes accept decimal (`mb`, `gb`) and binary
(`mib`, `gib`) suffixes. Unsuffixed values are milliseconds and bytes.

| Project/CLI option | Environment variable | Default |
|---|---|---:|
| `model` | `FLUE_AGENT_MODEL` | `halogen/qwen-3.8-flash-next` |
| `endpoint` | `FLUE_AGENT_ENDPOINT` | `http://localhost:8731/v1` |
| `contextWindow` | `FLUE_AGENT_CONTEXT_WINDOW` | `262144` |
| `maxOutputTokens` | `FLUE_AGENT_MAX_OUTPUT_TOKENS` | `65536` |
| `resultMaxStringLength` | `FLUE_AGENT_RESULT_MAX_STRING_LENGTH` | `4000` characters |
| `resultMaxCollectionItems` | `FLUE_AGENT_RESULT_MAX_COLLECTION_ITEMS` | `128` items |
| `resultMaxLength` | `FLUE_AGENT_RESULT_MAX_LENGTH` | `48000` characters |
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

Presentation limits reject complete overlarge specialist results with field-specific
compaction instructions; evidence is never silently dropped. The planner uses half
the configured collection limit and two thirds of the total-object limit; other
roles use the configured values. Limits are positive integers and can be set in
project configuration or the environment. Fixed contract discriminants are exempt
from the string limit. Persisted results are replayed independently of current limits.

A length-stopped incomplete specialist result is classified as `output_truncated`.
It consumes the same single corrective attempt and extra delegation-budget unit
as a malformed result, continuing the original child session with compaction
instructions. A second invalid result is terminal. Reports retain safe stop reason,
token counts, and recovery status without including partial output. Length-stopped
tool arguments are never trusted, even when the provider salvages valid JSON.

`maxOutputTokens` is a per-request output budget, separate from `contextWindow`.
The default fits the local server's 65,536-token policy cap. If your server uses
a different cap, set `FLUE_AGENT_MAX_OUTPUT_TOKENS` accordingly; project and
environment overrides can still exceed server policy.

## Named model definitions

Define reusable settings in the top-level `models` object, then select them by
name in `orchestrator` and `subagents`:

```json
{
  "models": {
    "remote": {
      "model": "openrouter/openai/gpt-6.1-sol",
      "endpoint": "https://openrouter.ai/api/v1",
      "credentials": { "type": "apiKey", "apiKeyEnv": "OPENROUTER_API_KEY" },
      "reasoningEffort": "default",
      "openRouterProviders": ["openai"]
    },
    "local": {
      "model": "halogen/qwen-3.8-flash-next",
      "endpoint": "http://localhost:8731/v1",
      "credentials": { "type": "local" },
      "contextWindow": 262144,
      "maxOutputTokens": 65536,
      "reasoningEffort": "high"
    }
  },
  "orchestrator": "remote",
  "subagents": {
    "explorer": "local",
    "planner": "local",
    "implementer": "local",
    "reviewer": "local"
  }
}
```

The checked-in file names these definitions `openrouter-sol` and `local-qwen`.
All four specialists share `local-qwen`; edit one definition to update every
agent referencing it, or change a role's reference to select another definition.
Names contain letters, digits, underscores, or hyphens. Unknown references,
invalid definitions (including unused ones), and unknown roles are errors.

Definitions accept only `model`, `endpoint`, `contextWindow`, `maxOutputTokens`,
`reasoningEffort`, `credentials`, and `openRouterProviders`. Omitted orchestrator
fields use built-in defaults; omitted specialist fields inherit the effective
shared/orchestrator configuration. Environment and CLI shared overrides still
have higher precedence than the selected orchestrator definition, while explicit
specialist definition fields take precedence over shared values. Output budgets
must fit the effective context window.

Legacy inline top-level model settings and inline specialist objects remain
supported. Do not combine an `orchestrator` reference with inline top-level model
settings; other top-level run settings such as `maxDelegations` are allowed.
Definitions and references are expanded before runtime and run persistence, so
resuming uses saved settings rather than looking up names in an edited file.

Each configured role has its own provider namespace, so identical model IDs can
use different endpoints and budgets. All endpoints use the OpenAI-compatible
completions adapter and the configured credentials. Connectivity
is checked for each configured role before inference. Resuming uses the saved
resolved settings rather than rereading a changed configuration file.

```sh
flue-agent --config ./my-models.json --repo /path/to/repo "Investigate the issue"
```

## OpenRouter

The checked-in orchestrator uses `openrouter/openai/gpt-6.1-sol` at
`https://openrouter.ai/api/v1`, authenticated from `OPENROUTER_API_KEY`.
The outer `openrouter/` prefix identifies the application's provider; the
model ID sent to OpenRouter is `openai/gpt-6.1-sol`.

`"openRouterProviders": ["openai"]` sends
`"provider": { "only": ["openai"], "allow_fallbacks": false }`, preventing
routing to other providers. This setting applies only to endpoints hosted at
`openrouter.ai`; local specialist endpoints are unaffected.

`"reasoningEffort": "default"` enables reasoning without selecting an effort
level. For OpenRouter this sends `"reasoning": { "enabled": true }` and no
`reasoning_effort` or reasoning `effort`, leaving the model's default in control.

## Credentials

The checked-in configuration uses `OPENROUTER_API_KEY` for the orchestrator
and declares `"credentials": { "type": "local" }` for each sub-agent. This preserves the local server's
placeholder `Bearer local` authentication; no secret is required.

For an authenticated endpoint, put an environment-variable reference in its
model definition (never put the key itself in the file):

```json
{
  "models": {
    "review-model": {
      "model": "openai/gpt-4.1",
      "endpoint": "https://api.openai.com/v1",
      "credentials": {
        "type": "apiKey",
        "apiKeyEnv": "OPENAI_API_KEY"
      }
    }
  },
  "subagents": { "reviewer": "review-model" }
}
```

Set `OPENAI_API_KEY` in the host environment before running the application.
Use different variable names for different model definitions/providers when
needed. Credentials in a specialist's definition replace inherited shared
credentials. The checked-in `local-qwen` definition explicitly selects local
credentials; change a role's model reference to select API-key credentials.

The named variable is read when connectivity or provider authentication is
requested and sent as a Bearer token. Missing/empty values fail before the
connectivity request. Literal keys, unknown credential fields, invalid variable
names, and sandbox-allowlisted variable names are rejected. Only references are
saved in run records/diagnostics; API keys are not passed into command sandboxes.
Resuming rereads the named variables from the current host environment.

`model` uses `provider/model` syntax. `reasoningEffort` is one of `off`,
`default`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. Mutating work remains
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
