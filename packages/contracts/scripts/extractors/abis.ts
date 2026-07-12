import 'ts-node/register/transpile-only';
import * as fs from 'fs';
import * as path from 'path';

type OutputsContractEntry = {
  address: string;
  abi: any[];
};

type OutputsFileShape = {
  name: string; // network name
  chainId: string | number;
  contracts: Record<string, OutputsContractEntry>;
};

const ROOT = path.resolve(__dirname, '../../../../');
const OUTPUTS_DIR = path.join(ROOT, 'deployments', 'outputs');
const PKG_ROOT = path.resolve(__dirname, '../..');
const ABIS_DIR = path.join(PKG_ROOT, 'abis');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function normalizeNetworkName(fileName: string): string {
  // e.g. baseContracts.ts => base; baseStagingContracts.ts => baseStaging
  return fileName.replace(/Contracts\.ts$/, '');
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
    .filter((f) => f.endsWith('Contracts.ts') && !f.startsWith('localhost'));

  const topIndexExports: string[] = [];

  for (const file of files) {
    const network = normalizeNetworkName(file);
    const modPath = path.join(OUTPUTS_DIR, file);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require(modPath);
    const data: OutputsFileShape = mod.default || mod;

    const networkDir = path.join(ABIS_DIR, network);
    ensureDir(networkDir);

    const perNetworkIndex: string[] = [];
    for (const [name, entry] of Object.entries(data.contracts)) {
      const abi = minimalAbi(entry.abi || []);
      const out = path.join(networkDir, `${name}.json`);
      fs.writeFileSync(out, JSON.stringify(abi, null, 2));
      perNetworkIndex.push(`export { default as ${name} } from './${name}.json';`);
    }

    fs.writeFileSync(path.join(networkDir, 'index.ts'), perNetworkIndex.join('\n') + '\n');
    topIndexExports.push(`export * as ${network} from './${network}';`);
  }

  fs.writeFileSync(path.join(ABIS_DIR, 'index.ts'), topIndexExports.join('\n') + '\n');
  console.log(`✅ ABIs written to ${ABIS_DIR}`);
}
