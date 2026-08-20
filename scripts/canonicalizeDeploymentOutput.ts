import "ts-node/register/transpile-only";

import * as fs from "fs";
import * as path from "path";

type DeploymentEntry = {
  address: string;
  abi: unknown[];
  [key: string]: unknown;
};

export type DeploymentOutput = {
  name: string;
  chainId: string | number;
  contracts: Record<string, DeploymentEntry>;
  activeDisputeStack?: { version: number; selectionHash: string };
};

const {
  getActiveDisputeSelectionStamp,
  normalizeDisputeNetworkName,
  resolveActiveDisputeAliases,
} = require("../deployments/activeDisputeStack.cjs");

export function parseDeploymentOutput(source: string): DeploymentOutput {
  const json = source
    .replace(/^\s*export\s+default\s+/, "")
    .replace(/\s+as\s+const\s*;?\s*$/, "");
  const output = JSON.parse(json) as DeploymentOutput;
  if (
    !output ||
    typeof output.name !== "string" ||
    (typeof output.chainId !== "string" &&
      typeof output.chainId !== "number") ||
    !output.contracts ||
    typeof output.contracts !== "object" ||
    Array.isArray(output.contracts)
  ) {
    throw new Error("Invalid Hardhat deployment output");
  }
  return output;
}

export function serializeDeploymentOutput(output: DeploymentOutput): string {
  return `export default ${JSON.stringify(output, null, 2)} as const;\n`;
}

export function canonicalizeDeploymentOutput(
  network: string,
  outputPath: string
): void {
  const normalizedNetwork = normalizeDisputeNetworkName(network);
  const output = parseDeploymentOutput(fs.readFileSync(outputPath, "utf8"));
  if (normalizeDisputeNetworkName(output.name) !== normalizedNetwork) {
    throw new Error(
      `Deployment output network ${output.name} does not match ${network}`
    );
  }
  const canonical = {
    ...output,
    contracts: resolveActiveDisputeAliases(
      normalizedNetwork,
      output.contracts,
      output.activeDisputeStack
    ),
    activeDisputeStack: getActiveDisputeSelectionStamp(normalizedNetwork),
  };
  fs.writeFileSync(outputPath, serializeDeploymentOutput(canonical));
}

function main(): void {
  const network = process.argv[2];
  const outputPath = process.argv[3];
  if (!network || !outputPath) {
    throw new Error(
      "usage: canonicalizeDeploymentOutput <network> <deployment-output>"
    );
  }
  canonicalizeDeploymentOutput(network, path.resolve(outputPath));
}

if (require.main === module) main();
