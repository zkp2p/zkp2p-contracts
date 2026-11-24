import { BigNumber, utils } from "ethers";
import { extendProvider } from "hardhat/config";
import { ProviderWrapper } from "hardhat/plugins";
import type { EIP1193Provider, RequestArguments } from "hardhat/types";
import { DEPLOYER_SIGNER, getDeployerKms } from "./deployerKeys";
import { KmsDigestSigner, awsKmsApi } from "./kmsSigner";

const SIGNING_METHODS = ["eth_sign", "personal_sign", "eth_signTypedData", "eth_signTypedData_v4", "eth_signTransaction"];

interface RpcTransaction {
  from: string;
  to?: string;
  data?: string;
  value?: string;
  gas?: string;
  gasPrice?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  nonce?: string;
  chainId?: string;
}

const lower = (value: string): string => value.toLowerCase();

function quantity(value: unknown, field: string): BigNumber {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]+$/.test(value)) throw new Error(`${field}: expected a hex quantity`);
  return BigNumber.from(value);
}

function rpcTransaction(value: unknown): RpcTransaction {
  if (typeof value !== "object" || value === null) throw new Error("eth_sendTransaction: missing transaction");
  const fields = new Map(Object.entries(value));
  const text = (name: string): string | undefined => {
    const field = fields.get(name);
    if (field === undefined || field === null) return undefined;
    if (typeof field !== "string") throw new Error(`eth_sendTransaction: ${name} must be a string`);
    return field;
  };
  const from = text("from");
  if (!from || !utils.isAddress(from)) throw new Error("eth_sendTransaction: invalid from");
  return {
    from, to: text("to"), data: text("data") ?? text("input"), value: text("value"), gas: text("gas"),
    gasPrice: text("gasPrice"), maxFeePerGas: text("maxFeePerGas"), maxPriorityFeePerGas: text("maxPriorityFeePerGas"),
    nonce: text("nonce"), chainId: text("chainId"),
  };
}

/**
 * EIP-1193 provider that signs the deployer's transactions with KMS, the way Hardhat's own local-accounts provider
 * signs with a raw key. hardhat-deploy and hardhat-ethers send through `eth_sendTransaction`, so every lane picks it
 * up unchanged. The KMS address is listed first in `eth_accounts`; other senders pass through to the node.
 */
export class KmsSigningProvider extends ProviderWrapper {
  constructor(provider: EIP1193Provider, private readonly signer: KmsDigestSigner) {
    super(provider);
  }

  async request(args: RequestArguments): Promise<unknown> {
    const params = Array.isArray(args.params) ? args.params : [];
    if (args.method === "eth_accounts" || args.method === "eth_requestAccounts") {
      const accounts = await this._wrappedProvider.request(args);
      const others = Array.isArray(accounts)
        ? accounts.filter((account): account is string => typeof account === "string" && lower(account) !== lower(this.signer.address))
        : [];
      return [this.signer.address, ...others];
    }
    if (args.method === "eth_sendTransaction") {
      const transaction = rpcTransaction(params[0]);
      if (lower(transaction.from) === lower(this.signer.address)) return this.sendSigned(transaction);
      return this._wrappedProvider.request(args);
    }
    if (SIGNING_METHODS.includes(args.method) &&
      params.some((param) => typeof param === "string" && lower(param) === lower(this.signer.address))) {
      throw new Error(`${args.method} is not supported for the KMS deployer ${this.signer.address}`);
    }
    return this._wrappedProvider.request(args);
  }

  private async rpc(method: string, params: unknown[] = []): Promise<unknown> {
    return this._wrappedProvider.request({ method, params });
  }

  /** Fills nonce, gas, fees and chain id the way Hardhat would, signs the digest with KMS and sends it raw. */
  private async sendSigned(transaction: RpcTransaction): Promise<unknown> {
    const chainId = quantity(await this.rpc("eth_chainId"), "eth_chainId").toNumber();
    if (transaction.chainId !== undefined && quantity(transaction.chainId, "chainId").toNumber() !== chainId) {
      throw new Error(`transaction chainId ${transaction.chainId} differs from the node's ${chainId}`);
    }
    const nonce = transaction.nonce !== undefined ? quantity(transaction.nonce, "nonce")
      : quantity(await this.rpc("eth_getTransactionCount", [this.signer.address, "pending"]), "eth_getTransactionCount");
    const gasLimit = transaction.gas !== undefined ? quantity(transaction.gas, "gas")
      : quantity(await this.rpc("eth_estimateGas", [{
        from: this.signer.address, to: transaction.to, data: transaction.data, value: transaction.value,
      }]), "eth_estimateGas");
    const base: utils.UnsignedTransaction = {
      chainId, nonce: nonce.toNumber(), gasLimit, to: transaction.to, data: transaction.data ?? "0x",
      value: transaction.value !== undefined ? quantity(transaction.value, "value") : BigNumber.from(0),
    };
    const unsigned = transaction.gasPrice !== undefined
      ? { ...base, type: 0, gasPrice: quantity(transaction.gasPrice, "gasPrice") }
      : { ...base, type: 2, ...await this.eip1559Fees(transaction) };
    const digest = utils.keccak256(utils.serializeTransaction(unsigned));
    const raw = utils.serializeTransaction(unsigned, await this.signer.signDigest(digest));
    return this.rpc("eth_sendRawTransaction", [raw]);
  }

  private async eip1559Fees(transaction: RpcTransaction): Promise<{ maxFeePerGas: BigNumber; maxPriorityFeePerGas: BigNumber }> {
    const maxPriorityFeePerGas = transaction.maxPriorityFeePerGas !== undefined
      ? quantity(transaction.maxPriorityFeePerGas, "maxPriorityFeePerGas")
      : quantity(await this.rpc("eth_maxPriorityFeePerGas"), "eth_maxPriorityFeePerGas");
    if (transaction.maxFeePerGas !== undefined) {
      return { maxFeePerGas: quantity(transaction.maxFeePerGas, "maxFeePerGas"), maxPriorityFeePerGas };
    }
    const block: unknown = await this.rpc("eth_getBlockByNumber", ["latest", false]);
    const baseFee = typeof block === "object" && block !== null ? new Map(Object.entries(block)).get("baseFeePerGas") : undefined;
    return { maxFeePerGas: quantity(baseFee, "baseFeePerGas").mul(2).add(maxPriorityFeePerGas), maxPriorityFeePerGas };
  }
}

/**
 * Registers KMS signing for `base` and `base_staging` when their KMS key id is configured. The provider is built
 * lazily, when a task first uses that network, and refuses any key that does not derive the deployer address.
 */
export function installDeployerKmsSigning(env: Record<string, string | undefined>): void {
  const keys = getDeployerKms(env);
  extendProvider(async (provider, _config, network) => {
    const keyId = network === "base" ? keys.base : network === "base_staging" ? keys.base_staging : undefined;
    if (keyId === undefined) return provider;
    return new KmsSigningProvider(provider, await KmsDigestSigner.create(awsKmsApi(keyId), keyId, DEPLOYER_SIGNER));
  });
}
