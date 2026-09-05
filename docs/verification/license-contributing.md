# Verification: License and contribution rules

## Problem and scope

The repository had no license or contribution instructions.
The maintainer requested commercial use, attribution, publication notices, meaningful contributions, and verification evidence.
The maintainer then selected Apache-2.0 with optional publication notices in the session on 2026-09-05.
That reply replaced the earlier request for mandatory notification.
The maintainer authorized a worktree, commit, pull request, and merge if the checks pass.

The change adds LICENSE, NOTICE, contribution rules, a verification template, and a pull request template.
The README explains the license and optional notices.
The package metadata declares Apache-2.0 and includes LICENSE and NOTICE.
The package smoke check requires both files.
No application source code changes.

Acceptance checks:

- Preserve the official Apache-2.0 license text.
- Include LICENSE and NOTICE in the package archive.
- Require meaningful contributions and verification documents.
- Welcome tested agent contributions.
- Keep publication notices optional and exempt from contribution requirements.

## Environment

- Date: 2026-09-05.
- System: Linux x86_64, with native execution.
- Node.js: v24.20.0.
- npm: 11.19.0.
- Bun: 1.4.2.
- Current main base: 8c601b6.
- Tested commit after integration: 93a98d6.
- Tested state: Integrated commit before this evidence update.
- Worktree: `/tmp/statewell-license-contributing`.

The existing dependency directory supplied build dependencies through a temporary link.
The Bun executable was `/tmp/statewell-bun-storage-prototype/tooling/node_modules/.bin/bun`.
Place Bun on PATH before you repeat the build command.

## Verification steps and results

| Check | Command or steps | Expected result | Actual result | Status |
| --- | --- | --- | --- | --- |
| Official license | Download the official text linked below. Compare it with LICENSE through `cmp`. | Exact match. | Exit status 0. | Pass. |
| Build | Run `bun run build` with Bun on PATH. | Produce the Linux x64 executable. | Compiled 255 modules successfully. | Pass. |
| Package behavior | Set STATEWELL_BUN to the Bun executable. Run `bash scripts/package-smoke.sh`. | Check archive contents, install locally, and pass packaged tests. | Six expected files; installation passed; 26 tests passed; 0 failed; 148 assertions. | Pass. |
| Script syntax | Run `bash -n scripts/package-smoke.sh`. | No syntax error. | Exit status 0. | Pass. |
| Whitespace | Run `git diff --check`. | No whitespace errors. | Exit status 0. | Pass. |
| Document links | Resolve each local Markdown target from its source document. Check the README license anchor. | All targets exist. | All local targets exist. The license heading exists. | Pass. |
| Policy review | Compare CONTRIBUTING.md and both templates with the accepted request. | Cover useful changes, rejection, bans, agents, and evidence. | All required subjects are present. Publication notices have an explicit exception. | Pass. |
| Package metadata | Inspect package.json and the package smoke output. | Declare Apache-2.0 and include the required notices. | License field and archive contents agree. | Pass. |

Expected package files:

- `LICENSE`.
- `NOTICE`.
- `README.md`.
- `package.json`.
- `dist/statewell`.
- `docs/INSTANCE-CLI.md`.

LICENSE has SHA-256 `cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30`.

## Coverage and limitations

The first build could not find Bun on PATH.
The build passed after the temporary Bun directory was added to PATH.
The sandbox blocked the first package check at the Node.js tar subprocess with EPERM.
The same package check passed outside the sandbox with disposable installation and data directories.

Application code did not change. The full source test suite and type check were not run for this change.
The compiled package tests cover the affected distribution path.
Main advanced with instance lifecycle changes during this task.
Those changes were merged into the branch before the final build and package check.
Both instance and lifecycle test files passed.
No package was published to npm.

Manual review checked facts, terms, decision status, short sentences, instructions, and local links.
No formal ASD-STE100 dictionary audit was performed.
The official license text remains unchanged under the repository exception for license text.
GitHub template links target files that become available on main after merge.

The main checkout contains unrelated edits and untracked design documents.
Those documents were not added or changed in this worktree.
Any local statements that license selection remains open will need correction when those drafts are prepared for commit.

## Agent assistance

Codex drafted and reviewed the changes, compared the license, built the executable, and ran the package check.
The maintainer supplied the contribution requirements and selected Apache-2.0 with optional notification.
Verification results above come from executed commands and file inspection.

## Sources

- [Official Apache-2.0 text](https://www.apache.org/licenses/LICENSE-2.0.txt).
- [Apache licensing FAQ](https://www.apache.org/foundation/license-faq).
- [npm package metadata documentation](https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md).

## Review status

The accepted license choice and contribution requirements are implemented.
The affected checks passed.
No unresolved failure prevents acceptance.
