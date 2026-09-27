# Security limitations and deferred isolation

**This MVP supports trusted prompts and trusted repositories only.** Do not use
it to process adversarial instructions, unknown repositories, or unreviewed
third-party code. Repository content can influence a model's commands.

Managed Git worktrees isolate ordinary development changes from the original
checkout; they do not isolate processes, the network, Git common metadata, or
host files. Restricted command environments reduce accidental credential
inheritance but do not prevent reading credentials from disk. Shell commands,
build scripts, tests and commit hooks execute with host-user permissions.
Read-only role capabilities are application policy, not an OS security boundary.
The structured `read_github_issue` capability invokes the authenticated local
`gh` CLI for the current repository only; issue content is external input and is
safe only under the trusted-prompt/trusted-repository assumptions above.

Publication fingerprints, revision-bound review and commit checks protect the
normal workflow against stale or rejected changes. They are not guarantees
against malicious shell commands. Failure-path tests demonstrate unchanged
original checkouts for controlled failures, not arbitrary hostile code.

Reports avoid exporting hidden reasoning and raw conversation databases, but
summaries, command strings, private audits, and model traffic can contain source
or secrets. Use an appropriate trusted model endpoint, private run storage, and
a least-privileged host account. A disposable repository alone is not sufficient
isolation for an untrusted evaluation.

## Deferred work

Container/OS-enforced isolation is explicitly deferred beyond the MVP. Future
work should cover filesystem mounts excluding host secrets and original checkout,
network/egress policy, non-root execution, process/resource limits, credential
brokerage, Git metadata isolation, and a narrowly authorized publication boundary.
Container support must include adversarial escape and publication tests before
any claim of support for untrusted repositories or prompts.
