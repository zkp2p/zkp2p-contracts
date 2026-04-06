---
name: audit
description: Run security audits on ZKP2P V2 contracts using Trail of Bits security skills. Supports full audits, differential PR reviews, and individual security checks.
---

# /audit — Security Audit Skill

Run structured security audits on ZKP2P V2 contracts.

## Modes

Parse the argument to determine mode:

| Invocation | Mode | Description |
|-----------|------|-------------|
| `/audit` or `/audit full` | Full | 10-step comprehensive audit |
| `/audit diff` | Differential | Review current branch vs main |
| `/audit pr <number>` | Differential | Review a specific PR |
| `/audit check <skill>` | Single | Run one security skill |
| `/audit maturity` | Single | Quick code maturity assessment |
| `/audit entries` | Single | Entry point mapping only |

## Mode: Full Audit

Run the 10-step workflow. This is thorough and takes time.

### Step 1: Scope
Confirm scope. Default is all V2 contracts:
```
contracts/EscrowV2.sol
contracts/OrchestratorV2.sol
contracts/RateManagerV1.sol
contracts/ProtocolViewerV2.sol
contracts/unifiedVerifier/
contracts/registries/
contracts/hooks/
contracts/oracles/
contracts/lib/
```
Excluded: `contracts/mocks/`, `contracts/external/`, `contracts/archive/`, V1 contracts (`Escrow.sol`, `Orchestrator.sol`, `ProtocolViewer.sol`).

### Step 2: Entry Point Mapping
```
Run skill: entry-point-analyzer:entry-point-analyzer
Scope: contracts/ (V2 only)
```
Save raw output to `audits/_scratch/entry-points.md`.

### Step 3: Code Maturity Assessment
```
Run skill: building-secure-contracts:code-maturity-assessor
Scope: contracts/ (V2 only)
```
Save raw output to `audits/_scratch/code-maturity.md`.

### Step 4: Guidelines Check
```
Run skill: building-secure-contracts:guidelines-advisor
Scope: contracts/ (V2 only)
```
Save raw output to `audits/_scratch/guidelines.md`.

### Step 5: Static Analysis
```
Run skill: static-analysis:semgrep
Scope: contracts/ (exclude mocks, archive, external)
```
Save raw output to `audits/_scratch/semgrep.md`.

### Step 6: Token Integration
```
Run skill: building-secure-contracts:token-integration-analyzer
Focus: USDC (ERC20) integration in EscrowV2, OrchestratorV2
```
Save raw output to `audits/_scratch/token-integration.md`.

### Step 7: Sharp Edges
```
Run skill: sharp-edges:sharp-edges
Scope: contracts/ (V2 only)
```
Save raw output to `audits/_scratch/sharp-edges.md`.

### Step 8: Deep Context
Based on findings from steps 2-7, identify the 3-5 highest-risk functions. Then:
```
Run skill: audit-context-building:audit-context-building
Focus: identified high-risk functions
```
Save raw output to `audits/_scratch/deep-context.md`.

### Step 9: Property Testing Recommendations
```
Run skill: property-based-testing:property-based-testing
Focus: key invariants (liquidity conservation, fee bounds, nullifier uniqueness, expiry, oracle floors, access control)
```
Save raw output to `audits/_scratch/property-testing.md`.

### Step 10: Synthesize Report
1. Read all `audits/_scratch/*.md` outputs
2. Read `audits/templates/full-audit-template.md`
3. Deduplicate findings across tools
4. Assign severity: CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL
5. Write final report to `audits/full/YYYY-MM-DD-full-audit.md`
6. Get current commit SHA: `git rev-parse --short HEAD`
7. Stage and commit:
   ```bash
   git add audits/full/YYYY-MM-DD-full-audit.md
   git commit -m "audit: full security audit at <sha>"
   ```

## Mode: Differential Review

### Step 1: Determine Diff Range
- If `/audit diff`: compare current branch to `main`
- If `/audit pr <number>`: fetch PR diff with `gh pr diff <number>`
- List changed files, filter to `contracts/` only
- If no contract changes, report "No contracts changed" and exit

### Step 2: Run Differential Review
```
Run skill: differential-review:differential-review
Input: the diff from step 1
```

### Step 3: Deep Dive (conditional)
If any HIGH or CRITICAL findings from step 2:
```
Run skill: audit-context-building:audit-context-building
Focus: functions containing critical findings
```

### Step 4: Write Report
1. Read `audits/templates/differential-template.md`
2. Fill in findings, blast radius, test coverage assessment
3. Write to `audits/differential/YYYY-MM-DD-pr-<number>.md` or `audits/differential/YYYY-MM-DD-<branch>.md`
4. Stage and commit:
   ```bash
   git add audits/differential/YYYY-MM-DD-*.md
   git commit -m "audit: differential review of PR #<number> at <sha>"
   ```

## Mode: Single Check

Run one specific skill and print results inline. Do NOT commit unless user asks.

| Shortcut | Skill |
|----------|-------|
| `semgrep` | `static-analysis:semgrep` |
| `codeql` | `static-analysis:codeql` |
| `maturity` | `building-secure-contracts:code-maturity-assessor` |
| `guidelines` | `building-secure-contracts:guidelines-advisor` |
| `entries` | `entry-point-analyzer:entry-point-analyzer` |
| `token` | `building-secure-contracts:token-integration-analyzer` |
| `sharp` | `sharp-edges:sharp-edges` |
| `context <function>` | `audit-context-building:audit-context-building` |
| `variants <pattern>` | `variant-analysis:variant-analysis` |
| `property` | `property-based-testing:property-based-testing` |
| `prep` | `building-secure-contracts:audit-prep-assistant` |
| `workflow` | `building-secure-contracts:secure-workflow-guide` |
| `rules` | `semgrep-rule-creator:semgrep-rule-creator` |
