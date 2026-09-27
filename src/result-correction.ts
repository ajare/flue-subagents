import { AsyncLocalStorage } from 'node:async_hooks';
import {
    correctivePrompt,
    ResultValidationError,
    validateSubagentResult,
    type SubagentRole,
    type SubagentResult,
} from './result-contracts.ts';

interface CorrectionOptions {
    prompt: string;
    consume: () => void;
    onMalformed?: (error: ResultValidationError) => void | Promise<void>;
    onRetry?: () => void | Promise<void>;
    validate?: (output: unknown) => SubagentResult;
}

/** One bounded contract check, shared by tool-driven and programmatic calls. */
export class ResultCorrection {
    private malformed = 0;
    private pending: Promise<unknown> = Promise.resolve();
    result?: SubagentResult;
    failure?: unknown;
    readonly role: SubagentRole;
    private readonly options: CorrectionOptions;
    constructor(role: SubagentRole, options: CorrectionOptions) {
        this.role = role;
        this.options = options;
    }

    submit(output: unknown): Promise<string | undefined> {
        // A model may batch finish-tool calls. Serialize validation and ledger
        // writes so those calls cannot race the one-correction limit.
        const submission = this.pending.then(() => this.validate(output));
        this.pending = submission.catch((error) => {
            this.failure = error;
        });
        return submission;
    }

    private async validate(output: unknown): Promise<string | undefined> {
        if (this.failure) throw this.failure;
        if (this.result) return;
        try {
            this.result = this.options.validate
                ? this.options.validate(output)
                : validateSubagentResult(this.role, output);
            return;
        } catch (error) {
            if (!(error instanceof ResultValidationError)) throw error;
            await this.options.onMalformed?.(error);
            if (++this.malformed > 1) {
                this.failure = error;
                throw error;
            }
            try {
                this.options.consume();
                await this.options.onRetry?.();
            } catch (failure) {
                this.failure = failure;
                throw failure;
            }
            return correctivePrompt(this.role, error, this.options.prompt);
        }
    }
}

export const activeResultCorrection = new AsyncLocalStorage<ResultCorrection>();
