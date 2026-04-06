---
name: ship-contracts
description: >-
  Full deployment pipeline for ZKP2P V2 contracts scoped to this repo. Phases:
  write deploy script + tests, run on localhost, deploy to staging (test, verify,
  commit, publish RC), deploy to prod (test, verify, commit, publish stable).
  Use when the user says "ship contracts", "deploy contracts", "deploy staging",
  "deploy prod", "redeploy escrow", "full deploy pipeline", or "ship it" in the
  contracts repo context.
---

# Ship Contracts

End-to-end deployment pipeline for ZKP2P V2 contracts. Follows a staged gate model: each phase must pass before moving to the next.

```
Phase 0: Script    Write deploy script + deploy tests
Phase 1: Local     Deploy to localhost, run full test suite + deploy tests
Phase 2: Staging   Deploy, test, verify etherscan, commit artifacts, publish RC package
Phase 3: Prod      Deploy, test, verify etherscan, commit artifacts, publish stable package
```

The user may enter at any phase (e.g., skip to Phase 2 if the script already exists and local testing is done). Ask which phase to start from if unclear.

---

## Phase 0: Write Deploy Script + Tests

**Goal:** Create the deploy script and its corresponding deploy test.

### 0a. Determine the next script number

```bash
ls deploy/*.ts | sort | tail -5
```

Pick the next available `NN_` prefix (e.g., if last is `23_`, use `24_`).

### 0b. Write the deploy script

Create `deploy/NN_description.ts` following the pattern in existing redeploy scripts (e.g., `deploy/19_redeploy_escrowv2_orchestratorv2_staging.ts`).

Key elements:
- Import parameters from `deployments/parameters.ts`
- Import helpers from `deployments/helpers.ts`
- Define `OLD_*` address maps for contracts being replaced (keyed by network name)
- Deploy new contracts, wire registries (add new, remove old), transfer ownership
- Skip logic: skip if old addresses no longer match current deployments
- Dependencies: `["16_configure_v2_payment_methods"]`
- Use `waitForDeploymentDelay(hre)` between transactions

### 0c. Write the deploy test

Create `test/deploy/NN_description.spec.ts` following the pattern in `test/deploy/14_v2System.spec.ts`.

Key elements:
- Attach to deployed contracts using `getDeployedContractAddress(network, name)`
- Validate ownership, parameters, registry wiring, permissions
- Test against `deployments/parameters.ts` expected values

### 0d. Update deploy/CLAUDE.md

Add the new script to the script inventory table.

**Gate:** Deploy script and test file exist and compile (`yarn compile`).

---

## Phase 1: Local Chain

**Goal:** Validate the deploy script runs correctly on a fresh local chain.

### 1a. Deploy to localhost

```bash
yarn deploy:localhost
```

Verify output shows:
- New contract addresses deployed
- Registry wiring completed
- Ownership transferred (to deployer on localhost)

### 1b. Run full test suite

```bash
yarn test
```

All tests must pass. This catches any contract changes that break existing functionality.

### 1c. Run deploy tests against localhost

```bash
npx hardhat test test/deploy/*.ts --network localhost
```

All deploy tests must pass, including the new one from Phase 0.

### 1d. Run foundry tests

```bash
yarn test:forge
```

**Gate:** All tests green on localhost.

---

## Phase 2: Staging

**Goal:** Deploy to Base staging, validate, verify, commit, publish RC.

### 2a. Deploy to staging

```bash
yarn deploy:base_staging
```

Extract and save new contract addresses from deploy output.

### 2b. Export deployment outputs

```bash
npx hardhat export --export-all deployments/outputs/baseStagingContracts.ts --network base_staging
```

### 2c. Run deploy tests against staging

```bash
npx hardhat test test/deploy/*.ts --network base_staging
```

All tests must pass. If any fail, investigate before proceeding.

### 2d. Verify on Etherscan

```bash
yarn etherscan:base_staging
```

Only newly deployed contracts need to verify successfully. Old contracts may fail (bytecode mismatch from earlier deployments) -- that's expected.

### 2e. Commit staging artifacts

1. Stage deployment artifacts:
   ```bash
   git add deployments/base_staging/*.json deployments/outputs/ deploy/ test/deploy/
   ```
   Exclude: `deployments/base_staging/solcInputs/` (large, not needed)

2. Commit with conventional format:
   ```
   feat(base-staging): redeploy <ContractNames> with <reason>
   ```

### 2f. Build and verify package (staging)

```bash
yarn pkg:build
```

Verify staging addresses in the built package match what was deployed:

```bash
cat packages/contracts/addresses/baseStaging.json | grep -i <contract_name>
```

The addresses must match Step 2a output.

### 2g. Bump and publish RC

1. Bump RC version:
   ```bash
   cd packages/contracts && npm version prerelease --preid rc --no-git-tag-version && cd ../..
   ```

2. Run package tests:
   ```bash
   yarn pkg:test
   ```

