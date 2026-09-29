const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");

require("ts-node/register/transpile-only");
require("module-alias/register");
require("module-alias").addAlias("hardhat", "ethers");

const { ethers } = require("ethers");
const disputeEvidence = require("../deployments/dispute-stack-evidence.json");
const packageJson = require("../package.json");
const upi = require("../deployments/verifiers/upi.ts");
const { getActivePaymentMethods } = require("../deployments/parameters.ts");

const laneSource = fs.readFileSync(
  path.resolve(__dirname, "../deploy/41_add_upi_payment_method.ts"),
  "utf8"
);
const bindingSource = fs.readFileSync(
  path.resolve(__dirname, "../deploy/31_deploy_v3_payment_binding_stack.ts"),
  "utf8"
);

test("generic UPI uses the canonical hash and only INR", () => {
  assert.equal(
    upi.UPI_PAYMENT_METHOD_HASH,
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("upi"))
  );
  assert.deepEqual(upi.UPI_CURRENCIES, [
    ethers.utils.keccak256(ethers.utils.toUtf8Bytes("INR")),
  ]);
  assert.deepEqual(upi.UPI_PROVIDER_CONFIG, {
    paymentMethodHash: upi.UPI_PAYMENT_METHOD_HASH,
    currencies: upi.UPI_CURRENCIES,
  });
});

test("UPI catalogs reflect the executed production registration without staging duplicates", () => {
  const productionMethods = [
    "alipay", "chime", "venmo", "revolut", "cashapp", "wise",
    "mercadopago", "zelle", "monzo", "paypal", "upi",
  ];
  assert.deepEqual(getActivePaymentMethods("base"), [...productionMethods, "xmoney"]);
  assert.deepEqual(getActivePaymentMethods("base_staging"), [
    ...productionMethods.slice(0, -1), "monobank", "mercury", "upi", "xmoney",
  ]);
  for (const network of ["localhost", "hardhat"]) {
    assert.deepEqual(getActivePaymentMethods(network), productionMethods.slice(0, -1));
  }
  assert.match(bindingSource, /upi:\s*\["INR"\]/u);
  assert.match(bindingSource, /"paypal",\s*"upi",/u);
  assert.match(bindingSource, /"mercury",\s*"upi",/u);
  assert.equal(
    disputeEvidence.riskWindowSecondsByPaymentMethod.base[
      upi.UPI_PAYMENT_METHOD_HASH
    ],
    "0"
  );
  assert.equal(
    disputeEvidence.riskWindowSecondsByPaymentMethod.base_staging[
      upi.UPI_PAYMENT_METHOD_HASH
    ],
    "0"
  );
});

test("UPI activation is tag-only, mutually exclusive, and staging-only", () => {
  assert.match(laneSource, /network !== "base_staging"/u);
  assert.match(laneSource, /const EXPECTED_CHAIN_ID = 8453/u);
  assert.match(
    laneSource,
    /const PREPARE_FLAG = "PREPARE_STAGING_UPI_PAYMENT_METHOD"/u
  );
  assert.match(
    laneSource,
    /const EXECUTE_FLAG = "EXECUTE_STAGING_UPI_PAYMENT_METHOD"/u
  );
  assert.match(laneSource, /if \(prepare && execute\)/u);
  assert.match(laneSource, /process\.env\.DEPLOY_ACTIVE_TAG === TAG/u);
  assert.match(laneSource, /UPI activation signer or contract owner mismatch/u);
  assert.match(laneSource, /UPI activation nullifier writer invariant failed/u);
  assert.ok(
    laneSource.lastIndexOf("await addPaymentMethodToUnifiedVerifier(") <
      laneSource.lastIndexOf("await addPaymentMethodToRegistry(")
  );
});

test("UPI scripts select only lane 41 and do not publish packages", () => {
  assert.equal(
    packageJson.scripts["prepare:upi:base_staging"],
    "PREPARE_STAGING_UPI_PAYMENT_METHOD=true ts-node --transpile-only scripts/deployActive.ts base_staging 41_add_upi_payment_method"
  );
  assert.equal(
    packageJson.scripts["deploy:upi:base_staging"],
    "EXECUTE_STAGING_UPI_PAYMENT_METHOD=true ts-node --transpile-only scripts/deployActive.ts base_staging 41_add_upi_payment_method"
  );
});
