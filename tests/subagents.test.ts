import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai';
import { init, useModel, useSandbox, useSubagent } from '@flue/runtime';
import {
    type SubagentRole,
    validateSubagentResult,
} from '../src/result-contracts.ts';
import { readOnlyLocal } from '../src/sandboxes/read-only-local.ts';
import { explorer } from '../src/subagents/explorer.ts';
import { implementer } from '../src/subagents/implementer.ts';
import { planner } from '../src/subagents/planner.ts';
import { reviewer } from '../src/subagents/reviewer.ts';
import { createTestRuntime, TEST_MODEL } from './helpers/runtime.ts';

function SpecialistHarness() {
    useModel(TEST_MODEL);
    useSandbox(readOnlyLocal());
    useSubagent(explorer);
    useSubagent(planner);
    useSubagent(implementer);
    useSubagent(reviewer);
    return 'Delegate each supplied, self-contained specialist task.';
}

const results = {
    explorer: {
        schemaVersion: 1,
        role: 'explorer',
        summary: 'Located the behavior.',
        findings: ['The entry point validates its input.'],
        evidence: [
            {
                path: 'src/example.ts',
                line: 4,
                symbol: 'run',
                observation: 'The function validates before dispatch.',
            },
        ],
        openQuestions: [],
    },
    planner: {
        schemaVersion: 1,
        role: 'planner',
        summary: 'Add focused validation coverage.',
        steps: [
            {
                description: 'Cover invalid input at the entry point.',
                affectedFiles: ['tests/example.test.ts'],
                affectedSymbols: ['run'],
            },
        ],
        tests: ['Run the focused test file.'],
        risks: [],
    },
    implementer: {
        schemaVersion: 1,
        role: 'implementer',
        summary: 'Added validation coverage.',
        changes: [
            {
                path: 'tests/example.test.ts',
                summary: 'Tests invalid input.',
            },
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
        verdict: 'approved',
        summary: 'The diff satisfies the objective.',
        findings: [],
        validation: [
            {
                command: 'npm test',
                result: 'passed',
                exitCode: 0,
                summary: 'All tests passed independently.',
            },
        ],
        limitations: [],
    },
} as const;

const prompts = {
    explorer:
        'Objective: verify input validation. Acceptance: identify the entry point and evidence. Scope: src and tests; no prior findings.',
    planner:
        'Objective: add invalid-input coverage. Acceptance: focused tests pass. Evidence: src/example.ts exports run; preserve its API.',
    implementer:
        'Objective: add invalid-input coverage. Acceptance: tests pass. Plan: update tests/example.test.ts around run. Constraint: preserve public APIs.',
    reviewer:
        'Objective: add invalid-input coverage. Acceptance: tests pass. Plan: update only tests/example.test.ts. Diff: add one rejection test in tests/example.test.ts. Validation report: npm test passed with exit 0. Known limitations: none.',
} as const;

test('specialist definitions load through Flue with capability-oriented catalogs', () => {
    assert.deepEqual(
        [explorer, planner, implementer, reviewer].map(
            (definition) => definition.name,
        ),
        ['explorer', 'planner', 'implementer', 'reviewer'],
    );
    for (const definition of [explorer, planner, implementer, reviewer]) {
        assert.equal(Object.isFrozen(definition), true);
        assert.ok(definition.description.length > 40);
    }
});

test('mocked specialist delegations return valid contracts and isolated capabilities', {
    timeout: 15_000,
}, async (t) => {
    const roles = Object.keys(results) as SubagentRole[];
    const calls = roles.map((role) =>
        fauxToolCall('task', {
            agent: role,
            prompt: prompts[role],
        }),
    );
    const responses = [
        fauxAssistantMessage(calls, { stopReason: 'toolUse' }),
        ...roles.map((role) =>
            fauxAssistantMessage(JSON.stringify(results[role])),
        ),
        fauxAssistantMessage('All specialist delegations completed.'),
    ];
    const { observations } = await createTestRuntime(
        t,
        [SpecialistHarness],
        responses,
    );

    const handle = init(SpecialistHarness, { id: 'specialist-delegations' });
    const receipt = await handle.dispatch('Run the four complete briefings.');
    assert.equal(
        (await handle.read(receipt)).text,
        'All specialist delegations completed.',
    );

    const tasks = observations.filter((event) => event.type === 'task');
    assert.equal(tasks.length, 4);
    for (const task of tasks) {
        const output = JSON.parse(String(task.result)) as {
            role: SubagentRole;
        };
        assert.deepEqual(
            validateSubagentResult(output.role, output),
            results[output.role],
        );
    }

    const childTurns = observations
        .filter((event) => event.type === 'turn_request')
        .map((event) => event.request.input)
        .filter((input) =>
            roles.some((role) =>
                input.systemPrompt?.includes(`"role": "${role}"`),
            ),
        );
    assert.equal(childTurns.length, 4);

    const expectedCustomTools: Record<SubagentRole, readonly string[]> = {
        explorer: [
            'inspect_repository',
            'read_github_issue',
            'submit_specialist_result',
        ],
        planner: [
            'inspect_repository',
            'read_github_issue',
            'submit_specialist_result',
        ],
        implementer: [
            'read_github_issue',
            'submit_specialist_result',
            'implement_write_file',
            'implement_replace_text',
            'implement_run_command',
        ],
        reviewer: [
            'read_github_issue',
            'review_run_command',
            'submit_specialist_result',
        ],
    };
    const allCustomTools = [
        'inspect_repository',
        'read_github_issue',
        'submit_specialist_result',
        'implement_write_file',
        'implement_replace_text',
        'implement_run_command',
        'review_run_command',
    ];

    for (const input of childTurns) {
        const role = roles.find((candidate) =>
            input.systemPrompt?.includes(`"role": "${candidate}"`),
        );
        assert.ok(role);
        const toolNames = input.tools?.map((tool) => tool.name) ?? [];
        for (const standard of ['read', 'grep', 'glob']) {
            assert.ok(
                toolNames.includes(standard),
                `${role} lacks ${standard}`,
            );
        }
        for (const custom of allCustomTools) {
            assert.equal(
                toolNames.includes(custom),
                expectedCustomTools[role].includes(custom),
                `${role} capability mismatch for ${custom}`,
            );
        }
    }
});
