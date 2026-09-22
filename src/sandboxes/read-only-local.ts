import {
    createReadTool,
    createGrepTool,
    createGlobTool,
    type SandboxFactory,
} from '@flue/runtime';

import { local } from '@flue/runtime/node';

export function readOnlyLocal(
    cwd: string = process.cwd(),
    env?: Record<string, string | undefined>,
): SandboxFactory {
    const factory = local({
        cwd,
        env,
    });

    return {
        ...factory,

        tools: (sandbox) => [
            createReadTool(sandbox),
            createGrepTool(sandbox),
            createGlobTool(sandbox),
        ],
    };
}
