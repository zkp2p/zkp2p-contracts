#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const packageRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);
const repoRoot = path.resolve(packageRoot, "..", "..");
const requireFromRepo = createRequire(import.meta.url);
const { ethers } = requireFromRepo("ethers");
const { getActiveDisputeDeploymentName, resolveActiveDisputeAliases } =
  requireFromRepo("../../../deployments/activeDisputeStack.cjs");
const args = process.argv.slice(2);
const readinessEvidence = JSON.parse(
  fs.readFileSync(
    path.join(repoRoot, "deployments", "dispute-readiness-evidence.json"),
    "utf8"
  )
);
const packJsonIndex = args.indexOf("--pack-json");
const packDirIndex = args.indexOf("--pack-dir");
const networkConfigs = [
  {
    name: "base",
    manifestNetwork: "base",
    addressFile: "addresses/base.json",
    abiDirectory: "abis/base",
    deploymentDirectory: "deployments/base",
    outputFile: "deployments/outputs/baseContracts.ts",
  },
  {
    name: "baseStaging",
    manifestNetwork: "base_staging",
    addressFile: "addresses/baseStaging.json",
    abiDirectory: "abis/baseStaging",
    deploymentDirectory: "deployments/base_staging",
    outputFile: "deployments/outputs/baseStagingContracts.ts",
  },
];
const sourceAbiArtifacts = {
  IntentGuardian: "artifacts/contracts/IntentGuardian.sol/IntentGuardian.json",
  OrchestratorV3: "artifacts/contracts/OrchestratorV3.sol/OrchestratorV3.json",
  NullifierRegistryV2:
    "artifacts/contracts/registries/NullifierRegistryV2.sol/NullifierRegistryV2.json",
  UnifiedPaymentVerifierV3:
    "artifacts/contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol/UnifiedPaymentVerifierV3.json",
  AddressGroupRegistry:
    "artifacts/contracts/registries/AddressGroupRegistry.sol/AddressGroupRegistry.json",
  WhitelistPolicy:
    "artifacts/contracts/hooks/WhitelistPolicy.sol/WhitelistPolicy.json",
  WhitelistLifecycleHook:
    "artifacts/contracts/hooks/WhitelistLifecycleHook.sol/WhitelistLifecycleHook.json",
  DisputeNullifierRegistry:
    "artifacts/contracts/registries/NullifierRegistry.sol/NullifierRegistry.json",
  DisputeProtectionPolicy:
    "artifacts/contracts/hooks/DisputeProtectionPolicy.sol/DisputeProtectionPolicy.json",
  DisputeVerifier:
    "artifacts/contracts/unifiedVerifier/DisputeVerifier.sol/DisputeVerifier.json",
  IntentLifecycleHookV1:
    "artifacts/contracts/hooks/IntentLifecycleHookV1.sol/IntentLifecycleHookV1.json",
  StakeVault: "artifacts/contracts/StakeVault.sol/StakeVault.json",
};
const requiredDisputeContracts = [
  "DisputeNullifierRegistry",
  "DisputeProtectionPolicy",
  "DisputeVerifier",
  "IntentLifecycleHookV1",
  "StakeVault",
];
const canonicalDisputeContracts = new Set([
  "StakeVault",
  "DisputeProtectionPolicy",
  "IntentLifecycleHookV1",
]);
/** @type {Record<string, string[]>} */
const requiredNetworkContracts = {
  base: requiredDisputeContracts,
  baseStaging: requiredDisputeContracts,
};

/** @param {string} message */
function fail(message) {
  console.error(`Contracts package verification failed: ${message}`);
  process.exit(1);
}

/** @param {string} relativePath */
function requireFile(relativePath) {
  const absolutePath = path.join(packageRoot, relativePath);
  if (!fs.existsSync(absolutePath))
    fail(`missing generated file ${relativePath}`);
  return absolutePath;
}

/** @param {unknown} left @param {unknown} right */
function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** @param {string} relativePath */
function readDeploymentOutput(relativePath) {
  const source = fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
  const json = source
    .replace(/^\s*export\s+default\s+/, "")
    .replace(/\s+as\s+const\s*;?\s*$/, "");
  return JSON.parse(json);
}

