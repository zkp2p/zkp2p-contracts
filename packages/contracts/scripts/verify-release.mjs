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
  },
  {
    name: 'baseStaging',
    addressFile: 'addresses/baseStaging.json',
    abiDirectory: 'abis/baseStaging',
    deploymentDirectory: 'deployments/base_staging',
  },
];

function fail(message) {
  console.error(`Contracts package verification failed: ${message}`);
  process.exit(1);
}

function requireFile(relativePath) {
  const absolutePath = path.join(packageRoot, relativePath);
  if (!fs.existsSync(absolutePath)) fail(`missing generated file ${relativePath}`);
  return absolutePath;
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
for (const { name, addressFile, abiDirectory, deploymentDirectory } of networkConfigs) {
  const addresses = JSON.parse(fs.readFileSync(requireFile(addressFile), 'utf8'));
  if (addresses.chainId !== 8453) fail(`${name} package chainId is ${addresses.chainId}, expected 8453`);

  const esmWrapper = fs.readFileSync(requireFile(`abis/${name}.mjs`), 'utf8');
  const cjsWrapper = fs.readFileSync(requireFile(`abis/${name}.cjs`), 'utf8');
  requireFile(`abis/${name}.d.ts`);

  const contracts = Object.entries(addresses.contracts || {});
  if (contracts.length === 0) fail(`${name} package has no contract addresses`);

  for (const [contractName, packageAddress] of contracts) {
    const artifactPath = path.join(repoRoot, deploymentDirectory, `${contractName}.json`);
    if (!fs.existsSync(artifactPath)) {
      if (packageAddress.toLowerCase() !== zeroAddress) {
        fail(`${name}.${contractName} has a nonzero package address without a deployment artifact`);
      }
      continue;
    }

    const artifactAddress = JSON.parse(fs.readFileSync(artifactPath, 'utf8')).address;
    if (packageAddress.toLowerCase() !== artifactAddress.toLowerCase()) {
      fail(`${name}.${contractName} does not match its deployment artifact`);
    }

    requireFile(`${abiDirectory}/${contractName}.json`);
    if (!esmWrapper.includes(`as ${contractName}`) || !cjsWrapper.includes(`${contractName}:`)) {
      fail(`${name} ABI wrappers do not export ${contractName}`);
    }
    verifiedDeployments += 1;
  }
}

if (verifiedDeployments === 0) fail('no deployment-backed package entries were verified');
console.log(`Verified ${verifiedDeployments} deployment-backed ABI/address entries across Base networks.`);
