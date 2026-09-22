import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import {
    createExecutionRequest,
    executeRequest,
    resumeRequest,
} from '../../src/cli.ts';
import {
    completionEligibility,
    replayLedger,
} from '../../src/delegation-ledger.ts';
import { buildReport } from '../../src/reporting.ts';
import { RunStore } from '../../src/run-storage.ts';
import { createGitFixture } from '../helpers/git.ts';

const exec = promisify(execFile);
const enabled = process.env.FLUE_AGENT_EVAL === '1';
const scenarios = [
    {
        name: 'trivial',
        prompt: 'What is 2 + 2? No repository changes are needed.',
    },
    {
        name: 'parallel',
        prompt: 'Independently investigate the alpha and beta subsystems: explain their exported functions and tests, and report risks for each. Do not change files.',
    },
    {
        name: 'simple',
        prompt: 'Change README.md to exactly "Accepted\\n" (a trailing newline). No other changes.',
    },
    {
        name: 'commit',
        prompt: 'Change README.md to exactly "Accepted\\n" (a trailing newline). No other changes.',
    },
    {
        name: 'complex',
        prompt: 'Migrate alpha.cjs and beta.cjs from numeric return values to { value: number } objects and update consumer.cjs to preserve its numeric public result. This is a cross-module API migration: assess compatibility and plan before implementation. Update case.test.cjs for the new producer contracts and add consumer coverage. Preserve the arithmetic and document the API in README.md.',
    },
    {
        name: 'repair',
        prompt: 'Exercise independent review of a proposed candidate. First have an implementer apply this exact candidate to alpha.cjs: module.exports = (a, b) => a - b; . This is an intermediate candidate, not an approved solution. Then independently review against the addition contract and case.test.cjs, repair substantiated findings, and re-review the corrected revision. Keep the tests unchanged; final alpha must add its arguments. Do not publish the intermediate candidate.',
    },
    {
        name: 'needs-input',
        prompt: 'Change the public alpha API to the new return format decided in our private product meeting. The decision is not in this repository and there is no default; ask me which format before changing anything.',
    },
    {
        name: 'exhaustion',
        prompt: 'Exercise the review/repair limit with a deliberately unsatisfiable candidate. First implement alpha.cjs as module.exports = (a, b) => a - b; then independently review it against case.test.cjs. The only permitted implementations in this exercise are a-b, a*b, and a/b; addition and test edits are forbidden. On changes_requested, try a different permitted candidate and get fresh review, up to two repairs. Report blocked with unresolved findings when the repair allowance is exhausted. Never publish a rejected candidate.',
    },
] as const;