const requiredPackFiles = [
  "package.json",
  "README.md",
  ...networkConfigs.flatMap(({ name, addressFile }) => [
    addressFile,
    `abis/${name}.cjs`,
    `abis/${name}.d.ts`,
    `abis/${name}.mjs`,
    `disputeReadiness/${name}.json`,
    `_cjs/disputeReadiness/${name}.js`,
    `_esm/disputeReadiness/${name}.js`,
    `_types/disputeReadiness/${name}.d.ts`,
  ]),
  "_cjs/disputeReadiness/index.js",
  "_esm/disputeReadiness/index.js",
  "_types/disputeReadiness/index.d.ts",
  "_types/disputeReadiness/types.d.ts",
];

if (packJsonIndex !== -1) {
  const packJsonPath = path.resolve(args[packJsonIndex + 1] || "");
  const packResult =
    /** @type {{ files: Array<{ path: string }>, filename: string, integrity: string, shasum: string }} */ (
      JSON.parse(fs.readFileSync(packJsonPath, "utf8"))[0]
    );
  const packedFiles = new Set(packResult.files.map((file) => file.path));
  for (const relativePath of requiredPackFiles) {
    if (!packedFiles.has(relativePath))
      fail(`npm pack omitted ${relativePath}`);
  }
  for (const relativePath of packedFiles) {
    if (
      /(^|\/)(\.env(?:\.|$)|\.npmrc$|coverage\/|audit(?:s)?\/)/i.test(
        relativePath
      )
    ) {
      fail(`npm pack included forbidden release material: ${relativePath}`);
    }
  }

  if (packDirIndex !== -1) {
    const tarballPath = path.join(
      path.resolve(args[packDirIndex + 1] || ""),
      packResult.filename
    );
    const tarball = fs.readFileSync(tarballPath);
    const integrity = `sha512-${crypto
      .createHash("sha512")
      .update(tarball)
      .digest("base64")}`;
    const shasum = crypto.createHash("sha1").update(tarball).digest("hex");
    if (integrity !== packResult.integrity)
      fail("tarball sha512 integrity differs from npm pack JSON");
    if (shasum !== packResult.shasum)
      fail("tarball sha1 differs from npm pack JSON");
  }

  console.log(`npm pack verification passed (${packedFiles.size} files).`);
  process.exit(0);
}

const packageJson = JSON.parse(
  fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")
);
if (
  packageJson.repository?.url !== "https://github.com/zkp2p/zkp2p-contracts.git"
) {
  fail(
    "package repository URL must exactly match the trusted GitHub repository"
  );
}
if (packageJson.publishConfig?.provenance !== true)
  fail("publishConfig.provenance must be true");
for (const condition of ["types", "import", "require"]) {
  if (!packageJson.exports?.["./disputeReadiness"]?.[condition]) {
    fail(`dispute readiness package export is missing ${condition}`);
  }
}

