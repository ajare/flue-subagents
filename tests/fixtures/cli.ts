export {};

const args = process.argv.slice(2);
if (args[0] === '--wait') {
    process.stdout.write('ready\n');
    setInterval(() => {}, 1000);
} else {
    let stdin = '';
    for await (const chunk of process.stdin) stdin += chunk;
    process.stdout.write(JSON.stringify({ args, stdin, cwd: process.cwd() }));
    process.stderr.write('fixture stderr\n');
    process.exitCode = args.includes('--fail') ? 7 : 0;
}
