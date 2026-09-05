# Contributing to Statewell

## Meaningful contributions

We accept contributions that solve a clear problem or provide a useful improvement.
Examples include defect fixes, useful features, security improvements, performance improvements, and documentation that corrects a substantive error.
A small change can qualify when it fixes incorrect behavior, a broken instruction, or an accessibility problem.

We reject issues and pull requests that contain only minor spelling changes, cosmetic edits, or changes without a clear benefit.
Contributors who submit these changes will be banned from further participation in this repository.
Maintainers apply this policy after review. No automatic ban system is provided.
Do not divide one change into several submissions to increase contribution counts.

## Before you start

1. Search existing [GitHub issues](https://github.com/statewell/statewell/issues) for the same problem.
2. Explain the problem, benefit, scope, and acceptance checks in an issue.
3. Obtain maintainer agreement before substantial feature work or changes to project requirements.
4. Read the repository instructions and the documents that apply to your change.
5. Keep unrelated changes outside the contribution.

A direct maintainer request can provide the required agreement.
Use issues for problem reports and specifications.
Use pull requests to submit completed changes for review.

## Issues

Describe the expected result and the actual result.
For a defect, provide reproduction steps and the relevant environment details.
For a proposal, explain the use case and how reviewers can check success.
Include a Markdown verification document with the issue.
You can attach the document or include its complete text in the issue body.
Use the [verification template](docs/verification/TEMPLATE.md).
Mark checks that you did not run. Do not report planned checks as passing evidence.

## Pull requests

1. Explain the problem and the resulting behavior.
2. Link the relevant issue or identify the direct maintainer request.
3. Add a completed verification document under `docs/verification/` with a descriptive file name.
4. Link that document in the pull request body.
5. Run the checks that apply to the changed behavior.
6. Record the commands, expected results, actual results, and test environment.
7. Record failures, omitted checks, limitations, and remaining risks.
8. Update the verification document after changes that affect the recorded results.

Use the [verification template](docs/verification/TEMPLATE.md).
A checklist without results does not meet the verification requirement.
Unresolved failures in the affected behavior prevent acceptance.
Explain why an omitted check does not apply, or obtain maintainer agreement before acceptance.

For code changes, run the configured type check, tests, and build from `package.json`.
Add tests for changed behavior where automated checks can detect a regression.
Check failure cases and relevant boundary conditions.
For package changes, also run `scripts/package-smoke.sh` after the build.
For documentation changes, check facts, links, terms, decision status, and language.
Write project text in ASD-STE100 Simplified Technical English.
Preserve required license text and third-party notices.

Never include credentials, private records, personal databases, backups, or model files in a submission.

## Agent contributions

Contributions from agents and large language models (LLMs) are welcome.
The same scope, review, and verification requirements apply to human and agent contributions.

Review all generated changes before submission.
Check that each change meets the stated requirements.
Run the relevant tests and inspect their results.
A model statement that tests pass is not verification evidence.
In the verification document, identify agent assistance and state what the submitter reviewed and tested.
The submitter remains responsible for correctness, licensing, and the evidence.
Untested generated changes do not qualify for acceptance.

## Contribution license

By intentionally submitting a contribution for inclusion, you agree to the contribution terms in Section 5 of [LICENSE](LICENSE).
Submit only material that you have the right to contribute under those terms.
Identify third-party material and preserve its required license and attribution notices.

## Publication notices

The request to report a modified package is optional, as explained in [README.md](README.md#license).
A publication notice does not need a contribution verification document.
The policy against minor contributions does not apply to publication notices.
