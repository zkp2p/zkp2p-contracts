import * as dotenv from 'dotenv';

import '@typechain/hardhat'
import 'solidity-coverage'
import '@nomiclabs/hardhat-ethers'
import 'hardhat-deploy';
import '@nomicfoundation/hardhat-verify';
import '@nomicfoundation/hardhat-chai-matchers'
import 'hardhat-gas-reporter';
import '@nomicfoundation/hardhat-foundry';

import { HardhatUserConfig } from "hardhat/config";

import "./tasks/etherscanVerifyWithDelay";


dotenv.config();

// Skip non-deploy script files (e.g., Markdown notes, CLAUDE.md etc.) in the deploy/ folder
// by registering no-op require handlers that instruct hardhat-deploy to skip them.
// This prevents ts-node from trying to compile arbitrary extensions like .md.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(require as any).extensions = (require as any).extensions || {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const skipModule: any = (module: any, filename: string) => {
  // Export a skip function that always returns true so hardhat-deploy ignores the file
  module._compile('module.exports = { skip: async () => true }', filename);
};
// Common non-code extensions to ignore under deploy/
// Add more here if needed (e.g., .mdx, .txt)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(require as any).extensions['.md'] = skipModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(require as any).extensions['.mdx'] = skipModule;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(require as any).extensions['.txt'] = skipModule;

const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      {
        version: "0.8.18",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true
        },
      },
    ],
  },
  networks: {
    hardhat: {
      initialDate: "2024-01-20 01:15:15 PM",
      allowBlocksWithSameTimestamp: true,
      initialBaseFeePerGas: 0,
      blockGasLimit: 100_000_000,
      gas: 100_000_000,
    },
    localhost: {
      allowBlocksWithSameTimestamp: true,
    },
    base_staging: {
      url: "https://developer-access-mainnet.base.org",
      // @ts-ignore
      accounts: [
        `0x${process.env.BASE_DEPLOY_PRIVATE_KEY}`,
      ],
      verify: {
        etherscan: {
          apiUrl: "https://api.basescan.org/",
          apiKey: process.env.BASESCAN_API_KEY
        }
      },
    },
    base: {
      url: "https://base-mainnet.g.alchemy.com/v2/" + process.env.ALCHEMY_API_KEY,
      // @ts-ignore
      accounts: [
        `0x${process.env.BASE_DEPLOY_PRIVATE_KEY}`,
        ...(process.env.VANITY_ESCROW_V2_PROD_PRIVATE_KEY
          ? [`0x${process.env.VANITY_ESCROW_V2_PROD_PRIVATE_KEY}`]
          : []),
        ...(process.env.VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY
          ? [`0x${process.env.VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY}`]
          : []),
      ]
    },
  },
  // @ts-ignore
  typechain: {
    outDir: "typechain",
    target: "ethers-v5",
  },
  gasReporter: {
    enabled: false,
    reportPureAndViewMethods: true,
    showMethodSig: true,
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_KEY || "",
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },
};

export default config;
