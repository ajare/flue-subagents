import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
    DelegationBudgetExceededError,
    ResultValidationError,
    createDelegationBudget,
    delegateWithValidatedResult,
    mayIgnoreRoleFailure,
    validateSubagentResult,
} from '../src/result-contracts.ts';

const successfulResults = {
    explorer: {
        schemaVersion: 1,
        role: 'explorer',
        summary: 'Located the parser.',
        findings: ['Parsing occurs at the application boundary.'],
        evidence: [
            {
                path: 'src/parser.ts',
                line: 12,
                symbol: 'parse',
                observation: 'Calls JSON.parse before validation.',
            },
        ],
        openQuestions: [],
    },
    planner: {
        schemaVersion: 1,
        role: 'planner',
        summary: 'Validate parsed data.',
        steps: [
            {
                description: 'Add the result schema.',
                affectedFiles: ['src/parser.ts'],
                affectedSymbols: ['parse'],
            },
        ],
        tests: ['Reject an unknown schema version.'],
        risks: [],
    },
    implementer: {
        schemaVersion: 1,
        role: 'implementer',
        summary: 'Added result validation.',
        changes: [
            { path: 'src/parser.ts', summary: 'Validates parsed values.' },
        ],
        commands: [
            {
                command: 'npm test',
                result: 'passed',
                exitCode: 0,
                summary: 'All tests passed.',
            },
        ],
        unresolvedIssues: [],
    },
    reviewer: {
        schemaVersion: 1,
        role: 'reviewer',
        verdict: 'approved_with_limitations',
        summary: 'The contract is enforced.',
        findings: [
            {
                severity: 'note',
                description: 'No migration is needed for version one.',
            },
        ],
        validation: [
            {
                command: 'npm test',
                result: 'passed',
                exitCode: 0,
                summary: 'All tests passed.',
            },
        ],
        limitations: ['Only version one is currently understood.'],
    },
} as const;

test('all versioned role contracts accept representative results', () => {
    for (const role of Object.keys(successfulResults) as Array<
        keyof typeof successfulResults
    >) {
        const result = validateSubagentResult(role, successfulResults[role]);
        assert.equal(result.role, role);
        assert.equal(result.schemaVersion, 1);
    }

    const json = JSON.stringify(successfulResults.explorer);
    assert.deepEqual(
        validateSubagentResult('explorer', json),
        successfulResults.explorer,
    );
});

test('role contracts reject malformed, mismatched and future results', () => {
    for (const role of Object.keys(successfulResults) as Array<
        keyof typeof successfulResults
    >) {
        assert.throws(
            () =>
                validateSubagentResult(role, {
                    ...successfulResults[role],
                    summary: '',
                }),
            ResultValidationError,
        );
    }
    assert.throws(
        () => validateSubagentResult('reviewer', successfulResults.implementer),
        ResultValidationError,
    );
    assert.throws(
        () =>
            validateSubagentResult('planner', {
                ...successfulResults.planner,
                schemaVersion: 2,
            }),
        ResultValidationError,
    );
    assert.throws(
        () => validateSubagentResult('explorer', '```json\n{}\n```'),
        /must be valid JSON/,
    );
});

test('one corrective retry receives validation errors and consumes budget', async () => {
    const budget = createDelegationBudget(2);
    const prompts: string[] = [];
    const result = await delegateWithValidatedResult({
        role: 'implementer',
        prompt: 'Implement the parser.',
        budget,
        delegate: (prompt, context) => {
            prompts.push(prompt);
            return context.corrective ? successfulResults.implementer : '{}';
        },
    });

    assert.equal(result.role, 'implementer');
    assert.equal(budget.used, 2);
    assert.match(prompts[1] ?? '', /Validation errors:/);
    assert.match(prompts[1] ?? '', /Return only one corrected JSON object/);
});

test('malformed implementer and reviewer corrections are terminal', async () => {
    for (const role of ['implementer', 'reviewer'] as const) {
        const budget = createDelegationBudget(2);
        await assert.rejects(
            delegateWithValidatedResult({
                role,
                prompt: 'Do the work.',
                budget,
                delegate: () => '{}',
            }),
            ResultValidationError,
        );
        assert.equal(budget.used, 2);
    }
});

test('a correction cannot bypass the shared delegation budget', async () => {
    const budget = createDelegationBudget(1);
    let calls = 0;
    await assert.rejects(
        delegateWithValidatedResult({
            role: 'explorer',
            prompt: 'Explore.',
            budget,
            delegate: () => {
                calls += 1;
                return '{}';
            },
        }),
        DelegationBudgetExceededError,
    );
    assert.equal(calls, 1);
});

test('only explicitly unnecessary explorer or planner failures are ignorable', () => {
    assert.equal(
        mayIgnoreRoleFailure('explorer', {
            workIsUnnecessary: true,
            reason: 'The exact symbol was supplied by the user.',
        }),
        true,
    );
    assert.equal(
        mayIgnoreRoleFailure('planner', {
            workIsUnnecessary: true,
            reason: 'This is a one-line mechanical change.',
        }),
        true,
    );
    assert.equal(
        mayIgnoreRoleFailure('planner', { workIsUnnecessary: true }),
        false,
    );
    assert.equal(
        mayIgnoreRoleFailure('implementer', {
            workIsUnnecessary: true,
            reason: 'Skip it.',
        }),
        false,
    );
    assert.equal(
        mayIgnoreRoleFailure('reviewer', {
            workIsUnnecessary: true,
            reason: 'Skip it.',
        }),
        false,
    );
});
