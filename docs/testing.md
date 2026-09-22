# Automated tests

Run `npm ci`, then `npm test` with Node >=22.19 and Git installed. Tests use
Node's built-in runner and native TypeScript stripping; no inference server,
credentials, external network, or build step is required. CI tests Node 22.19
and 24 on Linux. Run `npm run typecheck` and `npm run lint` for static checks.

Place test entrypoints at `tests/*.test.ts`. Helpers and executable fixtures
are explicitly excluded from discovery. Each test file has its own process;
keep tests using Flue's global runtime/provider/observation state sequential
within a file. A 30-second per-test timeout catches hangs.

## Helpers

- `tests/helpers/git.ts`: `createGitFixture(t)` provides `path`, isolated `env`,
  `git(...args)`, `write(path, content)`, and idempotent `dispose()`. The fixture
  starts on `main` with a clean initial commit, fixed identity and dates, no
  hooks or signing, and no inherited Git configuration. Cleanup is registered
  immediately with the test context. Pass its environment to Git subprocesses.
- `tests/helpers/cli.ts`: `runCli(t, entrypoint, args, {stdin, cwd, env})` closes
  stdin and returns stdout, stderr, code, and signal. `startCli` exposes the child,
  result promise, and signal sender for interactive/readiness-driven tests.
  Children are killed on timeout or test teardown; timeout/spawn failures reject.
  Signal tests target POSIX behavior. The executable fixture verifies the harness
  independently of the production CLI.
- `tests/helpers/runtime.ts`: `createMockProvider` scripts Pi faux responses;
  `delegationResponses` scripts a task call, specialist result, and final answer.
  `createTestRuntime(t, agents, responses)` wraps the real embedded Flue runtime
  with that mock provider, records observations, and registers teardown. Agents
  select `TEST_MODEL`. This preserves real tool dispatch while mocking inference.
  Never use the real model transport in offline tests. The production runner's
  `modelTransport` option replaces connectivity and inference only.

`tests/flue-integration.test.ts` also runs the FLUE-002 probe as a regression test
for parallelism, cancellation, and continuation.

`npm run test:coverage` prints Node's experimental coverage report. Coverage is
informational (including harness/prototype code), not a completeness gate.

`npm run test:e2e` runs the deterministic production-runner acceptance tests in
`tests/acceptance.test.ts` (also included in `npm test`). Real-model evaluations
live separately in `tests/evals/`; see [the evaluation protocol](evaluations.md)
for opt-in execution, scenario oracles, and evidence artifacts.
