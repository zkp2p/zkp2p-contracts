const assert = require("node:assert/strict");
const { test } = require("node:test");

// Decide before loading Hardhat/config/dotenv. Never discover a fork URL from a local file.
test("Base O4 deploy, prepare, Safe activation and direct Safe rollback rehearsal", {
  skip: process.env.BASE_FORK_RPC_URL ? false : "BASE_FORK_RPC_URL is unset",
}, async () => {
  require("ts-node/register/transpile-only");
  const { mkdtempSync, readFileSync, rmSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  const { execFileSync } = require("node:child_process");
  const { Wallet, VoidSigner, Contract, utils } = require("ethers");
  const { assertO4ForkEnvironment, resetO4BaseFork, simulateO4SafeBatches, writeO4Artifacts, verifyO4Artifacts, printO4Batches, renderO4Artifacts } = require("./orchestrator-v4-safe-batches.ts");
  assertO4ForkEnvironment();
  const { restoreHardhatModuleResolution } = require("./simulate-dispute-opt-in-safe-batch.ts");
  restoreHardhatModuleResolution();
  const hre = require("hardhat");
  const { inspect, assertFreshDeploymentPreflight, deploySuite, prepareGovernance, TransactionJournal, NEW_CONTRACTS, hash } = require("./deploy-orchestrator-v4.ts");
  const { BASE_SAFE } = require("./proposeSafeBatchChunks.ts");
  await resetO4BaseFork(hre);
  const original = JSON.parse(readFileSync("deployments/orchestrator-v4/base.json", "utf8"));
  // This well-known fixture key is the only key used to sign deployment transactions, on the fork only.
  const wallet = Wallet.fromMnemonic("test test test test test test test test test test test junk").connect(hre.ethers.provider);
  const configuration = { ...original, signer: wallet.address };
  await hre.network.provider.send("hardhat_setBalance", [wallet.address, utils.hexValue(utils.parseEther("100"))]);
  const baseline = await inspect(hre, configuration);
  assertFreshDeploymentPreflight(configuration, baseline);
  const directory = mkdtempSync(join(tmpdir(), "o4-base-fork-"));
  const deployments = hre.config.paths.deployments;
  hre.config.paths.deployments = join(directory, "deployments");
  const adoptedPath = "deployments/base/UnifiedPaymentVerifierV4.json", adoptedBytes = readFileSync(adoptedPath, "utf8");
  try {
    const manifest = { version: 1, sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(), configurationHash: hash(configuration), configuration, baseline, transactions: [], activationDrainEvidence: null, contracts: {}, verification: {}, governanceTransactions: [] };
    const manifestPath = join(directory, "manifest.json");
    await deploySuite(hre, new TransactionJournal(manifestPath, manifest, wallet));
    assert.deepEqual(Object.keys(manifest.contracts).sort(), Object.keys(NEW_CONTRACTS).filter((n) => n !== "UnifiedPaymentVerifierV4").sort());
    assert.equal(manifest.transactions.filter((tx) => tx.step.startsWith("deploy:")).length, 7);
    assert.equal(readFileSync(adoptedPath, "utf8"), adoptedBytes);
    const afterDeploy = await inspect(hre, configuration);
    assert.deepEqual(afterDeploy.contracts.UnifiedPaymentVerifierV4, baseline.contracts.UnifiedPaymentVerifierV4);
    assert.deepEqual(afterDeploy.paymentMethods, baseline.paymentMethods);
    assert.deepEqual(afterDeploy.nullifierWriters, baseline.nullifierWriters);
    assert.deepEqual(afterDeploy.disputeWriters, baseline.disputeWriters);
    assert.deepEqual(afterDeploy.predecessor, baseline.predecessor);
    const journal = new TransactionJournal(manifestPath, manifest, new VoidSigner(wallet.address, hre.ethers.provider));
    let discovered;
    await assert.rejects(prepareGovernance(hre, journal, "999999999999999999999999999999"), (error) => {
      const match = /^O4_BASE_ACCEPT_PUBLIC_PRIVATE_DEPOSITS count mismatch: discovered (\d+) private deposits/.exec(error.message);
      if (!match) return false;
      discovered = match[1]; return true;
    });
    console.log(`Base private-deposit discovery: N=${discovered}`);
    assert.notEqual(discovered, "0", "The runner only accepts positive acknowledgements; zero discovered deposits require no acknowledgement");
    await prepareGovernance(hre, journal, discovered);
    assert.deepEqual(manifest.governanceTransactions.map((tx) => tx.step), ["accept:StakeVaultV2", "accept:DisputeProtectionPolicyV2", "authorize-policy-writer", "register-orchestrator"]);
    const directoryBatches = join(directory, "safe-batches");
    writeO4Artifacts(manifest, directoryBatches); verifyO4Artifacts(manifest, directoryBatches);
    const safe = new Contract(BASE_SAFE, ["function nonce() view returns(uint256)"], hre.ethers.provider), nonce = (await safe.nonce()).toNumber();
    for (const { fileName, contents } of renderO4Artifacts(manifest)) console.log(`${fileName}\n${contents}`);
    printO4Batches(manifest, nonce);
    const manifestBytes = readFileSync(manifestPath, "utf8");
    const result = await simulateO4SafeBatches(hre, manifest, nonce);
    assert.equal(result.activation.nonce, nonce); assert.equal(result.rollback.nonce, nonce + 1);
    assert.equal(readFileSync(manifestPath, "utf8"), manifestBytes);
    assert.equal(manifest.verification.active, false);
    assert.equal(readFileSync(adoptedPath, "utf8"), adoptedBytes);
  } finally {
    hre.config.paths.deployments = deployments;
    rmSync(directory, { recursive: true, force: true });
  }
});
