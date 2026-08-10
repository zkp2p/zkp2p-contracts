#!/usr/bin/env node

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(packageRoot, '..', '..');
const args = process.argv.slice(2);
const packJsonIndex = args.indexOf('--pack-json');
const packDirIndex = args.indexOf('--pack-dir');
const networkConfigs = [
  {
    name: 'base',
    addressFile: 'addresses/base.json',
    abiDirectory: 'abis/base',
    deploymentDirectory: 'deployments/base',
    outputFile: 'deployments/outputs/baseContracts.ts',
  },
  {
    name: 'baseStaging',
    addressFile: 'addresses/baseStaging.json',
    abiDirectory: 'abis/baseStaging',
    deploymentDirectory: 'deployments/base_staging',
    outputFile: 'deployments/outputs/baseStagingContracts.ts',
  },
];
const sourceAbiArtifacts = {
  IntentGuardian: 'artifacts/contracts/IntentGuardian.sol/IntentGuardian.json',
  OrchestratorV3: 'artifacts/contracts/OrchestratorV3.sol/OrchestratorV3.json',
  NullifierRegistryV2:
    'artifacts/contracts/registries/NullifierRegistryV2.sol/NullifierRegistryV2.json',
  UnifiedPaymentVerifierV3:
    'artifacts/contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol/UnifiedPaymentVerifierV3.json',
  AddressGroupRegistry:
    'artifacts/contracts/registries/AddressGroupRegistry.sol/AddressGroupRegistry.json',
  WhitelistPolicy: 'artifacts/contracts/hooks/WhitelistPolicy.sol/WhitelistPolicy.json',
  WhitelistLifecycleHook:
    'artifacts/contracts/hooks/WhitelistLifecycleHook.sol/WhitelistLifecycleHook.json',
  DisputeNullifierRegistry:
    'artifacts/contracts/registries/NullifierRegistry.sol/NullifierRegistry.json',
  DisputeProtectionPolicy: 'artifacts/contracts/hooks/DisputeProtectionPolicy.sol/DisputeProtectionPolicy.json',
  DisputeVerifier:
    'artifacts/contracts/unifiedVerifier/DisputeVerifier.sol/DisputeVerifier.json',
  IntentLifecycleHookV1:
    'artifacts/contracts/hooks/IntentLifecycleHookV1.sol/IntentLifecycleHookV1.json',
  StakeVault: 'artifacts/contracts/StakeVault.sol/StakeVault.json',
};
const requiredNetworkContracts = {
  baseStaging: [
    'DisputeNullifierRegistry',
    'DisputeProtectionPolicy',
    'DisputeVerifier',
    'IntentLifecycleHookV1',
    'StakeVault',
  ],
};

function fail(message) {
  console.error(`Contracts package verification failed: ${message}`);
  process.exit(1);
}

function requireFile(relativePath) {
  const absolutePath = path.join(packageRoot, relativePath);
  if (!fs.existsSync(absolutePath)) fail(`missing generated file ${relativePath}`);
  return absolutePath;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function readDeploymentOutput(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), 'utf8');
  const json = source
    .replace(/^\s*export\s+default\s+/, '')
    .replace(/\s+as\s+const\s*;?\s*$/, '');
  return JSON.parse(json);
}

const requiredPackFiles = [
  'package.json',
  'README.md',
  ...networkConfigs.flatMap(({ name, addressFile }) => [
    addressFile,
    `abis/${name}.cjs`,
    `abis/${name}.d.ts`,
    `abis/${name}.mjs`,
  ]),
];

