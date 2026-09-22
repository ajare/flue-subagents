import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { repositoryMutationCoordinator } from '../mutation-coordinator.ts';

export const writeFile = defineTool({
    name: 'implement_write_file',

    description:
        'Write the complete contents of a repository file. Use when creating a new file or replacing one completely.',

    input: v.object({
        path: v.string(),
        content: v.string(),
    }),

    harness: true,

    async run({ harness, data, signal }) {
        return repositoryMutationCoordinator.run(signal, async () => {
            await harness.sandbox.writeFile(data.path, data.content);

            return {
                output: {
                    success: true,
                    path: data.path,
                },
            };
        });
    },
});

export const replaceText = defineTool({
    name: 'implement_replace_text',

    description:
        'Replace one exact piece of text in a repository file. Prefer this over rewriting an entire existing file.',

    input: v.object({
        path: v.string(),
        oldText: v.string(),
        newText: v.string(),
    }),

    harness: true,

    async run({ harness, data, signal }) {
        return repositoryMutationCoordinator.run(signal, async () => {
            const original = await harness.sandbox.readFile(data.path);
            const count = original.split(data.oldText).length - 1;

            if (count === 0) throw new Error(`Text not found in ${data.path}`);
            if (count > 1) {
                throw new Error(
                    `Text occurs ${count} times in ${data.path}; replacement must be unambiguous`,
                );
            }

            await harness.sandbox.writeFile(
                data.path,
                original.replace(data.oldText, data.newText),
            );

            return {
                output: {
                    success: true,
                    path: data.path,
                },
            };
        });
    },
});

export const runCommand = defineTool({
    name: 'implement_run_command',

    description:
        'Run a repository build, test, formatter, linter, or other development command.',

    input: v.object({
        command: v.string(),
    }),

    harness: true,

    async run({ harness, data, signal }) {
        return repositoryMutationCoordinator.run(signal, async () => {
            const result = await harness.sandbox.exec(data.command, { signal });

            return {
                output: {
                    exitCode: result.exitCode,
                    stdout: result.stdout,
                    stderr: result.stderr,
                },
            };
        });
    },
});
