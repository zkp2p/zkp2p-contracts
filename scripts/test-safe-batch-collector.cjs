#!/usr/bin/env node

require("ts-node/register/transpile-only");

const { SafeBatchCollector } = require("../deployments/safeBatchCollector.ts");

const scenario = process.argv[2];
const collector = new SafeBatchCollector();

if (scenario === "duplicate") {
  const target = "0x1111111111111111111111111111111111111111";
  const calldata = "0xABCDEF";
  collector.add(target, calldata);
  collector.add(target.toUpperCase().replace("0X", "0x"), calldata.toLowerCase());
} else if (scenario === "distinct") {
  const firstTarget = "0x1111111111111111111111111111111111111111";
  const secondTarget = "0x2222222222222222222222222222222222222222";
  collector.add(firstTarget, "0xaaaa");
  collector.add(firstTarget, "0xbbbb");
  collector.add(secondTarget, "0xaaaa");
} else {
  throw new Error(`Unknown SafeBatchCollector test scenario: ${scenario}`);
}

process.stdout.write(`0x${collector.count().toString(16).padStart(2, "0")}`);