3. Verify addresses match deployment artifacts:
   ```bash
   node -e "
   const fs=require('fs'),p=require('path');
   let m=0;
   for(const[n,pf,dd]of[['base','packages/contracts/addresses/base.json','deployments/base'],['staging','packages/contracts/addresses/baseStaging.json','deployments/base_staging']]){
     const pkg=JSON.parse(fs.readFileSync(pf));
     for(const[c,a]of Object.entries(pkg.contracts)){
       const ap=p.join(dd,c+'.json');
       if(!fs.existsSync(ap))continue;
       const d=JSON.parse(fs.readFileSync(ap));
       if(a.toLowerCase()!==d.address.toLowerCase()){console.log('MISMATCH',n,c,a,d.address);m++;}
     }
   }
   if(m){console.log(m+' mismatch(es)');process.exit(1);}
   console.log('All addresses OK');
   "
   ```

4. Publish:
   ```bash
   cd packages/contracts && npm publish --access public --tag dev --no-provenance && cd ../..
   ```

5. Commit version bump:
   ```bash
   git add packages/contracts/package.json
   git commit -m "chore(contracts): bump @zkp2p/contracts-v2 to $(node -p "require('./packages/contracts/package.json').version")"
   ```

6. Verify publication:
   ```bash
   npm view @zkp2p/contracts-v2 dist-tags
   ```

**Gate:** RC published, all staging artifacts committed, addresses verified.

---

## Phase 3: Production

**Goal:** Deploy to Base mainnet, validate, verify, commit, publish stable.

### 3a. Deploy to production

```bash
yarn deploy:base
```

Extra caution:
- Ownership transfers to multisig (`0x0bC26FF515411396DD588Abd6Ef6846E04470227`)
- Double-check registry wiring in output
- Extract and save new contract addresses

### 3b. Export deployment outputs

```bash
npx hardhat export --export-all deployments/outputs/baseContracts.ts --network base
```

### 3c. Run deploy tests against production

```bash
npx hardhat test test/deploy/*.ts --network base
```

### 3d. Verify on Etherscan

```bash
yarn etherscan:base
```

### 3e. Commit production artifacts

1. Stage:
   ```bash
   git add deployments/base/*.json deployments/outputs/
   ```
   Exclude: `deployments/base/solcInputs/`

2. Commit:
   ```
   feat(base): redeploy <ContractNames> with <reason>
   ```

### 3f. Build and verify package (prod + staging)

```bash
yarn pkg:build
```

Verify BOTH staging and prod addresses are correct in the built package:

```bash
cat packages/contracts/addresses/base.json | grep -i <contract_name>
cat packages/contracts/addresses/baseStaging.json | grep -i <contract_name>
```

Both must match their respective deployed addresses.

### 3g. Bump and publish stable

1. Bump stable version:
   ```bash
   cd packages/contracts && npm version patch --no-git-tag-version && cd ../..
   ```
   Use `minor` for significant changes.

2. Run package tests:
   ```bash
   yarn pkg:test
   ```

3. Verify addresses (same script as 2g).

4. Publish stable:
   ```bash
   cd packages/contracts && npm publish --access public --no-provenance --otp <CODE> && cd ../..
   ```
   Ask user for OTP. Automation token in `~/.npmrc` may bypass this for RC but stable may require it.

5. Commit version bump:
   ```bash
   git add packages/contracts/package.json
   git commit -m "chore(contracts): release @zkp2p/contracts-v2@$(node -p "require('./packages/contracts/package.json').version")"
   ```

6. Verify:
   ```bash
   npm view @zkp2p/contracts-v2 dist-tags
   ```

**Gate:** Stable published, all prod artifacts committed, addresses verified for both networks.

---

## Phase Summary

After completing all phases, push and open a PR:

```bash
git push -u origin <branch>
```

PR description should include:
- New contract addresses (staging + prod)
- What changed and why
- Deploy script link
- NPM package versions published

---

## Network Reference

| Network | Deploy Command | Etherscan Command | Ownership | Intent Expiry |
|---------|---------------|-------------------|-----------|---------------|
| localhost | `yarn deploy:localhost` | N/A | deployer | 24 hours |
| base_staging | `yarn deploy:base_staging` | `yarn etherscan:base_staging` | deployer | 1 hour |
| base | `yarn deploy:base` | `yarn etherscan:base` | multisig | 6 hours |

## Common Issues

| Issue | Fix |
|-------|-----|
| Deploy script runs but deploys nothing | Check skip logic -- old addresses may already be replaced |
| Deploy tests fail on staging/prod | Check RPC connectivity, verify contract state matches expectations |
| Etherscan verification fails for old contracts | Expected -- bytecode mismatch from previous deployments |
| Package address mismatch | Re-run `yarn pkg:extract` then `yarn pkg:build` |
| `EOTP` on npm publish | Automation token in `~/.npmrc` should bypass for RC. Stable may need OTP |
| Localhost tests pass but staging fails | Check `deployments/parameters.ts` has correct values for the target network |

## File Reference

| File | Purpose |
|------|---------|
| `deploy/*.ts` | Hardhat deploy scripts |
| `test/deploy/*.ts` | Deployment validation tests |
| `deployments/parameters.ts` | Network-specific config values |
| `deployments/helpers.ts` | Registry wiring, ownership transfer helpers |
| `deployments/base_staging/*.json` | Staging deployment artifacts |
| `deployments/base/*.json` | Production deployment artifacts |
| `deployments/outputs/` | Auto-exported address files |
| `packages/contracts/package.json` | NPM package version |
| `packages/contracts/addresses/` | Built package address JSONs |
