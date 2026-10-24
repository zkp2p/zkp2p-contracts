import { extendProvider } from "hardhat/config";
import { ProviderWrapper } from "hardhat/plugins";
import type { RequestArguments } from "hardhat/types";
import config from "./hardhat.config";
import { canonicalReceiptResponse } from "./scripts/canonical-receipts";

extendProvider(async (provider) => new class extends ProviderWrapper {
  async request(args: RequestArguments): Promise<unknown> {
    return canonicalReceiptResponse(args.method, await this._wrappedProvider.request(args));
  }
}(provider));

if (!config.networks) throw new Error("Canonical Hardhat networks are unavailable");

// The release runner constructs its explicit Wallet; remote network accounts are unused.
// Preserve Hardhat's local fixture accounts for deployment rehearsals.
export default {
  ...config,
  networks: Object.fromEntries(Object.entries(config.networks).map(([name, network]) =>
    [name, name === "hardhat" ? network : { ...network, accounts: [] }])),
};
