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
// Verified against Hermes API: https://hermes.pyth.network/v2/updates/price/latest
// Format: currency pair → Pyth feed ID
const FEED_IDS: Record<string, string> = {
  // Major pairs — verified active on Hermes 2026-03-03
  // Note: EUR, GBP, AUD, NZD are quoted as XXX/USD on Pyth (use invert=true on-chain)
  "USD/EUR": "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",  // FX.EUR/USD
  "USD/GBP": "0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1",  // FX.GBP/USD
  "USD/JPY": "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",  // FX.USD/JPY
  "USD/AUD": "0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80",  // FX.AUD/USD
  "USD/CAD": "0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca",  // FX.USD/CAD
  "USD/CHF": "0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8",  // FX.USD/CHF
  "USD/SGD": "0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918",  // FX.USD/SGD
  "USD/HKD": "0x19d75fde7fee50fe67753fdc825e583594eb2f51ae84e114a5246c4ab23aff4c",  // FX.USD/HKD
  "USD/NOK": "0x235ddea9f40e9af5814dbcc83a418b98e3ee8df1e34e1ae4d45cf5de596023a3",  // FX.USD/NOK
  "USD/NZD": "0x92eea8ba1b00078cdc2ef6f64f091f262e8c7d0576ee4677572f314ebfafa4c7",  // FX.NZD/USD
  "USD/SEK": "0x8ccb376aa871517e807358d4e3cf0bc7fe4950474dbe6c9ffc21ef64e43fc676",  // FX.USD/SEK
  // Emerging market pairs — verified active on Hermes 2026-03-03
  "USD/BRL": "0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906",  // FX.USD/BRL
  "USD/MXN": "0xe13b1c1ffb32f34e1be9545583f01ef385fde7f42ee66049d30570dc866b77ca",  // FX.USD/MXN
  "USD/TRY": "0x032a2eba1c2635bf973e95fb62b2c0705c1be2603b9572cc8d5edeaf8744e058",  // FX.USD/TRY
  "USD/INR": "0x0ac0f9a2886fc2dd708bc66cc2cea359052ce89d324f45d95fadbc6c4fcf1809",  // FX.USD/INR
  "USD/IDR": "0x6693afcd49878bbd622e46bd805e7177932cf6ab0b1c91b135d71151b9207433",  // FX.USD/IDR
  "USD/ZAR": "0x389d889017db82bf42141f23b61b8de938a4e2d156e36312175bebf797f493f1",  // FX.USD/ZAR
  "USD/PHP": "0x2bda7f268b52bfbc3f2e124c31445247647350db313caadc6771e6299e0a68c9",  // FX.USD/PHP
  // Inactive feeds — registered on Pyth but publish_time=0 as of 2026-03-03
  // Uncomment when Pyth activates these feeds
  // "USD/THB": "0xab1bdad3d2984801e48480cca22df5d709fdfd2149246c9aef6e06a17a0a9394",
  // "USD/MYR": "0x6049eac22964b1ac2119e54c98f3caa165817d84273a121ee122fafb664a8094",
  // "USD/AED": "0x3bbf6718b6094fc9cc2f047fc280f40c6dc865859b3a4a80846064df1eff0c12",
  // "USD/ARS": "0x8902172deb18026d0f84cd34d6f1d30a70708b83d05495aff40938b092bec450",
  // "USD/CNY": "0x4a134870158ad1ea98bc4e4eb8e4ca824a32e69d4f3da380377c09936ba23954",
  // "USD/CZK": "0xffe0b5050b12dd66e892d95a0470f5f8ddedd4e64991250112db58ebf2970499",
  // "USD/DKK": "0x0df79792804744b7b799aebc0e514754de7b208cb06ae66bc16c67210fef3112",
  // "USD/HUF": "0xf2709f4b9c20bf25c08a0d751faa0d202ec74a9254ceacbd6519bd33ef5293b3",
  // "USD/ILS": "0x158666978da811cac711193ff8bbb6f3a19c0da582fae820d933c6b9ceec6998",
  // "USD/KES": "0x33cc660971b0e63062d2f67b7183ba17f67b246d4a7170788649979258f7d007",
  // "USD/PLN": "0x07cd9b7bb0575a74a7eec1ea357fb01aff3a5d9a1b567394dbdf87ddb5bf777b",
  // "USD/RON": "0x4f59bd91914d02ee5b5dd6db1484f9dc66feb7b5e2bb2f9b96370538c9ce7b94",
  // "USD/SAR": "0x3e95c98e63a45438e1f242419f9867660b88eeeecf697aed33f188366f2b7006",
  // "USD/UGX": "0x1f946ee84ce82dbbaa0fec69cdd4cb9e911076788c77c6f36d42a3491a284ce1",
  // "USD/VND": "0x325e6af848703dacd63f82091d119a3ec8669bb9441b337e821e749f3edd5381",
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
