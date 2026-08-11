#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';

const expectedVersion = process.argv[2];
const requireFromInstall = createRequire(path.join(process.cwd(), 'package.json'));

function fail(message) {
  console.error(`Installed contracts package smoke test failed: ${message}`);
  process.exit(1);
}

const packageJsonPath = path.join(
  process.cwd(),
  'node_modules',
  '@zkp2p',
  'contracts-v2',
  'package.json',
);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
if (packageJson.version !== expectedVersion) {
  fail(`installed ${packageJson.version}, expected ${expectedVersion}`);
}

requireFromInstall('@zkp2p/contracts-v2');
for (const subpath of [
  '@zkp2p/contracts-v2/addresses/base.json',
  '@zkp2p/contracts-v2/addresses/baseStaging.json',
  '@zkp2p/contracts-v2/currencies/currencies.json',
  '@zkp2p/contracts-v2/paymentMethods/lookups.json',
]) {
  if (!requireFromInstall(subpath)) fail(`consumer import ${subpath} is missing`);
}
const sourceAbis = requireFromInstall('@zkp2p/contracts-v2/abis/contracts');
for (const contractName of [
  'OrchestratorV3',
  'WhitelistLifecycleHook',
  'DisputeNullifierRegistry',
  'DisputeProtectionPolicy',
  'DisputeVerifier',
  'IntentLifecycleHookV1',
  'StakeVault',
]) {
  if (!Array.isArray(sourceAbis[contractName]) || sourceAbis[contractName].length === 0) {
    fail(`${contractName} source ABI export is missing`);
  }
}

for (const network of ['base', 'baseStaging']) {
  const bundle = requireFromInstall(`@zkp2p/contracts-v2/networks/${network}`);
  const addresses = bundle.addresses?.default || bundle.addresses;
  for (const contractName of ['IntentGuardian', 'WhitelistPolicy']) {
    const address = addresses?.contracts?.[contractName];
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      fail(`${network}.${contractName} does not expose a nonzero address`);
    }
    if (!Array.isArray(bundle[contractName]) || bundle[contractName].length === 0) {
      fail(`${network}.${contractName} ABI export is missing`);
    }
  }
  for (const contractName of [
    'DisputeNullifierRegistry',
    'DisputeProtectionPolicy',
    'DisputeVerifier',
    'IntentLifecycleHookV1',
    'StakeVault',
  ]) {
    const address = addresses?.contracts?.[contractName];
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      fail(`${network}.${contractName} does not expose the fresh nonzero address`);
    }
    if (!Array.isArray(bundle[contractName]) || bundle[contractName].length === 0) {
      fail(`${network}.${contractName} ABI export is missing`);
    }
  }
}

console.log(`Installed @zkp2p/contracts-v2@${expectedVersion} import smoke test passed.`);
