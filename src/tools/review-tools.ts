import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

/** Command access intended for independent validation, without file mutation APIs. */
export const runReviewCommand = defineTool({
    name: 'review_run_command',
    description:
        'Run a build, test, linter, formatter check, or other non-mutating validation command. Do not use commands that write repository files.',
    input: v.object({ command: v.string() }),
    harness: true,

    async run({ harness, data, signal }) {
        const result = await harness.sandbox.exec(data.command, { signal });
        return {
            output: {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            },
        };
    },
});
