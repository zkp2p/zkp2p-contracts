import "module-alias/register";
import { ethers } from "ethers";

/**
 * Pyth Price Keeper
 *
 * Pushes latest Pyth price updates on-chain every hour.
 * Run via cron: `0 * * * * npx ts-node -r module-alias/register scripts/pyth_price_keeper.ts`
 *
 * Env vars:
 *   ALCHEMY_API_KEY  - Alchemy API key for Base RPC
 *   KEEPER_PRIVATE_KEY - Private key for the keeper wallet
 *   PYTH_CONTRACT    - (optional) Override Pyth contract address
 *   NETWORK          - (optional) "base" or "base_sepolia" (default: "base")
 */

// --------------- Configuration ---------------

const NETWORK = process.env.NETWORK || "base";

const RPC_URLS: Record<string, string> = {
  base: `https://base-mainnet.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
  base_sepolia: `https://base-sepolia.g.alchemy.com/v2/${process.env.ALCHEMY_API_KEY}`,
};

const PYTH_ADDRESSES: Record<string, string> = {
  base: "0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a",
  base_sepolia: "0xA2aa501b19aff244D90cc15a4Cf739D2725B5729",
};

const HERMES_URL = "https://hermes.pyth.network/v2/updates/price/latest";

// FX feed IDs from https://pyth.network/developers/price-feed-ids
// Format: currency pair → Pyth feed ID
const FEED_IDS: Record<string, string> = {
  // Major pairs
  "USD/EUR": "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
  "USD/GBP": "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",
  "USD/JPY": "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091571b65f1e5c348e01",
  "USD/AUD": "0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80",
  "USD/CAD": "0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca",
  "USD/CHF": "0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8",
  // Emerging market pairs
  "USD/INR": "0x3b8a3db7e7b1a72dd4c4e7d6fceb1e72c26c16f3ee52e068e217110e3b075a07",
  "USD/BRL": "0x859e07c03bf4a4e0b5d8a7e18a9e4c5a02f5ab4d1e2c0c6b8d5e7f3a1c9b8d7e",
  "USD/MXN": "0xe13b1c1ffb32f34e1be9545583f01ef385fde7f42ee66d16d03ddd7b3a8c054e",
  "USD/TRY": "0xdca038e74b1a10ee1d76a72a04e6e1a0059380eff3b47aca8fd0e85e20a75e44",
  "USD/THB": "0x8e0df5dec01d3c39f39012e1e77a5242e12f7e66c9c0cb30e17e8ba8b695a96e",
  "USD/SGD": "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918",
  "USD/IDR": "0x160ba8b36ba5ff7e2ddff7acb7a65001e28ec300b0332cded35aa3b23ccf6254",
  "USD/MYR": "0x4c257a5ebc7a60e6157093c00b4c4bc1a1f9dd4f8e236e2c5f7a16a60c00fb28",
  "USD/ZAR": "0x94e7faec5015b7a59a83f721e9bb5f8c7f4ea8d7f93b5a4a10f2f9e9f8e9e8d7",
};

const PYTH_ABI = [
  "function updatePriceFeeds(bytes[] calldata updateData) external payable",
  "function getUpdateFee(bytes[] calldata updateData) external view returns (uint256 feeAmount)",
];

// --------------- Main ---------------

async function main() {
  if (!process.env.ALCHEMY_API_KEY) {
    throw new Error("Missing ALCHEMY_API_KEY env var");
  }
  if (!process.env.KEEPER_PRIVATE_KEY) {
    throw new Error("Missing KEEPER_PRIVATE_KEY env var");
  }

  const rpcUrl = RPC_URLS[NETWORK];
  if (!rpcUrl) {
    throw new Error(`Unknown network: ${NETWORK}`);
  }

  const pythAddress = process.env.PYTH_CONTRACT || PYTH_ADDRESSES[NETWORK];
  if (!pythAddress) {
    throw new Error(`No Pyth contract address for network: ${NETWORK}`);
  }

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(process.env.KEEPER_PRIVATE_KEY, provider);
  const pyth = new ethers.Contract(pythAddress, PYTH_ABI, wallet);

  console.log(`[${new Date().toISOString()}] Pyth Price Keeper`);
  console.log(`  Network: ${NETWORK}`);
  console.log(`  Keeper: ${wallet.address}`);
  console.log(`  Pyth: ${pythAddress}`);

  // Fetch latest VAAs from Hermes
  const feedIds = Object.values(FEED_IDS);
  const idsParam = feedIds.map(id => `ids[]=${id}`).join("&");
  const url = `${HERMES_URL}?${idsParam}`;

  console.log(`  Fetching ${feedIds.length} price feeds from Hermes...`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Hermes API error: ${response.status} ${response.statusText}`);
  }

  const data = await response.json() as { binary: { data: string[] } };
  const updateData = data.binary.data.map((d: string) => `0x${d}`);

  // Get fee and submit update
  const fee = await pyth.getUpdateFee(updateData);
  console.log(`  Update fee: ${ethers.utils.formatEther(fee)} ETH`);

  const tx = await pyth.updatePriceFeeds(updateData, { value: fee });
  console.log(`  Tx submitted: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`  Tx confirmed in block ${receipt.blockNumber}, gas used: ${receipt.gasUsed.toString()}`);
  console.log(`[${new Date().toISOString()}] Done.`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("[ERROR]", error.message || error);
    process.exit(1);
  });