if (packJsonIndex !== -1) {
  const packJsonPath = path.resolve(args[packJsonIndex + 1] || '');
  const packResult = JSON.parse(fs.readFileSync(packJsonPath, 'utf8'))[0];
  const packedFiles = new Set(packResult.files.map((file) => file.path));
  for (const relativePath of requiredPackFiles) {
    if (!packedFiles.has(relativePath)) fail(`npm pack omitted ${relativePath}`);
  }
  for (const relativePath of packedFiles) {
    if (/(^|\/)(\.env(?:\.|$)|\.npmrc$|coverage\/|audit(?:s)?\/)/i.test(relativePath)) {
      fail(`npm pack included forbidden release material: ${relativePath}`);
    }
  }

  if (packDirIndex !== -1) {
    const tarballPath = path.join(path.resolve(args[packDirIndex + 1] || ''), packResult.filename);
    const tarball = fs.readFileSync(tarballPath);
    const integrity = `sha512-${crypto.createHash('sha512').update(tarball).digest('base64')}`;
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex');
    if (integrity !== packResult.integrity) fail('tarball sha512 integrity differs from npm pack JSON');
    if (shasum !== packResult.shasum) fail('tarball sha1 differs from npm pack JSON');
  }

  console.log(`npm pack verification passed (${packedFiles.size} files).`);
  process.exit(0);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (packageJson.repository?.url !== 'https://github.com/zkp2p/zkp2p-contracts.git') {
  fail('package repository URL must exactly match the trusted GitHub repository');
}
if (packageJson.publishConfig?.provenance !== true) fail('publishConfig.provenance must be true');

const zeroAddress = '0x0000000000000000000000000000000000000000';
let verifiedDeployments = 0;
for (const {
  name,
  addressFile,
  abiDirectory,
  deploymentDirectory,
  outputFile,
} of networkConfigs) {
  const addresses = JSON.parse(fs.readFileSync(requireFile(addressFile), 'utf8'));
  if (addresses.chainId !== 8453) fail(`${name} package chainId is ${addresses.chainId}, expected 8453`);
  const output = readDeploymentOutput(outputFile);
  if (Number(output.chainId) !== addresses.chainId) {
    fail(`${name} deployment output chainId does not match the package`);
  }

  const esmWrapper = fs.readFileSync(requireFile(`abis/${name}.mjs`), 'utf8');
  const cjsWrapper = fs.readFileSync(requireFile(`abis/${name}.cjs`), 'utf8');
  requireFile(`abis/${name}.d.ts`);

  const contracts = Object.entries(addresses.contracts || {});
  if (contracts.length === 0) fail(`${name} package has no contract addresses`);
  for (const contractName of requiredNetworkContracts[name] || []) {
    const address = addresses.contracts?.[contractName];
    if (!address || address.toLowerCase() === zeroAddress) {
      fail(`${name}.${contractName} must expose the fresh deployment address`);
    }
  }

  for (const [contractName, packageAddress] of contracts) {
    const outputEntry = output.contracts?.[contractName];
    if (!outputEntry) {
      if (packageAddress.toLowerCase() !== zeroAddress) {
        fail(`${name}.${contractName} has a nonzero address without a canonical deployment output`);
      }
      continue;
    }
    if (packageAddress.toLowerCase() !== outputEntry.address.toLowerCase()) {
      fail(`${name}.${contractName} does not match the canonical deployment output`);
    }
    if (packageAddress.toLowerCase() === zeroAddress) {
      fail(`${name}.${contractName} is canonical for this network but has a zero package address`);
    }

    const artifactPath = path.join(repoRoot, deploymentDirectory, `${contractName}.json`);
    if (!fs.existsSync(artifactPath)) fail(`${name}.${contractName} has no deployment artifact`);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
    const artifactAddress = artifact.address;
    if (packageAddress.toLowerCase() !== artifactAddress.toLowerCase()) {
      fail(`${name}.${contractName} does not match its deployment artifact`);
    }

    const packageAbi = JSON.parse(
      fs.readFileSync(requireFile(`${abiDirectory}/${contractName}.json`), 'utf8'),
    );
    if (!sameJson(packageAbi, outputEntry.abi)) {
      fail(`${name}.${contractName} ABI does not match the canonical deployment output`);
    }
    if (!sameJson(packageAbi, artifact.abi)) {
      fail(`${name}.${contractName} ABI does not match its deployment artifact`);
    }
    if (!esmWrapper.includes(`as ${contractName}`) || !cjsWrapper.includes(`${contractName}:`)) {
      fail(`${name} ABI wrappers do not export ${contractName}`);
    }
    verifiedDeployments += 1;
  }

  for (const contractName of Object.keys(output.contracts || {})) {
    if (!(contractName in addresses.contracts)) {
      fail(`${name} package addresses omit canonical deployment ${contractName}`);
    }
  }
}

if (verifiedDeployments === 0) fail('no deployment-backed package entries were verified');

const sourceEsmWrapper = fs.readFileSync(requireFile('abis/contracts.mjs'), 'utf8');
const sourceCjsWrapper = fs.readFileSync(requireFile('abis/contracts.cjs'), 'utf8');
requireFile('abis/contracts.d.ts');
for (const [contractName, artifactPath] of Object.entries(sourceAbiArtifacts)) {
  const artifact = JSON.parse(fs.readFileSync(path.join(repoRoot, artifactPath), 'utf8'));
  const packageAbi = JSON.parse(
    fs.readFileSync(requireFile(`abis/contracts/${contractName}.json`), 'utf8'),
  );
  if (!sameJson(packageAbi, artifact.abi)) {
    fail(`source ABI ${contractName} does not match its compiled artifact`);
  }
  if (
    !sourceEsmWrapper.includes(`as ${contractName}`) ||
    !sourceCjsWrapper.includes(`${contractName}:`)
  ) {
    fail(`source ABI wrappers do not export ${contractName}`);
  }
}

for (const removedExport of [
  'utils/riskMath.js',
  'types/contracts/RiskManager.js',
  'abis/contracts/RiskManager.json',
]) {
  if (fs.existsSync(path.join(packageRoot, removedExport))) {
    fail(`stale noncanonical affine-risk export remains: ${removedExport}`);
  }
}

console.log(
  `Verified ${verifiedDeployments} deployment-backed ABI/address entries and ${Object.keys(sourceAbiArtifacts).length} canonical source ABI exports.`,
);
