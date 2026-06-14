import { BytesLike, BigNumber, ethers } from "ethers";

import { Account } from "@utils/test/types";
import { Address } from "@utils/types";

/* -------------------------------------------------------------------------- */
/* Legacy helpers (PaymentAttestation V1)                                     */
/* -------------------------------------------------------------------------- */

export type PaymentDetails = {
  paymentMethod: BytesLike;
  providerHash: BytesLike;
  intentHash: BytesLike;
  recipientId: BytesLike;
  amount: BigNumber;
  timestamp: BigNumber;
  paymentId: BytesLike;
  currency: BytesLike;
  signatures: BytesLike[];
  dataHash: BytesLike;
};

const ZERO_BYTES = "0x";

export async function signPaymentDetails(
  signer: Account,
  paymentDetails: PaymentDetails,
  unifiedVerifierContract: Address,
  chainId: number = 31337,
): Promise<string> {
  const domain = {
    name: "UnifiedPaymentVerifier",
    version: "1",
    chainId,
    verifyingContract: unifiedVerifierContract as Address,
  };

  const types = {
    PaymentAttestation: [
      { name: "paymentMethod", type: "bytes32" },
      { name: "providerHash", type: "bytes32" },
      { name: "intentHash", type: "bytes32" },
      { name: "recipientId", type: "bytes32" },
      { name: "amount", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "paymentId", type: "bytes32" },
      { name: "currency", type: "bytes32" },
      { name: "dataHash", type: "bytes32" },
    ],
  };

  return signer.wallet._signTypedData(domain, types, {
    paymentMethod: paymentDetails.paymentMethod,
    providerHash: paymentDetails.providerHash,
    intentHash: paymentDetails.intentHash,
    recipientId: paymentDetails.recipientId,
    amount: paymentDetails.amount,
    timestamp: paymentDetails.timestamp,
    paymentId: paymentDetails.paymentId,
    currency: paymentDetails.currency,
    dataHash: paymentDetails.dataHash,
  });
}

export function encodePaymentDetails(paymentDetails: PaymentDetails): BytesLike {
  return ethers.utils.defaultAbiCoder.encode(
    ['tuple(bytes32,bytes32,bytes32,bytes32,uint256,uint256,bytes32,bytes32,bytes[],bytes32)'],
    [[
      paymentDetails.paymentMethod,
      paymentDetails.providerHash,
      paymentDetails.intentHash,
      paymentDetails.recipientId,
      paymentDetails.amount,
      paymentDetails.timestamp,
      paymentDetails.paymentId,
      paymentDetails.currency,
      paymentDetails.signatures,
      paymentDetails.dataHash,
    ]],
  );
}

export async function createAttestation(
  signer: Account,
  paymentDetails: PaymentDetails,
  unifiedVerifierContract: Address,
): Promise<BytesLike> {
  const signature = await signPaymentDetails(
    signer,
    { ...paymentDetails, signatures: [] },
    unifiedVerifierContract,
  );

  const paymentDetailsWithSignature: PaymentDetails = {
    ...paymentDetails,
    signatures: [signature],
  };

  return encodePaymentDetails(paymentDetailsWithSignature);
}

/* -------------------------------------------------------------------------- */
/* Deposit attestor helpers                                                   */
/* -------------------------------------------------------------------------- */

// keccak256("zkp2p.depositAttestors.v1"); must match MultiAttestationVerifier.DEPOSIT_ATTESTORS_TAG
export const DEPOSIT_ATTESTORS_TAG = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("zkp2p.depositAttestors.v1")
);

// Encodes additional attestors for DepositPaymentMethodData.data.
// MultiAttestationVerifier appends these to the default witness set, so either
// defaults or added attestors can satisfy the combined threshold.
export function encodeDepositAttestors(
  attestors: Address[],
  threshold: BigNumber | number
): string {
  return ethers.utils.defaultAbiCoder.encode(
    ["bytes32", "address[]", "uint256"],
    [DEPOSIT_ATTESTORS_TAG, attestors, threshold]
  );
}

