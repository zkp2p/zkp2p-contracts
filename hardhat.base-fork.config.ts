import config from "./hardhat.canonical.config";

// Keep canonical receipts, cleared remote accounts and local fixture accounts.
// The operator enables the fork only through hardhat_reset.
export default {
  ...config,
  networks: { ...config.networks, hardhat: { ...config.networks.hardhat, chainId: 8453 } },
};
