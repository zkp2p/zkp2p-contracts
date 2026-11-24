import { BigNumber, utils } from "ethers";
import {
  KMS_SECP256K1_KEY_SPEC, KmsApi, KmsMessageType, KmsPublicKey, KmsSignRequest, KmsSigningAlgorithm,
} from "../../utils/kmsSigner";

const SPKI_SECP256K1_PREFIX = "0x3056301006072a8648ce3d020106052b8104000a034200";
const SECP256K1_ORDER = BigNumber.from("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");

export interface FakeKmsOptions {
  keyId: string;
  /** Return the high-s twin of every signature, as real KMS does about half the time. */
  highS?: boolean;
  onSign?: (request: KmsSignRequest) => void;
}

function derInteger(value: BigNumber): string {
  let digits = utils.arrayify(value.toHexString());
  if (digits[0] & 0x80) digits = utils.concat(["0x00", digits]);
  return utils.hexlify(utils.concat(["0x02", utils.hexlify([digits.length]), digits]));
}

export function derSignature(r: BigNumber, s: BigNumber): Uint8Array {
  const body = utils.concat([derInteger(r), derInteger(s)]);
  return utils.concat(["0x30", utils.hexlify([body.length]), body]);
}

/**
 * Test double for AWS KMS backed by a local secp256k1 key. It enforces the deployer key policy (DIGEST messages,
 * ECDSA_SHA_256, 32-byte digests, the one key id) and answers in KMS's DER formats.
 */
export class FakeKms implements KmsApi {
  readonly address: string;
  private readonly signingKey: utils.SigningKey;

  constructor(privateKey: string, private readonly options: FakeKmsOptions) {
    this.signingKey = new utils.SigningKey(privateKey);
    this.address = utils.computeAddress(this.signingKey.publicKey);
  }

  async getPublicKey(keyId: string): Promise<KmsPublicKey> {
    if (keyId !== this.options.keyId) throw new Error(`NotFoundException: ${keyId}`);
    return {
      publicKey: utils.arrayify(utils.concat([SPKI_SECP256K1_PREFIX, this.signingKey.publicKey])),
      keySpec: KMS_SECP256K1_KEY_SPEC, signingAlgorithms: [KmsSigningAlgorithm.EcdsaSha256],
    };
  }

  async sign(request: KmsSignRequest): Promise<Uint8Array> {
    if (request.keyId !== this.options.keyId) throw new Error(`NotFoundException: ${request.keyId}`);
    if (request.messageType !== KmsMessageType.Digest || request.signingAlgorithm !== KmsSigningAlgorithm.EcdsaSha256) {
      throw new Error("AccessDeniedException: kms:MessageType must be DIGEST and kms:SigningAlgorithm ECDSA_SHA_256");
    }
    if (request.digest.length !== 32) throw new Error("ValidationException: a DIGEST message is 32 bytes");
    this.options.onSign?.(request);
    const signature = this.signingKey.signDigest(request.digest);
    const s = BigNumber.from(signature.s);
    return derSignature(BigNumber.from(signature.r), this.options.highS ? SECP256K1_ORDER.sub(s) : s);
  }
}
