// Static oracle feed data — Chainlink or ZKP2P-operated AggregatorV3 feeds on Base
// used by the protocol. Manually maintained; sourced from arm-dashboard/src/constants.ts
// and deployments/parameters.ts.
//
// NOTE: Pyth oracle feeds have been removed (2026-03-17). Pyth Hermes is being
// deprecated and new FX feeds are Lazer-only (paid, API key required). We ship
// with Chainlink-only for the ARM launch. Pyth/Lazer can be re-added later.

export enum OracleFeedProvider {
  Chainlink = "chainlink",
  Zkp2p = "zkp2p",
}

export interface ChainlinkFeed {
  pair: string;
  feed: string;
  decimals: number;
  provider: OracleFeedProvider;
}

// ── Chainlink FX proxy addresses on Base mainnet ──────────────────────
// Verified on-chain via description() calls
export const CHAINLINK_FEEDS: ChainlinkFeed[] = [
  { pair: 'AUD/USD', feed: '0x46e51B8cA41d709928EdA9Ae43e42193E6CDf229', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'BRL/USD', feed: '0x0b0E64c05083FdF9ED7C5D3d8262c4216eFc9394', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'CAD/USD', feed: '0xA840145F87572E82519d578b1F36340368a25D5d', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'CHF/USD', feed: '0x3A1d6444fb6a402470098E23DaD0B7E86E14252F', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'EUR/USD', feed: '0xc91D87E81faB8f93699ECf7Ee9B44D11e1D53F0F', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'GBP/USD', feed: '0xCceA6576904C118037695eB71195a5425E69Fa15', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'IDR/USD', feed: '0x05A6cF213EcC5501A11a08EBefA4A8a60313ef97', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'MXN/USD', feed: '0x9e8Ee77c76d4fa41306056D1C3196AF5da1600bd', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'NGN/USD', feed: '0xdfbb5Cbc88E382de007bfe6CE99C388176ED80aD', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'NZD/USD', feed: '0x06bdFe07E71C476157FC025d3cCD4BBe08e83EF9', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'PHP/USD', feed: '0x0396000dc82bfAEe746A9Ac6dC69dAd3223Ca9c6', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'SGD/USD', feed: '0x81575495532fB311Efc5C993B612564274F0949b', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'TRY/USD', feed: '0x29413773e7CD4Dfd6Ad89a50887877b88a6C592C', decimals: 8, provider: OracleFeedProvider.Chainlink },
  { pair: 'ZAR/USD', feed: '0x2ecc8A8B370fC6a217166b2782a35339bEBEe98B', decimals: 8, provider: OracleFeedProvider.Chainlink },
];
