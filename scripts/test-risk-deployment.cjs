#!/usr/bin/env node

require("ts-node/register/transpile-only");
require("module-alias/register");
const moduleAlias = require("module-alias");
moduleAlias.reset();
moduleAlias.addAlias("@utils", `${process.cwd()}/utils`);

const fs = require("node:fs");
const path = require("node:path");
const {
  riskSettlementPlatformPolicyForNetwork,
  riskWitnessConfigForNetwork,
} = require("../deploy/28_deploy_risk_settlement_system.ts");

const root = path.resolve(__dirname, "..");
const scenario = process.argv[2];
let passed = false;

if (scenario === "retired") {
  const legacyTypeExport = path.join(root, "utils/contracts.ts");
  passed = !fs.existsSync(path.join(root, "contracts/hooks/DeferredPayoutHook.sol"))
    && !fs.existsSync(path.join(root, "contracts/interfaces/IDeferredPayoutHook.sol"))
    && (!fs.existsSync(legacyTypeExport)
      || !fs.readFileSync(legacyTypeExport, "utf8").includes("DeferredPayoutHook"));
} else if (scenario === "policy") {
  let policyError = "";
  let witnessError = "";
  try { riskSettlementPlatformPolicyForNetwork("base"); } catch (error) { policyError = error.message; }
  try { riskWitnessConfigForNetwork("base_staging"); } catch (error) { witnessError = error.message; }
  passed = policyError === "No governance-ratified risk-settlement platform policy for network: base"
    && witnessError === "No governance-ratified chargeback witness policy for network: base_staging";
} else {
  throw new Error(`Unknown risk deployment test scenario: ${scenario}`);
}

process.stdout.write(passed ? "0x01" : "0x00");
