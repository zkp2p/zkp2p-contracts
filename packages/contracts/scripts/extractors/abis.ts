import "ts-node/register/transpile-only";
import * as fs from "fs";
import * as path from "path";

type OutputsContractEntry = {
  address: string;
  abi: any[];
};

type OutputsFileShape = {
  name: string; // network name
  chainId: string | number;
  contracts: Record<string, OutputsContractEntry>;
  activeDisputeStack?: { version: number; selectionHash: string };
};

const ROOT = path.resolve(__dirname, "../../../../");
const OUTPUTS_DIR = path.join(ROOT, "deployments", "outputs");
const PKG_ROOT = path.resolve(__dirname, "../..");
const ABIS_DIR = path.join(PKG_ROOT, "abis");
const { resolveActiveDisputeAliases } = require(path.join(
  ROOT,
  "deployments",
  "activeDisputeStack.cjs"
));

export function resolveAbiOutputContracts(
  network: string,
  contracts: Record<string, OutputsContractEntry>,
  activeDisputeStack?: { version: number; selectionHash: string }
): Record<string, OutputsContractEntry> {
  return resolveActiveDisputeAliases(network, contracts, activeDisputeStack);
}

const SOURCE_ABI_ARTIFACTS: Record<string, string> = {
  IntentGuardian: "contracts/IntentGuardian.sol/IntentGuardian.json",
  OrchestratorV3: "contracts/OrchestratorV3.sol/OrchestratorV3.json",
  NullifierRegistryV2:
    "contracts/registries/NullifierRegistryV2.sol/NullifierRegistryV2.json",
  UnifiedPaymentVerifierV3:
    "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol/UnifiedPaymentVerifierV3.json",
  AddressGroupRegistry:
    "contracts/registries/AddressGroupRegistry.sol/AddressGroupRegistry.json",
  WhitelistPolicy: "contracts/hooks/WhitelistPolicy.sol/WhitelistPolicy.json",
  WhitelistLifecycleHook:
    "contracts/hooks/WhitelistLifecycleHook.sol/WhitelistLifecycleHook.json",
  DisputeNullifierRegistry:
    "contracts/registries/NullifierRegistry.sol/NullifierRegistry.json",
  DisputeProtectionPolicy:
    "contracts/hooks/DisputeProtectionPolicy.sol/DisputeProtectionPolicy.json",
  DisputeVerifier:
    "contracts/unifiedVerifier/DisputeVerifier.sol/DisputeVerifier.json",
  IntentLifecycleHookV1:
    "contracts/hooks/IntentLifecycleHookV1.sol/IntentLifecycleHookV1.json",
  StakeVault: "contracts/StakeVault.sol/StakeVault.json",
};

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNetworkName(fileName: string): string {
  // e.g. baseContracts.ts => base; baseStagingContracts.ts => baseStaging
  return fileName.replace(/Contracts\.ts$/, "");
}

function minimalAbi(abi: any[]): any[] {
  // Return ABI as-is; trimming (e.g. removing dev fields) already done in outputs
  // If needed, we could sort or dedupe
  return abi;
}

export async function extractABIs(): Promise<void> {
  ensureDir(ABIS_DIR);

  const files = fs
    .readdirSync(OUTPUTS_DIR)
    .filter((f) => f.endsWith("Contracts.ts") && !f.startsWith("localhost"));

  const topIndexExports: string[] = [];

  for (const file of files) {
    const network = normalizeNetworkName(file);
    const modPath = path.join(OUTPUTS_DIR, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modPath);
    const rawData: OutputsFileShape = mod.default || mod;
    const data: OutputsFileShape = {
      ...rawData,
      contracts: resolveAbiOutputContracts(
        network,
        rawData.contracts,
        rawData.activeDisputeStack
      ),
    };

    const networkDir = path.join(ABIS_DIR, network);
    ensureDir(networkDir);

    const perNetworkIndex: string[] = [];
    for (const [name, entry] of Object.entries(data.contracts)) {
      const abi = minimalAbi(entry.abi || []);
      const out = path.join(networkDir, `${name}.json`);
      fs.writeFileSync(out, JSON.stringify(abi, null, 2));
      perNetworkIndex.push(
        `export { default as ${name} } from './${name}.json';`
      );
    }

    fs.writeFileSync(
      path.join(networkDir, "index.ts"),
      perNetworkIndex.join("\n") + "\n"
    );
    topIndexExports.push(`export * as ${network} from './${network}';`);
  }

  const contractsDir = path.join(ABIS_DIR, "contracts");
  ensureDir(contractsDir);
  const sourceIndex: string[] = [];
  for (const [name, artifactRelativePath] of Object.entries(
    SOURCE_ABI_ARTIFACTS
  )) {
    const artifactPath = path.join(ROOT, "artifacts", artifactRelativePath);
    if (!fs.existsSync(artifactPath)) {
      throw new Error(`Missing compiled artifact for ${name}: ${artifactPath}`);
    }
    const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));
    fs.writeFileSync(
      path.join(contractsDir, `${name}.json`),
      JSON.stringify(artifact.abi || [], null, 2)
    );
    sourceIndex.push(`export { default as ${name} } from './${name}.json';`);
  }
  fs.writeFileSync(
    path.join(contractsDir, "index.ts"),
    sourceIndex.join("\n") + "\n"
  );
  topIndexExports.push(`export * as contracts from './contracts';`);

  fs.writeFileSync(
    path.join(ABIS_DIR, "index.ts"),
    topIndexExports.join("\n") + "\n"
  );
  console.log(`✅ ABIs written to ${ABIS_DIR}`);
}
