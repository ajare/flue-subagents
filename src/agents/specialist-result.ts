import { defineTool, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { activeResultCorrection } from '../result-correction.ts';
import {
    validateSubagentResult,
    type SubagentRole,
} from '../result-contracts.ts';

export const SPECIALIST_RESULT_TOOL = 'submit_specialist_result';

/** Flue disallows lifecycle hooks on subagents; validate inside their finish tool. */
export function useSpecialistResult(role: SubagentRole) {
    useTool(
        defineTool({
            name: SPECIALIST_RESULT_TOOL,
            description:
                'Finish this task by submitting the object specified by OUTPUT CONTRACT. If rejected, repair only the object without repeating your investigation.',
            // Framework schema rejection would bypass application budget accounting.
            input: v.looseObject({}),
            async run({ data }) {
                const correction = activeResultCorrection.getStore();
                if (!correction)
                    return {
                        output: validateSubagentResult(role, data),
                        terminate: true,
                    };
                if (correction.role !== role)
                    throw new Error('Mismatched specialist result boundary');
                try {
                    const prompt = await correction.submit(data);
                    return prompt
                        ? { output: prompt }
                        : { output: correction.result, terminate: true };
                } catch {
                    // Tool exceptions are recoverable in Flue. Terminate instead;
                    // the task interceptor surfaces the saved terminal failure.
                    return {
                        output: 'Result contract failed; no further attempts allowed.',
                        terminate: true,
                    };
                }
            },
        }),
    );
}
