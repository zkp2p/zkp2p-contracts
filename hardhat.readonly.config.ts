import config from "./hardhat.config";

if (!config.networks) throw new Error("Canonical Hardhat networks are unavailable");

// Read-only release verification needs RPC access, never accounts from other networks.
export default {
  ...config,
  networks: Object.fromEntries(Object.entries(config.networks).map(([name, network]) => [name, { ...network, accounts: [] }])),
};
