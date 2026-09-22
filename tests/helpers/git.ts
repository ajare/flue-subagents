import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { TestContext } from 'node:test';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** Each fixture owns its Git config, HOME, and initial commit. */
export async function createGitFixture(t: TestContext) {
    const root = await mkdtemp(join(tmpdir(), 'flue-git-'));
    const dispose = () => rm(root, { recursive: true, force: true });
    t.after(dispose);
    const path = join(root, 'repo');
    const home = join(root, 'home');
    await mkdir(path);
    await mkdir(home);
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
        if (key.startsWith('GIT_')) delete env[key];
    }
    Object.assign(env, {
        HOME: home,
        XDG_CONFIG_HOME: home,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
        GIT_AUTHOR_DATE: '2025-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2025-01-01T00:00:00Z',
    });
    const git = async (...args: string[]) => {
        const result = await exec('git', args, { cwd: path, env });
        return result.stdout.trimEnd();
    };
    await git('init', '--initial-branch=main', '--template=');
    await git('config', 'user.name', 'Flue Test');
    await git('config', 'user.email', 'test@example.invalid');
    await git('config', 'commit.gpgsign', 'false');
    await git('config', 'core.hooksPath', '/dev/null');
    await git('config', 'core.autocrlf', 'false');
    await writeFile(join(path, 'README.md'), '# Test repository\n');
    await git('add', '.');
    await git('commit', '-m', 'Initial fixture');
    return {
        path,
        env,
        git,
        dispose,
        async write(relativePath: string, content: string) {
            const destination = join(path, relativePath);
            await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, content);
        },
    };
}
