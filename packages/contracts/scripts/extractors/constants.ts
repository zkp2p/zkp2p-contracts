import 'ts-node/register/transpile-only';
import * as fs from 'fs';
import * as path from 'path';

// Preconfigure module aliasing to avoid pulling Hardhat at runtime
// Map `hardhat` -> `ethers` so utils/common/units.ts can resolve `ethers`
// without loading the Hardhat runtime (which triggers config plugins).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const moduleAlias = require('module-alias');
moduleAlias.addAlias('hardhat', 'ethers');

const ROOT = path.resolve(__dirname, '../../../../');
const PKG_ROOT = path.resolve(__dirname, '../..');
const CONSTANTS_DIR = path.join(PKG_ROOT, 'constants');

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// Helper function to serialize BigNumber values
function serializeValue(value: any): any {
  if (value && typeof value === 'object' && value._isBigNumber) {
    return value.toString();
  }
  return value;
}

export async function extractConstants(): Promise<void> {
  ensureDir(CONSTANTS_DIR);

  // Load parameters using require to avoid TypeScript imports
  const params = require(path.join(ROOT, 'deployments', 'parameters.ts'));

  // Network names based on what's actually in parameters.ts (excluding localhost)
  const networks = ['base', 'base_sepolia', 'base_staging'];
  const indexExports: string[] = [];
  const dtsExports: string[] = [];
  const networksList: string[] = [];

  for (const network of networks) {
    const networkConstants: Record<string, any> = {};

    if (params.INTENT_EXPIRATION_PERIOD?.[network] !== undefined) {
      networkConstants.INTENT_EXPIRATION_PERIOD = serializeValue(params.INTENT_EXPIRATION_PERIOD[network]);
    }

    if (params.PROTOCOL_TAKER_FEE?.[network] !== undefined) {
      networkConstants.PROTOCOL_TAKER_FEE = serializeValue(params.PROTOCOL_TAKER_FEE[network]);
    }

    if (params.PROTOCOL_TAKER_FEE_RECIPIENT?.[network] !== undefined) {
      networkConstants.PROTOCOL_TAKER_FEE_RECIPIENT = params.PROTOCOL_TAKER_FEE_RECIPIENT[network];
    }

    if (params.ESCROW_DUST_RECIPIENT?.[network] !== undefined) {
      networkConstants.ESCROW_DUST_RECIPIENT = params.ESCROW_DUST_RECIPIENT[network];
    }

    if (params.ESCROW_DUST_THRESHOLD?.[network] !== undefined) {
      networkConstants.ESCROW_DUST_THRESHOLD = serializeValue(params.ESCROW_DUST_THRESHOLD[network]);
    }

    if (params.MAX_INTENTS_PER_DEPOSIT?.[network] !== undefined) {
      networkConstants.MAX_INTENTS_PER_DEPOSIT = params.MAX_INTENTS_PER_DEPOSIT[network];
    }

    if (params.MULTI_SIG?.[network] !== undefined) {
      networkConstants.MULTI_SIG = params.MULTI_SIG[network];
    }

    if (params.USDC?.[network] !== undefined) {
      networkConstants.USDC = params.USDC[network];
    }

    if (params.WITNESS_ADDRESS?.[network] !== undefined) {
      networkConstants.WITNESS_ADDRESS = params.WITNESS_ADDRESS[network];
    }

    if (params.MULTI_WITNESS_ADDRESSES?.[network] !== undefined) {
      networkConstants.MULTI_WITNESS_ADDRESSES = params.MULTI_WITNESS_ADDRESSES[network];
    }

    if (params.MULTI_WITNESS_THRESHOLD?.[network] !== undefined) {
      networkConstants.MULTI_WITNESS_THRESHOLD = params.MULTI_WITNESS_THRESHOLD[network];
    }

    if (params.ZKTLS_ATTESTOR_ADDRESS?.[network] !== undefined) {
      networkConstants.ZKTLS_ATTESTOR_ADDRESS = params.ZKTLS_ATTESTOR_ADDRESS[network];
    }

    // Only write file if we have constants for this network
    if (Object.keys(networkConstants).length > 0) {
      // Normalize network name for file (base_sepolia -> baseSepolia)
      const fileName = network.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
      const outPath = path.join(CONSTANTS_DIR, `${fileName}.json`);
      fs.writeFileSync(outPath, JSON.stringify(networkConstants, null, 2));

      indexExports.push(`export { default as ${fileName} } from './${fileName}.json';`);

      // Write per-network .d.ts for constants
      const perNetworkDts = `// Typed constants file for ${fileName}
export type Constants = { USDC?: \`0x\${string}\` } & Record<string, unknown>;
declare const value: Constants;
export default value;
`;
      fs.writeFileSync(path.join(CONSTANTS_DIR, `${fileName}.d.ts`), perNetworkDts);
      dtsExports.push(`export { default as ${fileName} } from './${fileName}';`);
      networksList.push(fileName);
    }
  }

  // Create index with per-network exports
  fs.writeFileSync(
    path.join(CONSTANTS_DIR, 'index.ts'),
    indexExports.join('\n') + '\n'
  );

  // Create index.d.ts for typed entry
  fs.writeFileSync(
    path.join(CONSTANTS_DIR, 'index.d.ts'),
    `// Typed re-exports for constants\n${dtsExports.join('\n')}\n`
  );

  // Minimal index.json for default export compatibility
  fs.writeFileSync(
    path.join(CONSTANTS_DIR, 'index.json'),
    JSON.stringify({ networks: networksList, generatedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`✅ Constants written to ${CONSTANTS_DIR}`);
}
