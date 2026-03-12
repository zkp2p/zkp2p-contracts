// Static oracle feed data — single source of truth for Chainlink and Pyth feeds
// used by the protocol. Manually maintained; sourced from arm-dashboard/src/constants.ts
// and deployments/parameters.ts.

export interface ChainlinkFeed {
  pair: string;
  feed: string;
  decimals: number;
}

export interface PythFeed {
  pair: string;
  feedId: string;
  decimals: number;
}

// ── Chainlink FX proxy addresses on Base mainnet ──────────────────────
// Verified on-chain via description() calls
export const CHAINLINK_FEEDS: ChainlinkFeed[] = [
  { pair: 'AUD/USD', feed: '0x46e51B8cA41d709928EdA9Ae43e42193E6CDf229', decimals: 8 },
  { pair: 'BRL/USD', feed: '0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394', decimals: 8 },
  { pair: 'CAD/USD', feed: '0xA840145F87572E82519d578b1F36340368a25D5d', decimals: 8 },
  { pair: 'CHF/USD', feed: '0x3A1d6444fb6a402470098E23DaD0B7E86E14252F', decimals: 8 },
  { pair: 'EUR/USD', feed: '0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F', decimals: 8 },
  { pair: 'GBP/USD', feed: '0xCceA6576904C118037695eB71195a5425E69Fa15', decimals: 8 },
  { pair: 'MXN/USD', feed: '0x9e8Ee77c76d4fa41306056D1C3196AF5da1600bd', decimals: 8 },
  { pair: 'NZD/USD', feed: '0x06bdFe07E71C476157FC025d3cCD4BBe08e83EF9', decimals: 8 },
  { pair: 'SGD/USD', feed: '0x81575495532fB311Efc5C993B612564274F0949b', decimals: 8 },
  { pair: 'TRY/USD', feed: '0x29413773e7CD4Dfd6Ad89a50887877b88a6C592C', decimals: 8 },
];

// ── Pyth FX feed IDs ─────────────────────────────────────────────────
export const PYTH_FEEDS: PythFeed[] = [
  // XXX/USD pairs
  { pair: 'EUR/USD', feedId: '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b', decimals: 8 },
  { pair: 'GBP/USD', feedId: '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1', decimals: 8 },
  { pair: 'AUD/USD', feedId: '0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80', decimals: 8 },
  { pair: 'NZD/USD', feedId: '0x92eea8ba1b00078cdc2ef6f64f091f262e8c7d0576ee4677572f314ebfafa4c7', decimals: 8 },
  // USD/XXX pairs
  { pair: 'USD/INR', feedId: '0x0ac0f9a2886fc2dd708bc66cc2cea359052ce89d324f45d95fadbc6c4fcf1809', decimals: 8 },
  { pair: 'USD/JPY', feedId: '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52', decimals: 8 },
  { pair: 'USD/CAD', feedId: '0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca', decimals: 8 },
  { pair: 'USD/SGD', feedId: '0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918', decimals: 8 },
  { pair: 'USD/CHF', feedId: '0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8', decimals: 8 },
  { pair: 'USD/HKD', feedId: '0x19d75fde7fee50fe67753fdc825e583594eb2f51ae84e114a5246c4ab23aff4c', decimals: 8 },
  { pair: 'USD/MXN', feedId: '0xe13b1c1ffb32f34e1be9545583f01ef385fde7f42ee66049d30570dc866b77ca', decimals: 8 },
  { pair: 'USD/AED', feedId: '0x3bbf6718b6094fc9cc2f047fc280f40c6dc865859b3a4a80846064df1eff0c12', decimals: 8 },
  { pair: 'USD/SAR', feedId: '0x3e95c98e63a45438e1f242419f9867660b88eeeecf697aed33f188366f2b7006', decimals: 8 },
  { pair: 'USD/THB', feedId: '0xab1bdad3d2984801e48480cca22df5d709fdfd2149246c9aef6e06a17a0a9394', decimals: 8 },
  { pair: 'USD/TRY', feedId: '0x032a2eba1c2635bf973e95fb62b2c0705c1be2603b9572cc8d5edeaf8744e058', decimals: 8 },
  { pair: 'USD/PLN', feedId: '0x07cd9b7bb0575a74a7eec1ea357fb01aff3a5d9a1b567394dbdf87ddb5bf777b', decimals: 8 },
  { pair: 'USD/ZAR', feedId: '0x389d889017db82bf42141f23b61b8de938a4e2d156e36312175bebf797f493f1', decimals: 8 },
  { pair: 'USD/CNY', feedId: '0x4a134870158ad1ea98bc4e4eb8e4ca824a32e69d4f3da380377c09936ba23954', decimals: 8 },
  { pair: 'USD/CZK', feedId: '0xffe0b5050b12dd66e892d95a0470f5f8ddedd4e64991250112db58ebf2970499', decimals: 8 },
  { pair: 'USD/DKK', feedId: '0x0df79792804744b7b799aebc0e514754de7b208cb06ae66bc16c67210fef3112', decimals: 8 },
  { pair: 'USD/HUF', feedId: '0xf2709f4b9c20bf25c08a0d751faa0d202ec74a9254ceacbd6519bd33ef5293b3', decimals: 8 },
  { pair: 'USD/NOK', feedId: '0x235ddea9f40e9af5814dbcc83a418b98e3ee8df1e34e1ae4d45cf5de596023a3', decimals: 8 },
  { pair: 'USD/RON', feedId: '0x4f59bd91914d02ee5b5dd6db1484f9dc66feb7b5e2bb2f9b96370538c9ce7b94', decimals: 8 },
  { pair: 'USD/SEK', feedId: '0x8ccb376aa871517e807358d4e3cf0bc7fe4950474dbe6c9ffc21ef64e43fc676', decimals: 8 },
  { pair: 'USD/ARS', feedId: '0x8902172deb18026d0f84cd34d6f1d30a70708b83d05495aff40938b092bec450', decimals: 8 },
  { pair: 'USD/IDR', feedId: '0x6693afcd49878bbd622e46bd805e7177932cf6ab0b1c91b135d71151b9207433', decimals: 8 },
  { pair: 'USD/KES', feedId: '0x33cc660971b0e63062d2f67b7183ba17f67b246d4a7170788649979258f7d007', decimals: 8 },
  { pair: 'USD/MYR', feedId: '0x6049eac22964b1ac2119e54c98f3caa165817d84273a121ee122fafb664a8094', decimals: 8 },
  { pair: 'USD/VND', feedId: '0x325e6af848703dacd63f82091d119a3ec8669bb9441b337e821e749f3edd5381', decimals: 8 },
  { pair: 'USD/UGX', feedId: '0x1f946ee84ce82dbbaa0fec69cdd4cb9e911076788c77c6f36d42a3491a284ce1', decimals: 8 },
  { pair: 'USD/ILS', feedId: '0x158666978da811cac711193ff8bbb6f3a19c0da582fae820d933c6b9ceec6998', decimals: 8 },
  { pair: 'USD/PHP', feedId: '0x2bda7f268b52bfbc3f2e124c31445247647350db313caadc6771e6299e0a68c9', decimals: 8 },
  { pair: 'USD/BRL', feedId: '0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906', decimals: 8 },
];

