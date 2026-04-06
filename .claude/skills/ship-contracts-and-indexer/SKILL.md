---
name: ship-contracts-and-indexer
description: >-
  Full deployment pipeline for ZKP2P V2 contracts and indexer updates. Deploys
  new contracts (EscrowV2, OrchestratorV2, hooks) to a target network, runs
  deployment tests, verifies on etherscan, commits artifacts, opens a contracts
  PR, bumps and publishes the @zkp2p/contracts-v2 npm package, updates the
  zkp2p-indexer repo with new addresses, rebases releases branch, triggers Envio
  deploy, and announces to Slack. Use this skill whenever the user says "ship
  contracts", "deploy staging", "deploy and ship", "ship to staging",
  "redeploy escrow", "deploy new contracts", "full deploy pipeline", or anything
  about deploying contracts and updating the indexer. Also use when the user says
  "ship it" in the context of the contracts repo.
---

# Ship Contracts and Indexer

End-to-end deployment pipeline for ZKP2P V2 contracts + indexer. Takes a target network (default: `base_staging`) and orchestrates the full release cycle.

## Prerequisites

Before starting, confirm with the user:
1. The deploy script exists (e.g., `deploy/19_redeploy_*.ts` or a new one)
2. Which contracts are being redeployed and why (the PR description needs this)
3. Which network to target (default: `base_staging`)

If the deploy script doesn't exist yet, help the user write one following the pattern in `deploy/19_redeploy_escrowv2_orchestratorv2_staging.ts`. Key elements:
- Import parameters from `deployments/parameters.ts`
- Import helpers from `deployments/helpers.ts`
- Define `OLD_*` address maps for the contracts being replaced
- Deploy new contracts, wire registries (add new, remove old), transfer ownership
- Skip logic: skip if old addresses no longer match current deployments
- Dependencies: `["16_configure_v2_payment_methods"]`

---

## Pipeline Steps

Execute these in order. At each step, report progress to the user.

### Step 1: Deploy Contracts

```bash
yarn deploy:base_staging
# or yarn deploy:base for production
```

Verify the output shows:
- New contract addresses deployed
- Registry wiring completed (add new, remove old)
- Ownership transferred

Extract and save the new addresses from the deploy output. You'll need them for steps 4, 6, and 8.

### Step 2: Export Deployment Outputs

```bash
npx hardhat export --export-all deployments/outputs/baseStagingContracts.ts --network base_staging
```

This regenerates the auto-exported address file that the npm package uses.

### Step 3: Run Deployment Tests

```bash
npx hardhat test test/deploy/*.ts --network base_staging
```

All tests must pass. These validate that deployed contracts are correctly wired (registries, ownership, parameters). If any fail, investigate and fix before proceeding.

### Step 4: Commit Artifacts and Open Contracts PR

1. Stage deployment artifacts:
   ```bash
   git add deployments/base_staging/*.json deployments/outputs/ deploy/
   ```
   - Include: contract JSONs, outputs, deploy scripts
   - Exclude: `deployments/base_staging/solcInputs/` (large, not needed), any payment platform artifacts

2. Commit with conventional format:
   ```
   fix(base-staging): redeploy EscrowV2 and OrchestratorV2 with <reason>
   ```

3. Push and open PR. Include in the description:
   - New contract addresses (EscrowV2, OrchestratorV2, any hooks)
   - Which PRs/commits are included in this deployment
   - Link to the deploy script

### Step 5: Verify on Etherscan

```bash
yarn etherscan:base_staging
```

Report results. Some old contracts may fail verification (bytecode mismatch from earlier deployments) -- that's expected. Only the newly deployed contracts need to verify successfully.

### Step 6: Bump, Build, and Publish NPM Package

1. Bump version in `packages/contracts/package.json`:
   - RC bump: `0.2.0-rc.6` -> `0.2.0-rc.7` (for staging)
   - Minor bump: for production releases

2. Build the package:
   ```bash
   cd packages/contracts && yarn build && cd ../..
   ```

3. Verify the build contains the correct new addresses:
   ```bash
   cat packages/contracts/addresses/baseStaging.json | grep -i escrow
   cat packages/contracts/addresses/baseStaging.json | grep -i orchestrator
   ```
   The addresses must match what was deployed in Step 1.

4. Verify ABIs contain the correct types (especially if ABI changes were part of the deployment):
   ```bash
   # Example: check for int16 vs uint16 in spreadBps
   grep -r "spreadBps" packages/contracts/abis/
   ```