/* -------------------------------------------------------------------------- */
/* New Unified Payment Verifier helpers                                       */
/* -------------------------------------------------------------------------- */

export interface UnifiedPaymentDetails {
  method: BytesLike;
  payeeId: BytesLike;
  amount: BigNumber;
  currency: BytesLike;
  timestamp: BigNumber;
  paymentId: BytesLike;
}

export interface UnifiedIntentSnapshot {
  intentHash: BytesLike;
  amount: BigNumber;
  paymentMethod: BytesLike;
  fiatCurrency: BytesLike;
  payeeDetails: BytesLike;
  conversionRate: BigNumber;
  signalTimestamp: BigNumber;
  timestampBuffer: BigNumber;
}

export interface UnifiedIntentContext {
  depositId: BigNumber;
  escrow: Address;
  to: Address;
}

export interface UnifiedPaymentAttestationParams {
  intentHash: BytesLike;
  releaseAmount: BigNumber;
  dataHash: BytesLike;
  chainId?: number;
}

export interface UnifiedPaymentAttestation extends UnifiedPaymentAttestationParams {
  signatures: string[];
  data: BytesLike;
  metadata: BytesLike;
}

export interface BuiltUnifiedPaymentProof {
  paymentProof: BytesLike;
  attestation: UnifiedPaymentAttestation;
  paymentDetails: UnifiedPaymentDetails;
  encodedPaymentDetails: BytesLike;
  intentSnapshot: UnifiedIntentSnapshot;
  intentContext: UnifiedIntentContext;
}

export interface BuildPaymentProofOverrides {
  paymentPaymentMethod?: BytesLike;
  paymentPayeeId?: BytesLike;
  paymentAmount?: BigNumber;
  paymentCurrency?: BytesLike;
  paymentTimestamp?: BigNumber;
  paymentPaymentId?: BytesLike;
  attestationIntentHash?: BytesLike;
  attestationReleaseAmount?: BigNumber;
  attestationDataHash?: BytesLike;
  attestationData?: BytesLike;
  attestationMetadata?: BytesLike;
  attestationSigner?: Account;
  attestationSigners?: Account[];
  snapshotIntentHash?: BytesLike;
  snapshotIntentAmount?: BigNumber;
  snapshotIntentPaymentMethod?: BytesLike;
  snapshotIntentFiatCurrency?: BytesLike;
  snapshotIntentPayeeDetails?: BytesLike;
  snapshotIntentConversionRate?: BigNumber;
  snapshotIntentSignalTimestamp?: BigNumber;
  snapshotIntentTimestampBuffer?: BigNumber;
  intentDepositId?: BigNumber;
  intentEscrow?: Address;
  intentTo?: Address;
}

export interface BuildPaymentProofParams extends BuildPaymentProofOverrides {
  verifier: Address;
  witness: Account;
  chainId?: number;
}

export function encodeUnifiedPaymentPayload(
  details: UnifiedPaymentDetails,
  snapshot: UnifiedIntentSnapshot
): BytesLike {
  return ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(bytes32,bytes32,uint256,bytes32,uint256,bytes32)",
      "tuple(bytes32,uint256,bytes32,bytes32,bytes32,uint256,uint256,uint256)",
    ],
    [[
      details.method,
      details.payeeId,
      details.amount,
      details.currency,
      details.timestamp,
      details.paymentId,
    ], [
      snapshot.intentHash,
      snapshot.amount,
      snapshot.paymentMethod,
      snapshot.fiatCurrency,
      snapshot.payeeDetails,
      snapshot.conversionRate,
      snapshot.signalTimestamp,
      snapshot.timestampBuffer,
    ]],
  );
}