for (const scenario of scenarios) {
    test(`real-model behavior: ${scenario.name}`, {
        skip: !enabled,
        timeout: 1_200_000,
    }, async (t) => {
        const repo = await createGitFixture(t);
        await repo.write('alpha.cjs', 'module.exports = (a, b) => a + b;\n');
        await repo.write('beta.cjs', 'module.exports = (a, b) => a * b;\n');
        await repo.write(
            'consumer.cjs',
            "module.exports = (a,b) => require('./alpha.cjs')(a,b) + require('./beta.cjs')(a,b);\n",
        );
        const checks =
            "const assert = require('node:assert/strict');\nassert.equal(require('./alpha.cjs')(2,3), 5);\nassert.equal(require('./beta.cjs')(2,3), 6);\nassert.equal(require('./consumer.cjs')(2,3), 11);\n";
        await repo.write('case.test.cjs', checks);
        await repo.git('add', '.');
        await repo.git('commit', '-m', 'Evaluation fixture');
        const head = await repo.git('rev-parse', 'HEAD');
        const store = new RunStore({ root: join(dirname(repo.path), 'state') });
        const request = await createExecutionRequest({
            repo: repo.path,
            env: repo.env,
            prompt: `${scenario.prompt}\nValidation command: node --test case.test.cjs. Work only within this disposable repository.`,
            commit: scenario.name === 'commit',
        });
        let id = '';
        const events: object[] = [];
        const options = {
            store,
            signal: t.signal,
            onReport: (report: { id: string }) => {
                id = report.id;
            },
            onEvent: (event: object) => events.push(event),
        };
        try {
            try {
                await executeRequest(request, options);
            } catch (error) {
                if (
                    scenario.name !== 'exhaustion' ||
                    !id ||
                    (await store.read(id)).status !== 'blocked'
                )
                    throw error;
            }
            let record = await store.read(id);
            if (scenario.name === 'needs-input') {
                assert.equal(record.status, 'needs_input');
                assert.equal(await repo.git('status', '--porcelain'), '');
                assert.equal(await repo.git('rev-parse', 'HEAD'), head);
                await repo.write('README.md', 'Concurrent operator edit\n');
                await assert.rejects(resumeRequest(id, 'Proceed', options));
                assert.equal((await store.read(id)).status, 'needs_input');
                assert.equal(
                    await readFile(join(repo.path, 'README.md'), 'utf8'),
                    'Concurrent operator edit\n',
                );
                await repo.write('README.md', '# Test repository\n');
                await resumeRequest(
                    id,
                    'Keep the numeric API unchanged. Only replace README.md with Accepted and a trailing newline.',
                    options,
                );
                record = await store.read(id);
            }
            const entries = replayLedger(record.ledger).delegations;
            const roles = entries.map((entry) => entry.role);
            assert.equal(
                record.status,
                scenario.name === 'exhaustion' ? 'blocked' : 'completed',
            );
            if (scenario.name === 'trivial') assert.equal(entries.length, 0);
            if (scenario.name === 'parallel') {
                const explorers = entries.filter(
                    (entry) => entry.role === 'explorer',
                );
                assert.ok(
                    explorers.some((a) =>
                        explorers.some(
                            (b) =>
                                a.id !== b.id &&
                                a.completedAt &&
                                b.completedAt &&
                                a.startedAt < b.completedAt &&
                                b.startedAt < a.completedAt,
                        ),
                    ),
                    'independent explorer intervals must overlap',
                );
            }
            if (scenario.name === 'simple' || scenario.name === 'commit')
                assert.ok(!roles.includes('planner'));
            if (scenario.name === 'complex')
                assert.ok(roles.includes('planner'));
            if (scenario.name === 'repair' || scenario.name === 'exhaustion') {
                const rejection = entries.find(
                    (entry) =>
                        entry.result?.role === 'reviewer' &&
                        entry.result.verdict === 'changes_requested',
                );
                assert.ok(rejection, 'review must reject the candidate');
                const repairs = entries.filter(
                    (entry) =>
                        entry.role === 'implementer' &&
                        entry.sequence > rejection.sequence,
                );
                assert.ok(
                    repairs.length >= (scenario.name === 'exhaustion' ? 2 : 1),
                );
                assert.ok(
                    repairs.length <= 2,
                    'repair allowance must be respected',
                );
                const firstRepair = repairs[0];
                assert.ok(firstRepair);
                if (scenario.name === 'repair')
                    assert.ok(
                        entries.some(
                            (entry) =>
                                entry.sequence > firstRepair.sequence &&
                                entry.result?.role === 'reviewer' &&
                                entry.result.verdict === 'approved' &&
                                entry.patchEpoch > rejection.patchEpoch,
                        ),
                    );
            }
            const unchanged = ['trivial', 'parallel', 'exhaustion'].includes(
                scenario.name,
            );
            if (unchanged) {
                assert.equal(await repo.git('status', '--porcelain'), '');
            } else {
                assert.ok(roles.includes('implementer'));
                assert.ok(roles.includes('reviewer'));
                assert.ok(completionEligibility(record.ledger).eligible);
                assert.ok(
                    events.some(
                        (event) => 'type' in event && event.type === 'command',
                    ),
                );
                await exec(process.execPath, ['--test', 'case.test.cjs'], {
                    cwd: repo.path,
                    env: repo.env,
                });
                if (scenario.name === 'complex')
                    await exec(
                        process.execPath,
                        [
                            '-e',
                            `
                    const assert = require('node:assert/strict');
                    for (const [a,b] of [[2,3], [-4,7], [0,0]]) {
                        assert.deepEqual(require('./alpha.cjs')(a,b), {value:a+b});
                        assert.deepEqual(require('./beta.cjs')(a,b), {value:a*b});
                        assert.equal(require('./consumer.cjs')(a,b), a+b+a*b);
                    }
                `,
                        ],
                        { cwd: repo.path, env: repo.env },
                    );
                if (['simple', 'commit', 'needs-input'].includes(scenario.name))
                    assert.equal(
                        await readFile(join(repo.path, 'README.md'), 'utf8'),
                        'Accepted\n',
                    );
            }
            if (scenario.name !== 'complex')
                assert.equal(
                    await readFile(join(repo.path, 'case.test.cjs'), 'utf8'),
                    checks,
                );
            assert.equal(await repo.git('diff', '--cached'), '');
            assert.equal(
                (await repo.git('rev-parse', 'HEAD')) === head,
                scenario.name !== 'commit',
            );
            if (scenario.name === 'commit') {
                assert.equal(await repo.git('status', '--porcelain'), '');
                assert.equal(
                    await repo.git('rev-list', '--count', `${head}..HEAD`),
                    '1',
                );
            }
        } finally {
            // Public evidence only: never export conversation databases or reasoning.
            const directory = resolve(
                process.env.FLUE_AGENT_EVAL_RESULTS ?? '.eval-results',
            );
            await mkdir(directory, { recursive: true });
            await writeFile(
                join(directory, `${scenario.name}-${Date.now()}.json`),
                JSON.stringify(
                    {
                        scenario: scenario.name,
                        configuration: request.configuration,
                        report: id ? await buildReport(store, id) : null,
                        ledger: id ? (await store.read(id)).ledger : [],
                        events,
                    },
                    null,
                    2,
                ),
            );
        }
    });
}
