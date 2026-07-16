---
name: zkp2p-contracts-publish
description: >
  Publish the @zkp2p/contracts-v2 package to npm. Use this skill when you need to
  bump the contracts package version (rc or stable), extract deployment artifacts,
  build, test, and publish with the correct dist-tag. Covers both prerelease (dev tag)
  and stable (latest tag) workflows.
---

# @zkp2p/contracts-v2 — Publish Workflows

## Package Location

`packages/contracts/` within the `zkp2p-contracts` repo.

Publishes: ABIs, addresses, constants, currencies, oracle feeds, payment methods, network bundles, TypeChain types, and utils — all as built CJS + ESM artifacts.

## Version Scheme

- **RC versions**: `0.2.0-rc.N` — used during active development
- **Stable versions**: `0.2.0` — promoted after QA

Current version lives in `packages/contracts/package.json`. No CHANGELOG file exists yet — consider adding one.

## Bump Version

### Bump RC (prerelease)

```bash
cd packages/contracts
# e.g. 0.2.0-rc.0 -> 0.2.0-rc.1
npm version prerelease --preid rc --no-git-tag-version
```

### Bump Stable (minor/patch)

```bash
cd packages/contracts
npm version patch --no-git-tag-version   # 0.2.0 -> 0.2.1
npm version minor --no-git-tag-version   # 0.2.0 -> 0.3.0
```

### Manual Version Set

```bash
cd packages/contracts
npm version 0.3.0-rc.0 --no-git-tag-version
```

## Build Pipeline

The build is multi-stage — extraction, wrapper generation, network bundling, then Rollup:

```bash
# From repo root — full pipeline
yarn pkg:extract    # Extract deployment artifacts + build package
yarn pkg:build      # Build only (skip extraction)
yarn pkg:test       # Run package tests
```

Or from `packages/contracts/`:

```bash
yarn build          # clean → extract → generate:wrappers → generate:networks → bundle
yarn test           # jest (90% coverage threshold)
yarn test:coverage  # jest --coverage
```

### Build Stages

1. **Extract** (`scripts/extract-all.ts`) — reads deployment outputs from `../deployments/outputs/` and data from `scripts/data/`, generates JSON + TS module entries under `addresses/`, `abis/`, `constants/`, `currencies/`, `oracleFeeds/`, `paymentMethods/`
2. **Generate Wrappers** (`scripts/generate-abi-wrappers.ts`) — creates ABI import/export files
3. **Generate Networks** (`scripts/generate-network-entries.ts`) — creates per-network convenience bundles (`networks/base`, `networks/baseStaging`)
4. **Bundle** (`scripts/build-modules.ts`) — Rollup to `_esm/` and `_cjs/`, plus `_types/` declarations

## Pre-Publish Checks

Run all checks before publishing:

```bash
# From repo root
yarn pkg:build
yarn pkg:test
```

Or from `packages/contracts/`:

```bash
yarn build
yarn test
```

Note: `prepublishOnly` hook in `package.json` runs `yarn build && yarn test` automatically on publish.

Sanity-check the tarball:

```bash
cd packages/contracts && npm pack --dry-run
```

## Publish

### Prerelease (dev tag)

Use the `dev` dist-tag so consumers opt in explicitly:

```bash
cd packages/contracts
npm publish --access public --tag dev --no-provenance
```

With 2FA:

```bash
npm publish --access public --tag dev --no-provenance --otp <CODE>
```

### Stable (latest tag)

```bash
cd packages/contracts
npm publish --access public --no-provenance --otp <CODE>
```

### Promote an Existing Version to Latest

```bash
npm dist-tag add @zkp2p/contracts-v2@<version> latest --otp <CODE>
```

## Verify

### npm Registry

```bash
npm view @zkp2p/contracts-v2 dist-tags
npm view @zkp2p/contracts-v2 versions --json | tail -5
```

### Address Verification Against Deployment Artifacts

After building (before or after publishing), verify that the extracted package addresses match the deployment artifact source of truth in `deployments/base/` and `deployments/base_staging/`.

```bash
# From repo root — diff package addresses against deployment artifacts
node -e "
const fs = require('fs');
const path = require('path');

const networks = [
  { name: 'base', pkgFile: 'packages/contracts/addresses/base.json', deployDir: 'deployments/base' },
  { name: 'base_staging', pkgFile: 'packages/contracts/addresses/baseStaging.json', deployDir: 'deployments/base_staging' },
];

let mismatches = 0;
for (const net of networks) {
  const pkg = JSON.parse(fs.readFileSync(net.pkgFile, 'utf8'));
  console.log('=== ' + net.name.toUpperCase() + ' ===');
  for (const [contract, pkgAddr] of Object.entries(pkg.contracts)) {
    const artifactPath = path.join(net.deployDir, contract + '.json');
    if (!fs.existsSync(artifactPath)) {
      console.log('  SKIP ' + contract + ' (no deployment artifact)');
      continue;
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    if (pkgAddr.toLowerCase() !== artifact.address.toLowerCase()) {
      console.log('  MISMATCH ' + contract + ': pkg=' + pkgAddr + ' artifact=' + artifact.address);
      mismatches++;
    } else {
      console.log('  OK   ' + contract + ': ' + pkgAddr);
    }
  }
}
if (mismatches > 0) {
  console.log('\n❌ ' + mismatches + ' address mismatch(es) — do NOT publish. Re-run yarn pkg:extract.');
  process.exit(1);
} else {
  console.log('\n✅ All addresses match deployment artifacts.');
}
"
```

If any mismatch is found, re-run `yarn pkg:extract` to regenerate from the latest deployment outputs.

## Commit the Bump

```bash
# Stage and commit from repo root
git add packages/contracts/package.json
git commit -m "chore(contracts): bump version to $(node -p "require('./packages/contracts/package.json').version")"
```

## Full RC Release (copy-paste)

```bash
cd packages/contracts
npm version prerelease --preid rc --no-git-tag-version
cd ../..
yarn pkg:build && yarn pkg:test

# Verify package addresses match deployment artifacts (exits 1 on mismatch)
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

cd packages/contracts && npm publish --access public --tag dev --no-provenance
cd ../..
git add packages/contracts/package.json
git commit -m "chore(contracts): bump version to $(node -p "require('./packages/contracts/package.json').version")"
```

## Full Stable Release (copy-paste)

```bash
cd packages/contracts
npm version patch --no-git-tag-version
cd ../..
yarn pkg:build && yarn pkg:test

# Verify package addresses match deployment artifacts (exits 1 on mismatch)
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

cd packages/contracts && npm publish --access public --no-provenance --otp <CODE>
cd ../..
git add packages/contracts/package.json
git commit -m "chore(contracts): release $(node -p "require('./packages/contracts/package.json').version")"
```

## Notes

- `--no-provenance` is required when publishing from a private repo or local machine
- `--no-git-tag-version` prevents npm from auto-creating a git tag
- The `prepublishOnly` hook runs `yarn build && yarn test` automatically — if you've already built, the publish step will rebuild
- Extraction depends on deployment outputs existing in `../deployments/outputs/` — make sure contracts are deployed before extracting
- Networks supported: `base` (production, chainId 8453), `baseStaging` (staging, chainId 8453)
