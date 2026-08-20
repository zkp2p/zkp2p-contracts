#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const expectedVersion = process.argv[2];
const requireFromInstall = createRequire(
  path.join(process.cwd(), "package.json")
);
const requireFromRepo = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  ".."
);
const { getActiveDisputeDeploymentName } = requireFromRepo(
  "../../../deployments/activeDisputeStack.cjs"
);

/** @param {string} message */
function fail(message) {
  console.error(`Installed contracts package smoke test failed: ${message}`);
  process.exit(1);
}

const packageJsonPath = path.join(
  process.cwd(),
  "node_modules",
  "@zkp2p",
  "contracts-v2",
  "package.json"
);
const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== expectedVersion) {
  fail(`installed ${packageJson.version}, expected ${expectedVersion}`);
}

requireFromInstall("@zkp2p/contracts-v2");
const installedPackageRoot = path.dirname(packageJsonPath);
const readinessCjs = requireFromInstall("@zkp2p/contracts-v2/disputeReadiness");
const readinessEsm = await import(
  pathToFileURL(
    path.join(installedPackageRoot, "_esm", "disputeReadiness", "index.js")
  ).href
);
for (const subpath of [
  "@zkp2p/contracts-v2/addresses/base.json",
  "@zkp2p/contracts-v2/addresses/baseStaging.json",
  "@zkp2p/contracts-v2/currencies/currencies.json",
  "@zkp2p/contracts-v2/paymentMethods/lookups.json",
  "@zkp2p/contracts-v2/disputeReadiness/base.json",
  "@zkp2p/contracts-v2/disputeReadiness/baseStaging.json",
]) {
  if (!requireFromInstall(subpath))
    fail(`consumer import ${subpath} is missing`);
}

for (const [network, expectedRiskWindowCount] of [
  ["base", 10],
  ["baseStaging", 12],
]) {
  const manifest = requireFromInstall(
    `@zkp2p/contracts-v2/disputeReadiness/${network}.json`
  );
  const extensionlessCjsManifest = requireFromInstall(
    `@zkp2p/contracts-v2/disputeReadiness/${network}`
  );
  if (
    Object.prototype.hasOwnProperty.call(extensionlessCjsManifest, "default") ||
    JSON.stringify(extensionlessCjsManifest) !== JSON.stringify(manifest)
  ) {
    fail(
      `${network} extensionless CommonJS readiness export differs from packaged JSON`
    );
  }
  if (JSON.stringify(manifest).includes("OptIn"))
    fail(`${network} readiness metadata exposes an internal OptIn name`);
  if (
    JSON.stringify(readinessCjs[network]) !== JSON.stringify(manifest) ||
    JSON.stringify(readinessEsm[network]) !== JSON.stringify(manifest)
  ) {
    fail(`${network} readiness CJS/ESM exports differ from packaged JSON`);
  }
  if (
    Object.keys(manifest.riskWindowSecondsByPaymentMethod || {}).length !==
    expectedRiskWindowCount
  ) {
    fail(`${network} readiness metadata does not cover all active methods`);
  }
  if (
    manifest.addressExpectations?.StakeToken !==
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
  ) {
    fail(`${network} readiness metadata does not pin Base USDC`);
  }
  if (
    !manifest.runtimeIdentities?.MultiAttestationVerifier?.runtimeCodeHash ||
    manifest.attestationTrust?.requiredSignatures !== "1" ||
    manifest.attestationTrust?.witnesses?.length !== 2
  ) {
    fail(`${network} readiness metadata does not pin attestation trust`);
  }
  if (
    !manifest.expectedGovernance?.owner ||
    manifest.expectedGovernance?.pendingOwner !==
      "0x0000000000000000000000000000000000000000"
  ) {
    fail(`${network} readiness metadata does not pin governance ownership`);
  }
  if (
    manifest.prerequisites?.vaultPendingController !==
      "0x0000000000000000000000000000000000000000" ||
    manifest.prerequisites?.vaultPendingControllerValidAt !== "0"
  ) {
    fail(`${network} readiness metadata does not pin the inactive vault controller handover`);
  }
  if (
    manifest.exactAuthorizationSets?.authorizedLifecycleHooks?.length !== 1 ||
    manifest.exactAuthorizationSets?.passiveDisputeNullifierWriters?.length !==
      1 ||
    manifest.exactAuthorizationSets?.activeDisputeNullifierWriters?.length !== 1
  ) {
    fail(`${network} readiness metadata does not pin exact authorization sets`);
  }
}
const sourceAbis = requireFromInstall("@zkp2p/contracts-v2/abis/contracts");
for (const contractName of [
  "OrchestratorV3",
  "WhitelistLifecycleHook",
  "DisputeNullifierRegistry",
  "DisputeProtectionPolicy",
  "DisputeVerifier",
  "IntentLifecycleHookV1",
  "StakeVault",
]) {
  if (
    !Array.isArray(sourceAbis[contractName]) ||
    sourceAbis[contractName].length === 0
  ) {
    fail(`${contractName} source ABI export is missing`);
  }
}

for (const { network, manifestNetwork, deploymentDirectory } of [
  { network: "base", manifestNetwork: "base", deploymentDirectory: "base" },
  {
    network: "baseStaging",
    manifestNetwork: "base_staging",
    deploymentDirectory: "base_staging",
  },
]) {
  const bundle = requireFromInstall(`@zkp2p/contracts-v2/networks/${network}`);
  const addresses = bundle.addresses?.default || bundle.addresses;
  if (
    Object.keys(addresses?.contracts || {}).some((contractName) =>
      contractName.endsWith("OptIn")
    ) ||
    Object.keys(bundle).some((contractName) => contractName.endsWith("OptIn"))
  ) {
    fail(`${network} exposes an internal OptIn contract name`);
  }
  for (const contractName of ["IntentGuardian", "WhitelistPolicy"]) {
    const address = addresses?.contracts?.[contractName];
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      fail(`${network}.${contractName} does not expose a nonzero address`);
    }
    if (
      !Array.isArray(bundle[contractName]) ||
      bundle[contractName].length === 0
    ) {
      fail(`${network}.${contractName} ABI export is missing`);
    }
  }
  for (const contractName of [
    "DisputeNullifierRegistry",
    "DisputeProtectionPolicy",
    "DisputeVerifier",
    "IntentLifecycleHookV1",
    "StakeVault",
  ]) {
    const address = addresses?.contracts?.[contractName];
    if (!/^0x[0-9a-fA-F]{40}$/.test(address) || /^0x0{40}$/.test(address)) {
      fail(
        `${network}.${contractName} does not expose the fresh nonzero address`
      );
    }
    if (
      !Array.isArray(bundle[contractName]) ||
      bundle[contractName].length === 0
    ) {
      fail(`${network}.${contractName} ABI export is missing`);
    }
    if (
      [
        "StakeVault",
        "DisputeProtectionPolicy",
        "IntentLifecycleHookV1",
      ].includes(contractName)
    ) {
      const deploymentName = getActiveDisputeDeploymentName(
        manifestNetwork,
        contractName
      );
      const deployment = JSON.parse(
        fs.readFileSync(
          path.join(
            repoRoot,
            "deployments",
            deploymentDirectory,
            `${deploymentName}.json`
          ),
          "utf8"
        )
      );
      if (address.toLowerCase() !== deployment.address.toLowerCase()) {
        fail(
          `${network}.${contractName} does not match the manifest-selected deployment`
        );
      }
    }
  }
}

console.log(
  `Installed @zkp2p/contracts-v2@${expectedVersion} import smoke test passed.`
);