5. Commit the version bump:
   ```bash
   git add packages/contracts/package.json
   git commit -m "chore: bump @zkp2p/contracts-v2 to 0.2.0-rc.X"
   ```

6. Publish:
   ```bash
   cd packages/contracts && npm publish --tag rc && cd ../..
   ```
   An automation token is configured in `~/.npmrc` so no OTP is needed for RC publishes.

7. Verify publication:
   ```bash
   npm view @zkp2p/contracts-v2 versions --json | tail -5
   ```

### Step 7: Update Indexer Repo

The indexer repo is at `../zkp2p-indexer`.

1. Pull latest main:
   ```bash
   cd ../zkp2p-indexer && git checkout main && git pull
   ```

2. Create a new branch:
   ```bash
   git checkout -b feat/update-v22-staging-addresses
   ```

3. Update `config.base_staging.yaml`:
   - **Replace** (not add) the EscrowV2 address with the new one
   - **Replace** (not add) the OrchestratorV2 address with the new one
   - Only one address per contract -- no arrays for V2.2 contracts

4. Update `CLAUDE.md` staging section if addresses changed.

5. Commit and push:
   ```bash
   git add config.base_staging.yaml CLAUDE.md
   git commit -m "feat: update V2.2 staging contract addresses"
   git push -u origin feat/update-v22-staging-addresses
   ```

6. Open PR with description mentioning:
   - New contract addresses
   - The contracts PR link
   - What changes are included in this release

7. After PR is merged (or if user wants to proceed), rebase `releases/staging`:
   ```bash
   git checkout releases/staging
   git pull
   git rebase main
   git push --force-with-lease
   ```

### Step 8: Deploy Indexer to Envio

If in the indexer repo context with Chrome DevTools MCP available, use the `envio-deploy-staging` skill. Otherwise, instruct the user to:
1. Go to https://envio.dev/app/zkp2p/zkp2p-indexer-staging
2. Delete oldest non-production deployment if at 3/3
3. Deploy the latest commit on `releases/staging`
4. Monitor logs until status shows "Live"

### Step 9: Announce to Slack

Send a message to `#dev-humans-discussion` channel:

```
shipped @zkp2p/contracts-v2@0.2.0-rc.X to npm and deployed to base staging.

new addresses:
- escrowv2: 0x...
- orchestratorv2: 0x...

contracts pr: <link>
indexer pr: <link>

indexer reindexing on envio staging.

:<sign>:
```

Use lowercase. Sign with whatever emoji the user requests (default `:dario:`).

---

## Network-Specific Notes

### base_staging
- Chain ID: 8453 (same as mainnet, different deployer)
- No multisig -- deployer retains ownership
- Intent expiry: 1 hour
- Etherscan: basescan.org

### base (production)
- Chain ID: 8453
- Multisig: `0x0bC26FF515411396DD588Abd6Ef6846E04470227`
- Ownership transfers to multisig
- Intent expiry: 6 hours
- Use `yarn deploy:base`, `yarn etherscan:base`
- Package version: semver minor/patch (not RC)
- Indexer config: `config.base_prod.yaml`
- Indexer branch: `releases/production` (or `main` depending on setup)
- Extra caution: double-check registry wiring, verify multisig txns

---

## Common Issues

| Issue | Fix |
|-------|-----|
| `EOTP` on npm publish | Automation token in `~/.npmrc` should bypass this. If it fails, user needs to regenerate token at npmjs.com |
| Etherscan verification fails for old contracts | Expected -- bytecode mismatch from previous deployments |
| Deploy script runs but deploys nothing | Check skip logic -- old addresses may already be replaced |
| Indexer shows wrong ABI types | Verify npm package build includes latest ABIs, bump indexer's package.json dependency |
| `releases/staging` diverged | `git rebase main` then `git push --force-with-lease` |
| Deploy tests fail on staging | Check RPC connectivity, verify contract state matches expectations |

---

## File Reference

| File | Purpose |
|------|---------|
| `deploy/*.ts` | Hardhat deploy scripts |
| `deployments/parameters.ts` | Network-specific config values |
| `deployments/helpers.ts` | Registry wiring, ownership transfer helpers |
| `deployments/base_staging/*.json` | Staging deployment artifacts |
| `deployments/outputs/baseStagingContracts.ts` | Auto-exported addresses |
| `packages/contracts/package.json` | NPM package version |
| `test/deploy/*.ts` | Deployment validation tests |
| `../zkp2p-indexer/config.base_staging.yaml` | Indexer contract addresses |
| `../zkp2p-indexer/CLAUDE.md` | Indexer staging address reference |
