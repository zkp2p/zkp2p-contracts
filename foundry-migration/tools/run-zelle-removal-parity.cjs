#!/usr/bin/env node

require("ts-node/register/transpile-only");
require("module-alias/register");
const moduleAlias = require("module-alias");
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");
console.log = () => {};

const fs = require("node:fs");
const { ethers } = require("hardhat");
const {
  GENERIC_ZELLE_PAYMENT_METHOD_HASH,
  LEGACY_ZELLE_PAYMENT_METHODS,
  removeLegacyZelleVerifierRegistrations,
} = require("../../deploy/27_remove_legacy_zelle_payment_methods.ts");
const { safeBatchCollector } = require("../../deployments/safeBatchCollector.ts");

if (process.argv[2] !== "safe") throw new Error("Unknown Zelle removal parity scenario: " + process.argv[2]);

const safeOwner = "0x9999999999999999999999999999999999999999";
const registryAddress = "0x1111111111111111111111111111111111111111";
const legacyAddress = "0x2222222222222222222222222222222222222222";
const v2Address = "0x3333333333333333333333333333333333333333";
const hashes = LEGACY_ZELLE_PAYMENT_METHODS.map(({ hash }) => hash);
const removalInterface = new ethers.utils.Interface(["function removePaymentMethod(bytes32)"]);
const hre = { getUnnamedAccounts: async () => [] };
const registry = {
  address: registryAddress,
  interface: removalInterface,
  owner: async () => safeOwner,
  isPaymentMethod: async (method) => method === GENERIC_ZELLE_PAYMENT_METHOD_HASH || hashes.includes(method),
  getVerifier: async (method) => method === GENERIC_ZELLE_PAYMENT_METHOD_HASH ? v2Address : ethers.constants.AddressZero,
};
const verifier = (address) => ({
  address,
  interface: removalInterface,
  owner: async () => safeOwner,
  getPaymentMethods: async () => [GENERIC_ZELLE_PAYMENT_METHOD_HASH, ...hashes],
});
const legacy = verifier(legacyAddress);
const v2 = verifier(v2Address);

(async () => {
  await removeLegacyZelleVerifierRegistrations(
    hre,
    { paymentVerifierRegistry: registry, legacyUnifiedPaymentVerifier: legacy, unifiedPaymentVerifierV2: v2 },
    v2Address,
  );
  await removeLegacyZelleVerifierRegistrations(
    hre,
    { paymentVerifierRegistry: registry, legacyUnifiedPaymentVerifier: legacy, unifiedPaymentVerifierV2: v2 },
    v2Address,
  );
  let passed = safeBatchCollector.count() === 9;
  const file = safeBatchCollector.writeBatchFile("hardhat", "31337", safeOwner);
  try {
    const batch = JSON.parse(fs.readFileSync(file, "utf8"));
    const expected = [
      ...hashes.map((hash) => ({ to: registryAddress, data: removalInterface.encodeFunctionData("removePaymentMethod", [hash]) })),
      ...hashes.map((hash) => ({ to: legacyAddress, data: removalInterface.encodeFunctionData("removePaymentMethod", [hash]) })),
      ...hashes.map((hash) => ({ to: v2Address, data: removalInterface.encodeFunctionData("removePaymentMethod", [hash]) })),
    ];
    passed = passed && batch.chainId === "31337" && batch.meta.createdFromSafeAddress === safeOwner
      && batch.transactions.length === expected.length
      && expected.every((tx, index) => batch.transactions[index].to.toLowerCase() === tx.to.toLowerCase()
        && batch.transactions[index].data.toLowerCase() === tx.data.toLowerCase()
        && batch.transactions[index].value === "0");
  } finally {
    fs.unlinkSync(file);
  }
  process.stdout.write(passed ? "0x01" : "0x00");
})().catch((error) => { console.error(error); process.exit(1); });
