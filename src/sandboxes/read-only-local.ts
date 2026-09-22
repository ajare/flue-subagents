import {
    createReadTool,
    createGrepTool,
    createGlobTool,
    type SandboxFactory,
} from '@flue/runtime';

import { local } from '@flue/runtime/node';

export function readOnlyLocal(cwd: string = process.cwd()): SandboxFactory {
    const factory = local({
        cwd,
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
