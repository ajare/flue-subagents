import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CommandAuditRecord } from '../src/command-audit.ts';
import { MutationCoordinator } from '../src/mutation-coordinator.ts';
import { readOnlyLocal } from '../src/sandboxes/read-only-local.ts';
import { workspaceLocal } from '../src/sandboxes/workspace-local.ts';
import { inspectionCommand } from '../src/tools/inspection-tools.ts';

async function temporaryDirectory(): Promise<string> {
    return mkdtemp(join(tmpdir(), 'flue-capabilities-'));
}

test('read-only sandbox exposes read, grep, and glob but no mutation or shell tools', async () => {
    const factory = readOnlyLocal();
    const sandbox = await factory.createSandbox({ id: 'capabilities' });
    const names = factory
        .tools?.(sandbox, { subagents: {} })
        .map((tool) => tool.name);
    assert.deepEqual(names, ['read', 'grep', 'glob']);
});

test('inspection commands are structured and reject shell and path escapes', () => {
    assert.equal(
        inspectionCommand({ command: 'git-status' }),
        'git --no-pager status --short --branch',
    );
    assert.equal(
        inspectionCommand({ command: 'git-diff', paths: ['src/two words.ts'] }),
        "git --no-pager diff --no-ext-diff --no-textconv -- 'src/two words.ts'",
    );
    assert.throws(
        () => inspectionCommand({ command: 'git-diff', paths: ['../outside'] }),
        /Unsupported repository path/,
    );
    assert.throws(
        () =>
            inspectionCommand({
                command: 'git-show',
                revision: 'HEAD; touch bad',
            }),
        /unsupported characters/,
    );
});

test('mutation coordinator permits only one mutating operation at a time', async () => {
    const coordinator = new MutationCoordinator();
    let active = 0;
    let maximum = 0;
    const operation = () =>
        coordinator.run(undefined, async () => {
            active += 1;
            maximum = Math.max(maximum, active);
            await new Promise((resolve) => setTimeout(resolve, 25));
            active -= 1;
        });
    await Promise.all([operation(), operation(), operation()]);
    assert.equal(maximum, 1);
});

test('workspace commands are audited and cancellation kills the process group', async (t) => {
    const cwd = await temporaryDirectory();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const records: CommandAuditRecord[] = [];
    const sandbox = await workspaceLocal({
        cwd,
        env: { PATH: process.env.PATH ?? '' },
        checkLimit: async () => {},
        commandTimeoutMs: 5_000,
        commandAudit: {
            async record(record) {
                records.push(record);
            },
        },
    }).createSandbox({ id: 'audit' });

    const completed = await sandbox.exec(
        "printf 'out'; printf 'err' >&2; exit 3",
    );
    assert.deepEqual(completed, { exitCode: 3, stdout: 'out', stderr: 'err' });

    const controller = new AbortController();
    const pending = sandbox.exec('(sleep 0.3; printf leaked > marker) & wait', {
        signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('cancelled by test')), 40);
    await assert.rejects(pending, { name: 'AbortError' });
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(access(join(cwd, 'marker')), { code: 'ENOENT' });

    assert.equal(records.length, 2);
    assert.deepEqual(
        {
            exitCode: records[0]?.exitCode,
            stdout: records[0]?.stdout,
            stderr: records[0]?.stderr,
            outcome: records[0]?.outcome,
            cwd: records[0]?.cwd,
        },
        {
            exitCode: 3,
            stdout: 'out',
            stderr: 'err',
            outcome: 'completed',
            cwd,
        },
    );
    assert.equal(records[1]?.outcome, 'cancelled');
    assert.equal(records[1]?.exitCode, null);
    assert.ok((records[1]?.durationMs ?? 0) >= 0);
});

test('workspace command timeout is capped and audited with exit 124', async (t) => {
    const cwd = await temporaryDirectory();
    t.after(() => rm(cwd, { recursive: true, force: true }));
    const auditPath = join(cwd, 'audit.ndjson');
    const { FileCommandAuditLog } = await import('../src/command-audit.ts');
    const sandbox = await workspaceLocal({
        cwd,
        env: { PATH: process.env.PATH ?? '' },
        checkLimit: async () => {},
        commandTimeoutMs: 50,
        commandAudit: new FileCommandAuditLog(auditPath),
    }).createSandbox({ id: 'timeout' });

    const command = '(sleep 0.3; printf leaked > timeout-marker) & wait';
    const result = await sandbox.exec(command, { timeoutMs: 10_000 });
    assert.equal(result.exitCode, 124);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await assert.rejects(access(join(cwd, 'timeout-marker')), {
        code: 'ENOENT',
    });
    const record = JSON.parse(
        (await readFile(auditPath, 'utf8')).trim(),
    ) as CommandAuditRecord;
    assert.equal(record.command, command);
    assert.equal(record.exitCode, 124);
    assert.equal(record.outcome, 'completed');
});
