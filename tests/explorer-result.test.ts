import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeExplorerResult } from '../src/subagents/explorer-result.ts';
import {
    ResultValidationError,
    validateSubagentResult,
} from '../src/result-contracts.ts';

const result = {
    schemaVersion: 1,
    role: 'explorer',
    summary: 'Observed { braces }, a quote " and a backslash \\.',
    findings: ['Located the implementation.'],
    evidence: [
        { path: 'src/example.ts', observation: 'Defines the entry point.' },
    ],
    openQuestions: [],
};
const json = JSON.stringify(result, null, 2);

test('explorer accepts JSON and presentation wrappers without changing findings', () => {
    for (const output of [
        result,
        json,
        `\`\`\`json\n${json}\n\`\`\``,
        `\`\`\`\r\n${json}\r\n\`\`\``,
        `\`\`\`json\n${json}`,
    ]) {
        assert.deepEqual(normalizeExplorerResult(output), result);
    }
});

test('explorer preserves a trailing Markdown report as a finding', () => {
    const appendix =
        '## Touch-point checklist\n1. Update `Agent.cpp`.\n2. Test the change.';
    for (const output of [
        `${json}\n${appendix}`,
        `\`\`\`json\n${json}\n${appendix}`,
        `\`\`\`json\n${json}\n\`\`\`\n${appendix}`,
    ]) {
        const normalized = normalizeExplorerResult(output);
        assert.deepEqual(normalized, {
            ...result,
            findings: [...result.findings, appendix],
        });
        assert.deepEqual(
            validateSubagentResult('explorer', JSON.stringify(normalized)),
            normalized,
        );
    }
});

test('explorer omits null optional fields without mutating the provider object', () => {
    const input = {
        ...result,
        evidence: [{ ...result.evidence[0], line: null, symbol: null }],
    };
    assert.deepEqual(normalizeExplorerResult(input), result);
    assert.deepEqual(normalizeExplorerResult(JSON.stringify(input)), result);
    assert.equal(input.evidence[0].symbol, null);
    assert.equal(input.evidence[0].line, null);
});

test('explorer still rejects broken or ambiguous JSON and invalid required data', () => {
    for (const output of [
        'Markdown only',
        '{}',
        json.slice(0, -1),
        `${json}\n${json}`,
        `${json}\ntrailing garbage`,
        `Here is the result:\n${json}`,
        `\`\`\`json\n{invalid}\n\`\`\``,
        `${json}\n## Another result\n${json}`,
        { ...result, summary: null },
        { ...result, findings: null },
        { ...result, role: 'planner' },
        { ...result, extra: 'unknown' },
        { ...result, evidence: [{ ...result.evidence[0], line: '1' }] },
        { ...result, evidence: [{ ...result.evidence[0], symbol: 42 }] },
        { ...result, evidence: [{ ...result.evidence[0], path: null }] },
    ]) {
        assert.throws(
            () => normalizeExplorerResult(output),
            ResultValidationError,
        );
    }
    assert.throws(
        () => validateSubagentResult('explorer', `\`\`\`json\n${json}\n\`\`\``),
        ResultValidationError,
    );
});
