import { constants, providers } from "ethers";

export function canonicalReceiptResponse(method: string, response: unknown): unknown {
  // Base Flashblocks can return execution results before a block hash exists.
  // Keep those receipts pending so the transaction journal cannot confirm them.
  if (method === "eth_getTransactionReceipt" && typeof response === "object" && response !== null &&
      "blockHash" in response && response.blockHash === constants.HashZero) return null;
  return response;
}

export class CanonicalJsonRpcProvider extends providers.JsonRpcProvider {
  async send(method: string, params: unknown[]): Promise<unknown> {
    return canonicalReceiptResponse(method, await super.send(method, params));
  }
}
