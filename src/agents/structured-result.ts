import {
    defineTool,
    useAgentFinish,
    useAgentStart,
    usePersistentState,
    useResponseFinish,
    useTool,
} from '@flue/runtime';
import {
    type OrchestratorResult,
    OrchestrationDefectError,
    orchestratorResultSchema,
    validateOrchestratorResult,
} from '../orchestrator-policy.ts';

export const RESULT_TOOL = 'submit_orchestrator_result';
export const RESULT_METADATA_KEY = 'orchestratorResult';

/** Require a validated tool result, rather than trusting assistant prose. */
export function useStructuredResult() {
    const [result, setResult] = usePersistentState<OrchestratorResult | null>(
        'orchestrator-result',
        null,
    );
    const [continuations, setContinuations] = usePersistentState(
        'orchestrator-result-continuations',
        0,
    );
    useAgentStart(() => {
        setResult(null);
        setContinuations(0);
    });
    useTool(
        defineTool({
            name: RESULT_TOOL,
            description:
                'Submit the final structured decision and user-facing answer. Required to finish this response.',
            input: orchestratorResultSchema,
            run({ data }) {
                // Cross-field rules must also pass before this tool can terminate.
                const decision = validateOrchestratorResult(data);
                setResult(decision);
                return { output: decision, terminate: true };
            },
        }),
    );
    useAgentFinish(({ append }) => {
        if (result !== null) return;
        if (continuations >= 2) {
            throw new OrchestrationDefectError(
                'Orchestrator did not submit a valid structured terminal result',
            );
        }
        setContinuations(continuations + 1);
        append({
            kind: 'signal',
            type: 'structured_result_required',
            body: `You must call ${RESULT_TOOL} with your final decision. Put the full user-facing answer in summary. Plain text does not complete the response.`,
        });
    });
    useResponseFinish(() => {
        if (result === null) {
            throw new OrchestrationDefectError(
                'Missing structured terminal result',
            );
        }
        return { [RESULT_METADATA_KEY]: result };
    });
}

/** No fallback to text: only the validated, durable tool result is authoritative. */
export function readStructuredResult(metadata: Record<string, unknown> = {}) {
    return validateOrchestratorResult(metadata[RESULT_METADATA_KEY]);
}
