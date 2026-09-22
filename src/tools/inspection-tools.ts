import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const inspectionInput = v.object({
    command: v.picklist([
        'git-status',
        'git-diff',
        'git-diff-staged',
        'git-log',
        'git-show',
        'git-ls-files',
    ]),
    paths: v.optional(v.array(v.string())),
    revision: v.optional(v.string()),
    maxCount: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
    ),
});

/** A deliberately small command surface for explorer and planner roles. */
export const inspectRepository = defineTool({
    name: 'inspect_repository',
    description:
        'Run one allowlisted, read-only Git inspection in the repository. File contents should normally be inspected with read, grep, and glob.',
    input: inspectionInput,
    harness: true,

    async run({ harness, data, signal }) {
        const command = inspectionCommand(data);
        const result = await harness.sandbox.exec(command, { signal });
        return {
            output: {
                exitCode: result.exitCode,
                stdout: result.stdout,
                stderr: result.stderr,
            },
        };
    },
});

interface InspectionInput {
    command:
        | 'git-status'
        | 'git-diff'
        | 'git-diff-staged'
        | 'git-log'
        | 'git-show'
        | 'git-ls-files';
    paths?: string[];
    revision?: string;
    maxCount?: number;
}

/** Convert validated structured input to a shell command without exposing a shell string. */
export function inspectionCommand(input: InspectionInput): string {
    const paths = input.paths ?? [];
    for (const path of paths) assertRepositoryPath(path);
    const pathArguments = paths.map(shellQuote);

    switch (input.command) {
        case 'git-status':
            rejectUnused(input, ['command']);
            return 'git --no-pager status --short --branch';
        case 'git-diff':
            rejectUnused(input, ['command', 'paths']);
            return joinCommand([
                'git --no-pager diff --no-ext-diff --no-textconv',
                '--',
                ...pathArguments,
            ]);
        case 'git-diff-staged':
            rejectUnused(input, ['command', 'paths']);
            return joinCommand([
                'git --no-pager diff --cached --no-ext-diff --no-textconv',
                '--',
                ...pathArguments,
            ]);
        case 'git-log': {
            rejectUnused(input, ['command', 'maxCount']);
            const maxCount = input.maxCount ?? 20;
            if (
                !Number.isSafeInteger(maxCount) ||
                maxCount < 1 ||
                maxCount > 100
            )
                throw new Error(
                    'maxCount must be an integer from 1 through 100',
                );
            return `git --no-pager log --oneline --no-decorate --max-count=${maxCount}`;
        }
        case 'git-show': {
            rejectUnused(input, ['command', 'revision', 'paths']);
            const revision = input.revision ?? 'HEAD';
            if (!/^[A-Za-z0-9][A-Za-z0-9._/@{}~^:+-]{0,255}$/u.test(revision))
                throw new Error('revision contains unsupported characters');
            return joinCommand([
                'git --no-pager show --no-ext-diff --no-textconv --format=fuller --stat --patch',
                shellQuote(revision),
                '--',
                ...pathArguments,
            ]);
        }
        case 'git-ls-files':
            rejectUnused(input, ['command', 'paths']);
            return joinCommand([
                'git --no-pager ls-files',
                '--',
                ...pathArguments,
            ]);
    }
}

function assertRepositoryPath(path: string): void {
    if (
        path === '' ||
        path.startsWith('-') ||
        path.startsWith('/') ||
        path.includes('\\') ||
        path.split('/').some((part) => part === '..' || part === '.git') ||
        /[\0\r\n]/u.test(path)
    ) {
        throw new Error(`Unsupported repository path: ${path}`);
    }
}

function rejectUnused(input: InspectionInput, allowed: string[]): void {
    for (const [key, value] of Object.entries(input)) {
        if (value !== undefined && !allowed.includes(key))
            throw new Error(`${key} is not supported for ${input.command}`);
    }
}

function shellQuote(value: string): string {
    return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function joinCommand(parts: string[]): string {
    return parts.filter(Boolean).join(' ');
}
