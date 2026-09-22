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
  Signal tests target POSIX behavior. The executable fixture is not the future
  production CLI; it verifies the harness independently of FLUE-005.
- `tests/helpers/runtime.ts`: `createMockProvider` scripts Pi faux responses;
  `delegationResponses` scripts a task call, specialist result, and final answer.
  `createTestRuntime(t, agents, responses)` wraps the real embedded Flue runtime
  with that mock provider, records observations, and registers teardown. Agents
  select `TEST_MODEL`. This preserves real tool dispatch while mocking inference.
  Do not import `src/local-provider.ts` in offline tests.

`tests/flue-integration.test.ts` also runs the FLUE-002 probe as a regression test
for parallelism, cancellation, and continuation.

`npm run test:coverage` prints Node's experimental coverage report. Coverage is
informational (including harness/prototype code), not a completeness gate for
the production agent, which has not yet been implemented.