// ── Keeper bot feed IDs (18 feeds actively pushed to Pyth on-chain) ──
export const PYTH_KEEPER_FEED_IDS: string[] = [
  '0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b', // EUR/USD
  '0x84c2dde9633d93d1bcad84e7dc41c9d56578b7ec52fabedc1f335d673df0a7c1', // GBP/USD
  '0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52', // USD/JPY
  '0x67a6f93030420c1c9e3fe37c1ab6b77966af82f995944a9fefce357a22854a80', // AUD/USD
  '0x3112b03a41c910ed446852aacf67118cb1bec67b2cd0b9a214c58cc0eaa2ecca', // USD/CAD
  '0x0b1e3297e69f162877b577b0d6a47a0d63b2392bc8499e6540da4187a63e28f8', // USD/CHF
  '0x396a969a9c1480fa15ed50bc59149e2c0075a72fe8f458ed941ddec48bdb4918', // USD/SGD
  '0x19d75fde7fee50fe67753fdc825e583594eb2f51ae84e114a5246c4ab23aff4c', // USD/HKD
  '0x235ddea9f40e9af5814dbcc83a418b98e3ee8df1e34e1ae4d45cf5de596023a3', // USD/NOK
  '0x92eea8ba1b00078cdc2ef6f64f091f262e8c7d0576ee4677572f314ebfafa4c7', // NZD/USD
  '0x8ccb376aa871517e807358d4e3cf0bc7fe4950474dbe6c9ffc21ef64e43fc676', // USD/SEK
  '0xd2db4dbf1aea74e0f666b0e8f73b9580d407f5e5cf931940b06dc633d7a95906', // USD/BRL
  '0xe13b1c1ffb32f34e1be9545583f01ef385fde7f42ee66049d30570dc866b77ca', // USD/MXN
  '0x032a2eba1c2635bf973e95fb62b2c0705c1be2603b9572cc8d5edeaf8744e058', // USD/TRY
  '0x0ac0f9a2886fc2dd708bc66cc2cea359052ce89d324f45d95fadbc6c4fcf1809', // USD/INR
  '0x6693afcd49878bbd622e46bd805e7177932cf6ab0b1c91b135d71151b9207433', // USD/IDR
  '0x389d889017db82bf42141f23b61b8de938a4e2d156e36312175bebf797f493f1', // USD/ZAR
  '0x2bda7f268b52bfbc3f2e124c31445247647350db313caadc6771e6299e0a68c9', // USD/PHP
];

// ── Pyth Network contract addresses (from deployments/parameters.ts) ──
export const PYTH_CONTRACTS: Record<string, string> = {
  base: '0x8250f4aF4B972684F7b336503E2D6dFeDeB1487a',
  baseSepolia: '0xA2aa501b19aff244D90cc15a4Cf739D2725B5729',
};
