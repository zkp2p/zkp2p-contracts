import { BigNumber, Signer, providers, utils } from "ethers";
import type { Bytes, Signature } from "ethers";
import type { Deferrable } from "ethers/lib/utils";
import { RETIRED_DEPLOYERS } from "./deployerKeys";

export enum KmsMessageType {
  Digest = "DIGEST",
}

export enum KmsSigningAlgorithm {
  EcdsaSha256 = "ECDSA_SHA_256",
}

export const KMS_SECP256K1_KEY_SPEC = "ECC_SECG_P256K1";

export interface KmsPublicKey {
  publicKey: Uint8Array;
  keySpec?: string;
  signingAlgorithms?: string[];
}

export interface KmsSignRequest {
  keyId: string;
  digest: Uint8Array;
  messageType: KmsMessageType;
  signingAlgorithm: KmsSigningAlgorithm;
}

/** The two KMS operations the deployer needs; AWS implements them, and tests substitute a local key. */
export interface KmsApi {
  getPublicKey(keyId: string): Promise<KmsPublicKey>;
  sign(request: KmsSignRequest): Promise<Uint8Array>;
}

const SECP256K1_ORDER = BigNumber.from("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
const HALF_ORDER = SECP256K1_ORDER.shr(1);
const OID_EC_PUBLIC_KEY = "2a8648ce3d0201";
const OID_SECP256K1 = "2b8104000a";

enum Asn1Tag {
  Integer = 0x02,
  BitString = 0x03,
  ObjectIdentifier = 0x06,
  Sequence = 0x30,
}

interface Asn1Element {
  tag: number;
  value: Uint8Array;
  end: number;
}

function readElement(bytes: Uint8Array, offset: number, expected: Asn1Tag, label: string): Asn1Element {
  if (offset + 2 > bytes.length || bytes[offset] !== expected) throw new Error(`${label}: expected ASN.1 tag ${expected}`);
  let length = bytes[offset + 1];
  let start = offset + 2;
  if (length & 0x80) {
    const lengthBytes = length & 0x7f;
    if (lengthBytes === 0 || lengthBytes > 2 || start + lengthBytes > bytes.length) throw new Error(`${label}: bad ASN.1 length`);
    length = 0;
    for (let index = 0; index < lengthBytes; index++) length = (length << 8) | bytes[start + index];
    start += lengthBytes;
  }
  const end = start + length;
  if (end > bytes.length) throw new Error(`${label}: truncated ASN.1 element`);
  return { tag: expected, value: bytes.subarray(start, end), end };
}

/** Uncompressed secp256k1 point from a DER SubjectPublicKeyInfo, as KMS GetPublicKey returns it. */
export function publicKeyFromSpki(spki: Uint8Array): string {
  const outer = readElement(spki, 0, Asn1Tag.Sequence, "SubjectPublicKeyInfo");
  if (outer.end !== spki.length) throw new Error("SubjectPublicKeyInfo: trailing bytes");
  const algorithm = readElement(outer.value, 0, Asn1Tag.Sequence, "AlgorithmIdentifier");
  const keyType = readElement(algorithm.value, 0, Asn1Tag.ObjectIdentifier, "algorithm OID");
  const curve = readElement(algorithm.value, keyType.end, Asn1Tag.ObjectIdentifier, "curve OID");
  if (utils.hexlify(keyType.value).slice(2) !== OID_EC_PUBLIC_KEY) throw new Error("public key is not an EC key");
  if (utils.hexlify(curve.value).slice(2) !== OID_SECP256K1) throw new Error("public key is not on secp256k1");
  const bitString = readElement(outer.value, algorithm.end, Asn1Tag.BitString, "subjectPublicKey");
  if (bitString.end !== outer.value.length) throw new Error("SubjectPublicKeyInfo: trailing fields");
  if (bitString.value.length !== 66 || bitString.value[0] !== 0 || bitString.value[1] !== 0x04) {
    throw new Error("subjectPublicKey is not an uncompressed point");
  }
  return utils.hexlify(bitString.value.subarray(1));
}

function readScalar(bytes: Uint8Array, offset: number, label: string): { value: BigNumber; end: number } {
  const element = readElement(bytes, offset, Asn1Tag.Integer, label);
  const digits = element.value;
  if (digits.length === 0 || (digits[0] & 0x80) !== 0) throw new Error(`${label}: not a positive integer`);
  if (digits.length > 1 && digits[0] === 0 && (digits[1] & 0x80) === 0) throw new Error(`${label}: non-minimal encoding`);
  if (digits.length - (digits[0] === 0 ? 1 : 0) > 32) throw new Error(`${label}: longer than 32 bytes`);
  const value = BigNumber.from(utils.hexlify(digits));
  if (value.isZero() || value.gte(SECP256K1_ORDER)) throw new Error(`${label}: out of range`);
  return { value, end: element.end };
}

/** DER ECDSA signature to (r, s), with s normalised to the lower half of the curve order as Ethereum requires. */
export function parseDerSignature(der: Uint8Array): { r: string; s: string } {
  const sequence = readElement(der, 0, Asn1Tag.Sequence, "ECDSA signature");
  if (sequence.end !== der.length) throw new Error("ECDSA signature: trailing bytes");
  const r = readScalar(sequence.value, 0, "signature r");
  const s = readScalar(sequence.value, r.end, "signature s");
  if (s.end !== sequence.value.length) throw new Error("ECDSA signature: trailing fields");
  const lowS = s.value.gt(HALF_ORDER) ? SECP256K1_ORDER.sub(s.value) : s.value;
  return { r: utils.hexZeroPad(r.value.toHexString(), 32), s: utils.hexZeroPad(lowS.toHexString(), 32) };
}

/**
 * Signs 32-byte digests with a KMS secp256k1 key. It only exists for a key whose derived address is the expected
 * deployer and not a retired one, and every signature it returns recovers to that address.
 */
export class KmsDigestSigner {
  private constructor(
    private readonly api: KmsApi,
    private readonly keyId: string,
    public readonly address: string,
  ) {}

  static async create(
    api: KmsApi, keyId: string, expectedAddress: string, retired: readonly string[] = RETIRED_DEPLOYERS,
  ): Promise<KmsDigestSigner> {
    const key = await api.getPublicKey(keyId);
    if (key.keySpec !== undefined && key.keySpec !== KMS_SECP256K1_KEY_SPEC) {
      throw new Error(`KMS key ${keyId} is ${key.keySpec}, not ${KMS_SECP256K1_KEY_SPEC}`);
    }
    if (key.signingAlgorithms !== undefined && !key.signingAlgorithms.includes(KmsSigningAlgorithm.EcdsaSha256)) {
      throw new Error(`KMS key ${keyId} does not allow ${KmsSigningAlgorithm.EcdsaSha256}`);
    }
    const address = utils.computeAddress(publicKeyFromSpki(key.publicKey));
    if (retired.some((candidate) => candidate.toLowerCase() === address.toLowerCase())) {
      throw new Error(`KMS key ${keyId} derives retired signer ${address}`);
    }
    if (address.toLowerCase() !== expectedAddress.toLowerCase()) {
      throw new Error(`KMS key ${keyId} derives ${address}, not the expected signer ${utils.getAddress(expectedAddress)}`);
    }
    return new KmsDigestSigner(api, keyId, address);
  }

  async signDigest(digest: utils.BytesLike): Promise<Signature> {
    const bytes = utils.arrayify(digest);
    if (bytes.length !== 32) throw new Error("KMS signs 32-byte digests only");
    const { r, s } = parseDerSignature(await this.api.sign({
      keyId: this.keyId, digest: bytes, messageType: KmsMessageType.Digest, signingAlgorithm: KmsSigningAlgorithm.EcdsaSha256,
    }));
    for (const recoveryParam of [0, 1]) {
      const signature = utils.splitSignature({ r, s, recoveryParam });
      if (utils.recoverAddress(bytes, signature).toLowerCase() === this.address.toLowerCase()) return signature;
    }
    throw new Error(`KMS signature from ${this.keyId} does not recover to ${this.address}`);
  }
}

/** ethers Signer over a KMS key, for scripts that send transactions without Hardhat. */
export class KmsSigner extends Signer {
  constructor(private readonly kms: KmsDigestSigner, readonly provider?: providers.Provider) {
    super();
  }

  async getAddress(): Promise<string> {
    return this.kms.address;
  }

  async signMessage(message: Bytes | string): Promise<string> {
    return utils.joinSignature(await this.kms.signDigest(utils.hashMessage(message)));
  }

  async signTransaction(transaction: Deferrable<providers.TransactionRequest>): Promise<string> {
    const resolved = await utils.resolveProperties(transaction);
    if (resolved.from !== undefined && resolved.from.toLowerCase() !== this.kms.address.toLowerCase()) {
      throw new Error(`transaction from ${resolved.from} cannot be signed by ${this.kms.address}`);
    }
    const { from: _from, ...unsigned } = resolved;
    const unsignedTransaction: utils.UnsignedTransaction = {
      ...unsigned, nonce: unsigned.nonce === undefined ? undefined : BigNumber.from(unsigned.nonce).toNumber(),
    };
    const digest = utils.keccak256(utils.serializeTransaction(unsignedTransaction));
    return utils.serializeTransaction(unsignedTransaction, await this.kms.signDigest(digest));
  }

  connect(provider: providers.Provider): KmsSigner {
    return new KmsSigner(this.kms, provider);
  }
}

/** AWS KMS through the standard credential chain (AWS_PROFILE, SSO, ...); a key ARN also fixes the region. */
export function awsKmsApi(keyId: string): KmsApi {
  // Loaded lazily so configurations without KMS never load the AWS SDK. require() is untyped; the cast restores the
  // SDK's own declarations.
  const { KMSClient, GetPublicKeyCommand, SignCommand, MessageType, SigningAlgorithmSpec } =
    require("@aws-sdk/client-kms") as typeof import("@aws-sdk/client-kms");
  const region = keyId.match(/^arn:aws[\w-]*:kms:([a-z0-9-]+):/)?.[1];
  const client = new KMSClient(region ? { region } : {});
  return {
    async getPublicKey(id) {
      const output = await client.send(new GetPublicKeyCommand({ KeyId: id }));
      if (!output.PublicKey) throw new Error(`KMS returned no public key for ${id}`);
      return { publicKey: output.PublicKey, keySpec: output.KeySpec, signingAlgorithms: output.SigningAlgorithms };
    },
    async sign({ keyId: id, digest, messageType, signingAlgorithm }) {
      if (messageType !== KmsMessageType.Digest || signingAlgorithm !== KmsSigningAlgorithm.EcdsaSha256) {
        throw new Error("the deployer key may only sign DIGEST messages with ECDSA_SHA_256");
      }
      const output = await client.send(new SignCommand({
        KeyId: id, Message: digest, MessageType: MessageType.DIGEST, SigningAlgorithm: SigningAlgorithmSpec.ECDSA_SHA_256,
      }));
      if (!output.Signature) throw new Error(`KMS returned no signature for ${id}`);
      return output.Signature;
    },
  };
}
