Name: repo-pr-finalize
Domain: PR cleanup + finalization for this repository (contracts + deploy scripts + tests)
Purpose: Provide a repeatable checklist to take a feature branch/PR from "mostly done" to "merge-ready" by tightening tests/coverage, validating deploy scripts, and addressing review feedback (including the @codex GitHub review loop).

When to use
- You have an open PR and want to finalize it: coverage + deploy validations + addressing PR comments until clean.
- You changed deploy scripts and need to ensure local deploy + deploy tests still pass.

Pre-reqs / conventions
- Follow the repo test style in `skills/testing-style/SKILL.md` when adding tests.
- Prefer small, focused commits with Conventional Commit prefixes (`fix:`, `test:`, `refactor:`, `docs:`, `chore:`).
- Avoid committing local timestamp churn under `deployments/outputs/platforms/localhost.json`.

Inputs (collect up front)
- PR number (e.g., `104`) and repo (usually `zkp2p/zkp2p-contracts`)
- Base branch name (e.g., `feat/deposit-rate-manager-v1`)
- Coverage threshold for the change (target: >99% overall; new/changed lines 100%)

Workflow (do in this order)

1) Sync + sanity
- `git status --porcelain`
- `git log -5 --oneline`
- Confirm you are on the correct branch and it tracks the PR head.

2) Coverage gate (run once unless you must confirm a fix)
- Run: `yarn coverage`
- If coverage is below target:
  - Use the report to find missing lines/branches (`coverage/` html + `coverage.json`).
  - Add tests for the uncovered paths (use `skills/testing-style/SKILL.md`).
  - Re-run `yarn coverage` once to confirm the fix (do not loop coverage runs).
- Commit + push.

3) Deploy script validation (contracts added/removed/renamed)
- Start a local node in the background:
  - `yarn chain`
- Deploy locally:
  - `yarn deploy:localhost`
- Run deploy tests against localhost:
  - `npx hardhat test --network localhost test/deploy/*.ts`
- If deploy scripts fail:
  - Make them idempotent and resilient to partially-initialized networks.
  - Avoid hard assumptions about new deployment JSONs existing; use safe lookups where needed.
  - For owner-only config calls, use the helper pattern that prints calldata (do not revert the deploy run).
- Ensure no noisy localhost artifacts are staged (especially `deployments/outputs/platforms/localhost.json`).
- Commit + push.

4) Address PR feedback (humans + bots)
- Pull PR issue comments:
  - `gh pr view <PR> --repo zkp2p/zkp2p-contracts --comments`
- Pull inline review comments:
  - `gh api repos/zkp2p/zkp2p-contracts/pulls/<PR>/comments --paginate`
- For each actionable comment:
  - Implement the fix (or explicitly decide it is not needed and document why in a PR reply).
  - Add/adjust tests if behavior changes.
  - Commit + push.

5) @codex review loop (repeat until clean)
- Trigger:
  - `gh pr comment <PR> --repo zkp2p/zkp2p-contracts --body "@codex review"`
- Wait ~10 minutes:
  - `sleep 600`
- Re-check inline comments and PR comments:
  - `gh api repos/zkp2p/zkp2p-contracts/pulls/<PR>/comments --paginate`
  - `gh pr view <PR> --repo zkp2p/zkp2p-contracts --comments`
- If Codex suggests fixes:
  - Apply them, commit + push, then trigger `@codex review` again.
- Stop when Codex reports no major issues (or only non-actionable nitpicks).

6) PR description hygiene (quick pass)
- Ensure PR body includes:
  - Summary + rationale
  - What changed (contract/interface names)
  - Indexer updates required (events + decoding rules, if any)
- If names changed during iteration (e.g., interface renames), update the PR body so it is accurate.

Done criteria
- CI is green (tests + coverage).
- Local deploy + deploy tests pass.
- No unresolved inline review comments.
- Latest `@codex review` reports no major issues.
