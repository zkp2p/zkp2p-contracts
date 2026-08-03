import * as fs from "fs";
import * as path from "path";
import type { JsonFragment } from "@ethersproject/abi";
import { ethers } from "ethers";

interface DeploymentArtifact {
  address: string;
  abi: JsonFragment[];
}

interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  contractMethod: null;
  contractInputsValues: null;
}

const NETWORK = "base";
const CHAIN_ID = "8453";
const SAFE_ADDRESS = "0x0bC26FF515411396DD588Abd6Ef6846E04470227";
const RETIRED_VERIFIERS = ["UnifiedPaymentVerifier", "UnifiedPaymentVerifierV2"] as const;
const OUTPUT_FILE = path.join(
  __dirname,
  "..",
  "deployments",
  "outputs",
  "safe-batches",
  "base_legacy_nullifier_writer_cleanup.json",
);

function readDeployment(contractName: string): DeploymentArtifact {
  const artifactPath = path.join(__dirname, "..", "deployments", NETWORK, `${contractName}.json`);
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as DeploymentArtifact;

  if (!ethers.utils.isAddress(artifact.address)) {
    throw new Error(`${contractName} has an invalid deployment address: ${artifact.address}`);
  }
  if (!Array.isArray(artifact.abi)) {
    throw new Error(`${contractName} deployment artifact is missing its ABI`);
  }

  return artifact;
}

function main(): void {
  if (!ethers.utils.isAddress(SAFE_ADDRESS)) {
    throw new Error(`No valid Safe address configured for ${NETWORK}`);
  }

  const nullifierRegistry = readDeployment("NullifierRegistry");
  const nullifierRegistryInterface = new ethers.utils.Interface(nullifierRegistry.abi);
  const retiredVerifierAddresses = RETIRED_VERIFIERS.map((contractName) => ({
    contractName,
    address: readDeployment(contractName).address,
  }));

  const uniqueAddresses = new Set(retiredVerifierAddresses.map(({ address }) => address.toLowerCase()));
  if (uniqueAddresses.size !== RETIRED_VERIFIERS.length) {
    throw new Error("Retired verifier deployment artifacts resolve to duplicate addresses");
  }

  const transactions: SafeTransaction[] = retiredVerifierAddresses.map(({ address }) => ({
    to: nullifierRegistry.address,
    value: "0",
    data: nullifierRegistryInterface.encodeFunctionData("removeWritePermission", [address]),
    contractMethod: null,
    contractInputsValues: null,
  }));

  const batch = {
    version: "1.0",
    chainId: CHAIN_ID,
    createdAt: Date.now(),
    meta: {
      name: "ZKP2P Legacy Nullifier Writer Cleanup - base",
      description:
        "Post-UPV3-cutover cleanup: revoke legacy NullifierRegistry write permission from retired UnifiedPaymentVerifier and UnifiedPaymentVerifierV2. Execute only after all payment methods route to UPV3 and every production attestation signer targets UPV3.",
      txBuilderVersion: "1.16.5",
      createdFromSafeAddress: SAFE_ADDRESS,
      createdFromOwnerAddress: "",
    },
    transactions,
  };

  fs.writeFileSync(OUTPUT_FILE, `${JSON.stringify(batch, null, 2)}\n`);
  console.log(`Wrote ${transactions.length} transactions to ${OUTPUT_FILE}`);
  for (const { contractName, address } of retiredVerifierAddresses) {
    console.log(`  - NullifierRegistry.removeWritePermission(${contractName}: ${address})`);
  }
}

main();
