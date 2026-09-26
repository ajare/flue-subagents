import {
    type ExplorerResult,
    ResultValidationError,
    validateSubagentResult,
} from '../result-contracts.ts';

/**
 * Adapt presentation mistakes at the explorer boundary, not in the shared
 * validator. Required data is never inferred and persisted results stay strict.
 */
export function normalizeExplorerResult(output: unknown): ExplorerResult {
    let value = output;
    let appendix = '';
    if (typeof output === 'string') {
        let source = output.trim();
        // Accept a short prose introduction only before an explicit JSON fence.
        // Never scan past JSON-like data or another code block to pick a result.
        const introducedFence = /^```(?:json)?[ \t]*\r?\n/im.exec(source);
        if (introducedFence && introducedFence.index > 0) {
            const introduction = source.slice(0, introducedFence.index).trim();
            if (introduction.length <= 500 && !/[{}[\]`]/.test(introduction)) {
                source = source.slice(introducedFence.index);
            }
        }
        const fence = /^```(?:json)?[ \t]*\r?\n/i.exec(source);
        if (fence) source = source.slice(fence[0].length).trimStart();
        const end = objectEnd(source);
        if (end < 0) return validateSubagentResult('explorer', output);
        try {
            value = JSON.parse(source.slice(0, end));
        } catch {
            return validateSubagentResult('explorer', output);
        }
        appendix = source.slice(end).trim();
        if (fence)
            appendix = appendix.replace(/^```[ \t]*(?:\r?\n|$)/, '').trim();
        // Only a clearly separated Markdown report is an accepted appendix.
        // Do not silently choose among multiple JSON results or ignore garbage.
        if (
            appendix &&
            (!/^#{1,6}\s+/.test(appendix) ||
                /"schemaVersion"\s*:/.test(appendix))
        ) {
            throw new ResultValidationError(
                'explorer',
                [
                    {
                        path: '$',
                        message:
                            'expected one JSON object, optionally followed by a Markdown report heading',
                    },
                ],
                output,
            );
        }
    }
    if (isObject(value) && Array.isArray(value.evidence)) {
        value = {
            ...value,
            evidence: value.evidence.map((entry: unknown) => {
                if (!isObject(entry)) return entry;
                const normalized = { ...entry };
                // Null means unavailable only for these explicitly optional fields.
                if (normalized.line === null) delete normalized.line;
                if (normalized.symbol === null) delete normalized.symbol;
                return normalized;
            }),
        };
    }
    const result = validateSubagentResult('explorer', value);
    return appendix
        ? { ...result, findings: [...result.findings, appendix] }
        : result;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Find the first complete object without confusing braces in JSON strings. */
function objectEnd(source: string): number {
    if (!source.startsWith('{')) return -1;
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let index = 0; index < source.length; index++) {
        const char = source[index];
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === '\\') escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === '{') depth++;
        else if (char === '}' && --depth === 0) return index + 1;
    }
    return -1;
}