export async function signUnifiedPaymentAttestation(
  witness: Account,
  verifier: Address,
  params: UnifiedPaymentAttestationParams,
): Promise<string> {
  const domain = {
    name: "UnifiedPaymentVerifier",
    version: "1",
    chainId: params.chainId ?? 31337,
    verifyingContract: verifier,
  };

  const types = {
    PaymentAttestation: [
      { name: "intentHash", type: "bytes32" },
      { name: "releaseAmount", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
    ],
  };

  return witness.wallet._signTypedData(domain, types, {
    intentHash: params.intentHash,
    releaseAmount: params.releaseAmount,
    dataHash: params.dataHash,
  });
}

export async function buildUnifiedPaymentProof({
  verifier,
  witness,
  chainId = 31337,
  paymentPaymentMethod,
  paymentPayeeId,
  paymentAmount,
  paymentCurrency,
  paymentTimestamp,
  paymentPaymentId,
  attestationSigner,
  attestationSigners,
  attestationIntentHash,
  attestationReleaseAmount,
  attestationDataHash,
  attestationData,
  attestationMetadata,
  snapshotIntentHash,
  snapshotIntentAmount,
  snapshotIntentPaymentMethod,
  snapshotIntentFiatCurrency,
  snapshotIntentPayeeDetails,
  snapshotIntentConversionRate,
  snapshotIntentSignalTimestamp,
  snapshotIntentTimestampBuffer,
  intentDepositId,
  intentEscrow,
  intentTo,
}: BuildPaymentProofParams): Promise<BuiltUnifiedPaymentProof> {
  const paymentDetails: UnifiedPaymentDetails = {
    method: paymentPaymentMethod ?? ethers.constants.HashZero,
    payeeId: paymentPayeeId ?? ethers.constants.HashZero,
    amount: paymentAmount ?? BigNumber.from(0),
    currency: paymentCurrency ?? ethers.constants.HashZero,
    timestamp: paymentTimestamp ?? BigNumber.from(0),
    paymentId: paymentPaymentId ?? ethers.constants.HashZero,
  };
  const snapshot: UnifiedIntentSnapshot = {
    intentHash: snapshotIntentHash ?? ethers.constants.HashZero,
    amount: snapshotIntentAmount ?? paymentDetails.amount,
    paymentMethod: snapshotIntentPaymentMethod ?? paymentDetails.method,
    fiatCurrency: snapshotIntentFiatCurrency ?? paymentDetails.currency,
    payeeDetails: snapshotIntentPayeeDetails ?? paymentDetails.payeeId,
    conversionRate: snapshotIntentConversionRate ?? BigNumber.from(0),
    signalTimestamp: snapshotIntentSignalTimestamp ?? paymentDetails.timestamp.div(1000),
    timestampBuffer: snapshotIntentTimestampBuffer ?? BigNumber.from(0),
  };

  const intentContext: UnifiedIntentContext = {
    depositId: intentDepositId ?? BigNumber.from(1),
    escrow: intentEscrow ?? ethers.constants.AddressZero,
    to: intentTo ?? ethers.constants.AddressZero,
  };

  const encodedPaymentDetails = encodeUnifiedPaymentPayload(paymentDetails, snapshot);
  const dataHash = ethers.utils.keccak256(encodedPaymentDetails);

  const attIntentHash = attestationIntentHash ?? ethers.constants.HashZero;
  const attReleaseAmount = attestationReleaseAmount ?? paymentDetails.amount;
  const attDataHash = attestationDataHash ?? dataHash;
  const attMetadata = attestationMetadata ?? ZERO_BYTES;
  const signerAccounts = attestationSigners ?? [attestationSigner ?? witness];
  const attData = attestationData ?? encodedPaymentDetails;

  const signatures = await Promise.all(
    signerAccounts.map((signerAccount) =>
      signUnifiedPaymentAttestation(signerAccount, verifier, {
        intentHash: attIntentHash,
        releaseAmount: attReleaseAmount,
        dataHash: attDataHash,
        chainId,
      })
    )
  );

  const paymentProof = ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32,uint256,bytes32,bytes[],bytes,bytes)"],
    [[attIntentHash, attReleaseAmount, attDataHash, signatures, attData, attMetadata]],
  );

  return {
    paymentProof,
    attestation: {
      intentHash: attIntentHash,
      releaseAmount: attReleaseAmount,
      dataHash: attDataHash,
      signatures,
      data: attData,
      metadata: attMetadata,
    },
    paymentDetails,
    encodedPaymentDetails,
    intentSnapshot: snapshot,
    intentContext,
  };
}
