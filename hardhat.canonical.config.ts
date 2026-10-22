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

export default config;
