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
};

const ROOT = path.resolve(__dirname, "../../../../");
const OUTPUTS_DIR = path.join(ROOT, "deployments", "outputs");
const PKG_ROOT = path.resolve(__dirname, "../..");
const ADDRESSES_DIR = path.join(PKG_ROOT, "addresses");
const { resolveActiveDisputeAliases } = require(path.join(
  ROOT,
  "deployments",
  "activeDisputeStack.cjs"
));

export function resolveAddressOutputContracts(
  network: string,
  contracts: Record<string, OutputsContractEntry>
): Record<string, OutputsContractEntry> {
  return resolveActiveDisputeAliases(network, contracts);
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNetworkName(fileName: string): string {
  // e.g. baseContracts.ts => base; baseStagingContracts.ts => baseStaging
  return fileName.replace(/Contracts\.ts$/, "");
}

export async function extractAddresses(): Promise<void> {
  ensureDir(ADDRESSES_DIR);

  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  const files = fs
    .readdirSync(OUTPUTS_DIR)
    .filter((f) => f.endsWith("Contracts.ts") && !f.startsWith("localhost"));

  // First pass: load all networks and collect the union of all contract names
  const networksData: {
    file: string;
    network: string;
    data: OutputsFileShape;
  }[] = [];
  const allContractNames = new Set<string>();

  for (const file of files) {
    const network = normalizeNetworkName(file);
    const modPath = path.join(OUTPUTS_DIR, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modPath);
    const rawData: OutputsFileShape = mod.default || mod;
    const data: OutputsFileShape = {
      ...rawData,
      contracts: resolveAddressOutputContracts(network, rawData.contracts),
    };
    networksData.push({ file, network, data });

    for (const name of Object.keys(data.contracts)) allContractNames.add(name);
  }

  const indexExports: string[] = [];
  const dtsExports: string[] = [];
  const networksList: string[] = [];

  // Second pass: write address files, backfilling zero addresses for missing contracts
  for (const { network, data } of networksData) {
    const chainId =
      typeof data.chainId === "string" ? Number(data.chainId) : data.chainId;

    const contracts: Record<string, string> = {};
    for (const name of allContractNames) {
      const entry = data.contracts[name];
      contracts[name] = entry ? entry.address : ZERO_ADDRESS;
    }

    const payload = {
      name: data.name,
      chainId,
      contracts,
      meta: { generatedAt: new Date().toISOString() },
    };

    const outPath = path.join(ADDRESSES_DIR, `${network}.json`);
    fs.writeFileSync(outPath, JSON.stringify(payload, null, 2));

    indexExports.push(
      `export { default as ${network} } from './${network}.json';`
    );
    networksList.push(network);

    // Write per-network .d.ts alongside JSON for strong typing
    const perNetworkDts = `// Typed address file for ${network}
export type AddressFile = { name: string; chainId: number; contracts: Record<string, \`0x\${string}\`>; meta?: Record<string, unknown> };
declare const value: AddressFile;
export default value;
`;
    fs.writeFileSync(
      path.join(ADDRESSES_DIR, `${network}.d.ts`),
      perNetworkDts
    );
    dtsExports.push(`export { default as ${network} } from './${network}';`);
  }

  // Write an index.ts exporting each network JSON
  const indexPath = path.join(ADDRESSES_DIR, "index.ts");
  fs.writeFileSync(indexPath, indexExports.join("\n") + "\n");

  // Also write an index.d.ts so package.json exports can point to it
  const indexDtsPath = path.join(ADDRESSES_DIR, "index.d.ts");
  const indexDts = `// Typed re-exports for address files\n${dtsExports.join(
    "\n"
  )}\n`;
  fs.writeFileSync(indexDtsPath, indexDts);

  // Write a minimal index.json for default export compatibility
  const indexJsonPath = path.join(ADDRESSES_DIR, "index.json");
  fs.writeFileSync(
    indexJsonPath,
    JSON.stringify(
      { networks: networksList, generatedAt: new Date().toISOString() },
      null,
      2
    )
  );

  console.log(`✅ Addresses written to ${ADDRESSES_DIR}`);
}