const zeroAddress = "0x0000000000000000000000000000000000000000";
let verifiedDeployments = 0;
for (const {
  name,
  manifestNetwork,
  addressFile,
  abiDirectory,
  deploymentDirectory,
  outputFile,
} of networkConfigs) {
  const addresses = JSON.parse(
    fs.readFileSync(requireFile(addressFile), "utf8")
  );
  if (addresses.chainId !== 8453)
    fail(`${name} package chainId is ${addresses.chainId}, expected 8453`);
  const rawOutput = readDeploymentOutput(outputFile);
  const readiness = JSON.parse(
    fs.readFileSync(requireFile(`disputeReadiness/${name}.json`), "utf8")
  );
  const networkEvidence = readinessEvidence.networks?.[manifestNetwork];
  if (!networkEvidence)
    fail(`${name} readiness evidence is missing`);
  if (readiness.schemaVersion !== readinessEvidence.schemaVersion)
    fail(`${name} readiness schema version mismatch`);
  if (readiness.network !== manifestNetwork || readiness.chainId !== 8453)
    fail(`${name} readiness network identity mismatch`);
  if (!sameJson(readiness.activeDisputeStack, rawOutput.activeDisputeStack))
    fail(`${name} readiness selection differs from deployment output`);
  if (!sameJson(readiness.activeDisputeStack, networkEvidence.activeDisputeStack))
    fail(`${name} readiness selection differs from trusted evidence`);
  const expectedRuntimeIdentities = Object.fromEntries(
    [
      "Orchestrator",
      "OrchestratorV2",
      "OrchestratorV3",
      "StakeVault",
      "DisputeProtectionPolicy",
      "IntentLifecycleHookV1",
      "RecognizedPredecessorHook",
      "RecognizedPredecessorPolicy",
      "OrchestratorRegistry",
      "WhitelistPolicy",
      "DisputeVerifier",
      "DisputeNullifierRegistry",
      "MultiAttestationVerifier",
    ].map((contractName) => [
      contractName,
      contractName === "RecognizedPredecessorHook" ||
      contractName === "RecognizedPredecessorPolicy"
        ? networkEvidence[
            contractName === "RecognizedPredecessorHook"
              ? "recognizedPredecessorHook"
              : "recognizedPredecessorPolicy"
          ]
        : {
            address: networkEvidence.addresses[contractName],
            runtimeCodeHash: networkEvidence.runtimeCodeHashes[contractName],
          },
    ])
  );
  if (!sameJson(readiness.runtimeIdentities, expectedRuntimeIdentities))
    fail(`${name} runtime identities differ from trusted evidence`);
  for (const [contractName, identity] of Object.entries(expectedRuntimeIdentities)) {
    const deploymentEvidence = networkEvidence.deploymentEvidence?.[contractName];
    if (!deploymentEvidence)
      fail(`${name}.${contractName} deployment evidence is missing`);
    if (
      contractName !== "RecognizedPredecessorHook" &&
      contractName !== "RecognizedPredecessorPolicy"
    ) {
      const selectedDeploymentName = canonicalDisputeContracts.has(contractName)
        ? getActiveDisputeDeploymentName(manifestNetwork, contractName)
        : contractName;
      if (deploymentEvidence.deploymentName !== selectedDeploymentName) {
        fail(`${name}.${contractName} deployment selection evidence mismatch`);
      }
    }
    const deploymentPath = path.join(
      repoRoot,
      deploymentDirectory,
      `${deploymentEvidence.deploymentName}.json`
    );
    if (!fs.existsSync(deploymentPath))
      fail(`${name}.${contractName} deployment evidence artifact is missing`);
    const deployment = JSON.parse(fs.readFileSync(deploymentPath, "utf8"));
    if (
      deployment.address.toLowerCase() !== identity.address.toLowerCase() ||
      deployment.solcInputHash !== deploymentEvidence.solcInputHash ||
      typeof deployment.deployedBytecode !== "string" ||
      ethers.utils.keccak256(deployment.deployedBytecode).toLowerCase() !==
        deploymentEvidence.deployedBytecodeHash
    ) {
      fail(`${name}.${contractName} deployment evidence mismatch`);
    }
    if (
      [
        "OrchestratorRegistry",
        "DisputeNullifierRegistry",
        "MultiAttestationVerifier",
      ].includes(contractName) &&
      deploymentEvidence.deployedBytecodeHash !== identity.runtimeCodeHash
    ) {
      fail(`${name}.${contractName} direct runtime hash differs from deployment evidence`);
    }
  }
  if (!sameJson(readiness.addressExpectations, networkEvidence.addressExpectations))
    fail(`${name} address expectations differ from trusted evidence`);
  if (
    !sameJson(
      readiness.riskWindowSecondsByPaymentMethod,
      readinessEvidence.riskWindowSecondsByPaymentMethod[manifestNetwork]
    )
  ) fail(`${name} risk windows differ from trusted evidence`);
  if (!sameJson(readiness.sentinel, readinessEvidence.sentinel))
    fail(`${name} readiness sentinel differs from trusted evidence`);
  if (!sameJson(readiness.prerequisites, readinessEvidence.prerequisites))
    fail(`${name} readiness prerequisites differ from trusted evidence`);
  const identities = readiness.runtimeIdentities;
  const expectedAddresses = readiness.addressExpectations;
  const expectedRelations = {
    activeLifecycleHook: identities.IntentLifecycleHookV1.address,
    recognizedPredecessorPolicy: identities.RecognizedPredecessorPolicy.address,
    registeredOrchestrator: identities.OrchestratorV3.address,
    authorizedLifecycleHook: identities.IntentLifecycleHookV1.address,
    disputeNullifierAuthorizedWriter: identities.DisputeProtectionPolicy.address,
    orchestratorEscrowRegistry: expectedAddresses.EscrowRegistry,
    orchestratorPaymentVerifierRegistry: expectedAddresses.PaymentVerifierRegistry,
    orchestratorRelayerRegistry: expectedAddresses.RelayerRegistry,
    hookOrchestratorRegistry: identities.OrchestratorRegistry.address,
    hookWhitelistPolicy: identities.WhitelistPolicy.address,
    hookDisputeProtectionPolicy: identities.DisputeProtectionPolicy.address,
    whitelistGroupRegistry: expectedAddresses.AddressGroupRegistry,
    whitelistEscrowRegistry: expectedAddresses.EscrowRegistry,
    whitelistOrchestratorRegistry: identities.OrchestratorRegistry.address,
    policyStakeVault: identities.StakeVault.address,
    policyDisputeVerifier: identities.DisputeVerifier.address,
    policyDisputeNullifierRegistry: identities.DisputeNullifierRegistry.address,
    disputeVerifierNullifierRegistry: expectedAddresses.NullifierRegistryV2,
    disputeVerifierAttestationVerifier: identities.MultiAttestationVerifier.address,
    vaultController: identities.DisputeProtectionPolicy.address,
    vaultStakeToken: expectedAddresses.StakeToken,
  };
  if (!sameJson(readiness.expectedRelations, expectedRelations))
    fail(`${name} readiness dependency relations differ from trusted evidence`);
  const expectedGovernance = {
    owner: networkEvidence.governance.owner,
    governedRuntimeIdentities: [
      "OrchestratorRegistry",
      "OrchestratorV3",
      "StakeVault",
      "DisputeProtectionPolicy",
      "WhitelistPolicy",
      "DisputeVerifier",
      "DisputeNullifierRegistry",
      "MultiAttestationVerifier",
    ],
    pendingOwner: networkEvidence.governance.pendingOwner,
    twoStepGovernedRuntimeIdentities: [
      "StakeVault",
      "DisputeProtectionPolicy",
      "DisputeVerifier",
    ],
  };
  if (!sameJson(readiness.expectedGovernance, expectedGovernance))
    fail(`${name} readiness governance differs from trusted evidence`);
  if (!sameJson(readiness.attestationTrust, networkEvidence.attestationTrust))
    fail(`${name} readiness attestation trust differs from trusted evidence`);
  const policyDeploymentEvidence = networkEvidence.deploymentEvidence.DisputeProtectionPolicy;
  const policyDeployment = JSON.parse(
    fs.readFileSync(
      path.join(repoRoot, deploymentDirectory, `${policyDeploymentEvidence.deploymentName}.json`),
      "utf8"
    )
  );
  const expectedAuthorizationSets = {
    orchestratorAuthorizationFromBlock: JSON.parse(
      fs.readFileSync(
        path.join(repoRoot, deploymentDirectory, "OrchestratorRegistry.json"),
        "utf8"
      )
    ).receipt.blockNumber.toString(),
    authorizedOrchestrators: [
      identities.Orchestrator.address,
      identities.OrchestratorV2.address,
      identities.OrchestratorV3.address,
    ],
    lifecycleHookAuthorizationFromBlock: policyDeployment.receipt.blockNumber.toString(),
    authorizedLifecycleHooks: [identities.IntentLifecycleHookV1.address],
    passiveDisputeNullifierWriters: [identities.RecognizedPredecessorPolicy.address],
    activeDisputeNullifierWriters: [identities.DisputeProtectionPolicy.address],
  };
  if (!sameJson(readiness.exactAuthorizationSets, expectedAuthorizationSets))
    fail(`${name} readiness authorization sets differ from trusted evidence`);
  if (JSON.stringify(readiness).includes("OptIn"))
    fail(`${name} readiness metadata exposes an internal OptIn name`);
  if (
    Object.keys(rawOutput.contracts || {}).some((contractName) =>
      contractName.endsWith("OptIn")
    )
  ) {
    fail(
      `${name} canonical deployment output exposes an internal OptIn record`
    );
  }
  const output = {
    ...rawOutput,
    contracts: resolveActiveDisputeAliases(
      manifestNetwork,
      rawOutput.contracts || {},
      rawOutput.activeDisputeStack
    ),
  };
  if (Number(output.chainId) !== addresses.chainId) {
    fail(`${name} deployment output chainId does not match the package`);
  }

  const esmWrapper = fs.readFileSync(requireFile(`abis/${name}.mjs`), "utf8");
  const cjsWrapper = fs.readFileSync(requireFile(`abis/${name}.cjs`), "utf8");
  requireFile(`abis/${name}.d.ts`);

  const contracts = Object.entries(addresses.contracts || {});
  if (contracts.length === 0) fail(`${name} package has no contract addresses`);
  if (contracts.some(([contractName]) => contractName.endsWith("OptIn"))) {
    fail(`${name} package addresses expose an internal OptIn record`);
  }
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
        fail(
          `${name}.${contractName} has a nonzero address without a canonical deployment output`
        );
      }
      continue;
    }
    if (packageAddress.toLowerCase() !== outputEntry.address.toLowerCase()) {
      fail(
        `${name}.${contractName} does not match the canonical deployment output`
      );
    }
    if (packageAddress.toLowerCase() === zeroAddress) {
      fail(
        `${name}.${contractName} is canonical for this network but has a zero package address`
      );
    }

    const deploymentName = canonicalDisputeContracts.has(contractName)
      ? getActiveDisputeDeploymentName(manifestNetwork, contractName)
      : contractName;
    const artifactPath = path.join(
      repoRoot,
      deploymentDirectory,
      `${deploymentName}.json`
    );
    if (!fs.existsSync(artifactPath))
      fail(`${name}.${contractName} has no deployment artifact`);

    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    const artifactAddress = artifact.address;
    if (packageAddress.toLowerCase() !== artifactAddress.toLowerCase()) {
      fail(`${name}.${contractName} does not match its deployment artifact`);
    }

    const packageAbi = JSON.parse(
      fs.readFileSync(
        requireFile(`${abiDirectory}/${contractName}.json`),
        "utf8"
      )
    );
    if (!sameJson(packageAbi, outputEntry.abi)) {
      fail(
        `${name}.${contractName} ABI does not match the canonical deployment output`
      );
    }
    if (!sameJson(packageAbi, artifact.abi)) {
      fail(
        `${name}.${contractName} ABI does not match its deployment artifact`
      );
    }
    if (
      !esmWrapper.includes(`as ${contractName}`) ||
      !cjsWrapper.includes(`${contractName}:`)
    ) {
      fail(`${name} ABI wrappers do not export ${contractName}`);
    }
    verifiedDeployments += 1;
  }

  for (const contractName of Object.keys(output.contracts || {})) {
    if (!(contractName in addresses.contracts)) {
      fail(
        `${name} package addresses omit canonical deployment ${contractName}`
      );
    }
  }
}

if (verifiedDeployments === 0)
  fail("no deployment-backed package entries were verified");

const sourceEsmWrapper = fs.readFileSync(
  requireFile("abis/contracts.mjs"),
  "utf8"
);
const sourceCjsWrapper = fs.readFileSync(
  requireFile("abis/contracts.cjs"),
  "utf8"
);
requireFile("abis/contracts.d.ts");
for (const [contractName, artifactPath] of Object.entries(sourceAbiArtifacts)) {
  const artifact = JSON.parse(
    fs.readFileSync(path.join(repoRoot, artifactPath), "utf8")
  );
  const packageAbi = JSON.parse(
    fs.readFileSync(requireFile(`abis/contracts/${contractName}.json`), "utf8")
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
  "utils/riskMath.js",
  "types/contracts/RiskManager.js",
  "abis/contracts/RiskManager.json",
]) {
  if (fs.existsSync(path.join(packageRoot, removedExport))) {
    fail(`stale noncanonical affine-risk export remains: ${removedExport}`);
  }
}

console.log(
  `Verified ${verifiedDeployments} deployment-backed ABI/address entries and ${
    Object.keys(sourceAbiArtifacts).length
  } canonical source ABI exports.`
);
