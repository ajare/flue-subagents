import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const issueNumber = v.pipe(
    v.number(),
    v.integer(),
    v.minValue(1),
    v.maxValue(Number.MAX_SAFE_INTEGER),
);

/** Read one issue from the GitHub repository configured for the workspace. */
export const readGitHubIssue = defineTool({
    name: 'read_github_issue',
    description:
        'Read a GitHub issue from the current repository, including its complete body, labels, author, state, URL, and comments. This is read-only and requires the gh CLI to be installed and authenticated.',
    input: v.object({ number: issueNumber }),
    harness: true,

    async run({ harness, data, signal }) {
        const result = await harness.sandbox.exec(
            githubIssueCommand(data.number),
            { signal },
        );
        return {
            output: {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            },
        };
    },
});

/** Build the fixed-shape command without accepting shell-controlled text. */
export function githubIssueCommand(number: number): string {
    if (!Number.isSafeInteger(number) || number < 1)
        throw new Error('Issue number must be a positive safe integer');

    return `gh issue view ${number} --json number,title,state,author,labels,body,comments,url`;
}
