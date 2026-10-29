import * as assert from "node:assert/strict";
import { constants, utils } from "ethers";
import { Manifest, NEW_CONTRACTS, validateConfig } from "../scripts/deploy-orchestrator-v4";
import { BASE_SAFE, MULTI_SEND_CALL_ONLY, buildSafeTransaction, safeTransactionHash, SafeTransaction } from "../scripts/proposeSafeBatchChunks";
import { UPV4_BASE_RELEASE } from "./parameters";
import { Upv4SafeBatch, serializeUpv4SafeBatch, serializeUpv4SafeBatchSidecar, upv4SafeBatchSidecar } from "./upv4BaseCutover";

export enum O4SafeBatchKind { Activation = "activation", Rollback = "rollback" }
export enum O4SafeContract {
  StakeVaultV2 = "StakeVaultV2",
  DisputeProtectionPolicyV2 = "DisputeProtectionPolicyV2",
  DisputeNullifierRegistry = "DisputeNullifierRegistry",
  PaymentVerifierRegistry = "PaymentVerifierRegistry",
  OrchestratorRegistry = "OrchestratorRegistry",
  OrchestratorV4 = "OrchestratorV4",
}
export enum O4SafeFunction {
  AcceptOwnership = "acceptOwnership()",
  AddWriter = "addWritePermission(address)",
  RemoveMethod = "removePaymentMethod(bytes32)",
  AddMethod = "addPaymentMethod(bytes32,address,bytes32[])",
  RegisterOrchestrator = "addOrchestrator(address)",
  PauseOrchestrator = "pauseOrchestrator()",
}
export interface O4SafeCall {
  step: string;
  to: string;
  contract: O4SafeContract;
  function: O4SafeFunction;
  args: unknown[];
}
export type O4SafeBatch = Upv4SafeBatch;
export interface O4DecodedRow extends O4SafeCall { index: number }
export interface O4SafeTransactionCandidate {
  kind: O4SafeBatchKind;
  safeTx: SafeTransaction;
  safeTxHash: string;
}
export const O4_SAFE_BATCH_FILES: Record<O4SafeBatchKind, string> = {
  [O4SafeBatchKind.Activation]: "base_o4_activation.json",
  [O4SafeBatchKind.Rollback]: "base_o4_rollback.json",
};
export const O4_MULTI_SEND_CANDIDATES = [MULTI_SEND_CALL_ONLY, UPV4_BASE_RELEASE.signedCutover.multiSendCallOnly] as const;
/** Executed Base deployment, cross-checked against the manifest and deployments/base records. */
export const O4_BASE_DEPLOYMENT = {
  sourceCommit: "526f81d2ea53f2045b821931b21f7b7e8f15a2c4",
  configurationHash: "9b3e56c1cd04a2cc6bf4c74119589d2237e96da51264c0b66340f1ef69194512",
  signer: "0x41123d6419C7b8e44157f6F3b0088442116641eC",
  contracts: {
    StakeVaultV2: {
      address: "0x4aDE08EC1098D0d8856dd7bbBBc7789794089A97",
      transactionHash: "0x3ef9b7c533a910a1907dd9176a0d802dff36faff2a008e87e5e5ce9aa0e2ea22",
      nonce: 133,
    },
    AddressGroupRegistryV4: {
      address: "0xDcafc54E4fb47B1d41ADD08dd82142a30ec4706E",
      transactionHash: "0xc7a433db5f92b1f8c7c568d41037c67fe043a49f94839973556ea030e63910a2",
      nonce: 134,
    },
    WhitelistPolicyV2: {
      address: "0xF7069D157D1AFb2CbE117e24f4262aE51eeD390c",
      transactionHash: "0xdfa2da0d92ce5aea2fbeb0e2017917182b7921a2a12d8bc54263e4ee9954839f",
      nonce: 135,
    },
    IntentSignalPolicy: {
      address: "0x572f1Eb9043a7217C998221D6d3BCfb3D69338cC",
      transactionHash: "0x93ca8f6fef74e1714dbfffabade4fa51c1f4444ada9fcc93e5da89b3883ef994",
      nonce: 136,
    },
    DisputeProtectionPolicyV2: {
      address: "0xB49Fa38C6Bb3C8C51ddb13711BB213cDD9DB1799",
      transactionHash: "0xac51f76ee8d52e151228213cdabd91c7d5a40586ca6e2c610fb662dab0ef6283",
      nonce: 137,
    },
    OrchestratorV4: {
      address: "0x74c55679268FAfB493864915aD16A320AB8c40Ba",
      transactionHash: "0x8069432548917838a2ec33d55a001c4f16a38f6a457beb3183cb4a7694410393",
      nonce: 139,
    },
    ProtocolViewerV4: {
      address: "0x685123dB5fE2b88D00ED3764c088d600D9B2b6Fc",
      transactionHash: "0xb26b8f4ed08c3046518a957ed36dd7c3edd61666fd9aa4ce89f6b6488da8d0f5",
      nonce: 142,
    },
  },
} as const;
const NAMES: Record<O4SafeBatchKind, string> = {
  [O4SafeBatchKind.Activation]: "Base O4 activation",
  [O4SafeBatchKind.Rollback]: "Base O4 pause rollback",
};
const ABI = new utils.Interface(Object.values(O4SafeFunction).map((signature) => `function ${signature}`));
const address = (value: string): string => {
  assert.ok(utils.isAddress(value) && value.toLowerCase() !== constants.AddressZero, "Invalid or zero address");
  return utils.getAddress(value);
};

function validateManifest(m: Manifest): void {
  assert.ok(m && m.version === 1, "Invalid manifest");
  validateConfig(m.configuration);
  const c = m.configuration;
  assert.equal(c.environment, "base", "Expected Base manifest");
  assert.equal(c.chainId, 8453, "Expected Base chainId");
  assert.equal(address(c.governance), BASE_SAFE, "Expected Base Safe");
  assert.ok(m.verification && m.verification.active !== true, "Manifest is already active");
  const prepared = m.governancePreparedAt;
  assert.ok(prepared, "Missing governancePreparedAt");
  assert.ok(Number.isSafeInteger(prepared.blockNumber) && prepared.blockNumber > 0 && /^0x[\da-f]{64}$/i.test(prepared.blockHash), "Invalid prepared block");
  assert.ok(Number.isSafeInteger(prepared.timestamp) && prepared.timestamp > 0 && Number.isSafeInteger(prepared.timestamp * 1000), "Invalid prepared timestamp");
  assert.match(m.sourceCommit, /^[\da-f]{40}$/i, "Invalid source commit");
  assert.equal(address(c.existing.UnifiedPaymentVerifierV4.address), UPV4_BASE_RELEASE.unifiedPaymentVerifierV4, "Adopted UPV4 pin mismatch");
  for (const name of Object.keys(NEW_CONTRACTS) as Array<keyof typeof NEW_CONTRACTS>) {
    if (name === "UnifiedPaymentVerifierV4") continue;
    const record = m.contracts?.[name];
    assert.ok(record, `Missing deployed ${name}`);
    address(record.address);
    assert.equal(record.artifact, NEW_CONTRACTS[name], `${name} artifact mismatch`);
    assert.ok(Array.isArray(record.constructorArguments) && /^0x[\da-f]{64}$/i.test(record.transactionHash) &&
      /^0x[\da-f]{64}$/i.test(record.runtimeCodeHash) && Number.isSafeInteger(record.deploymentBlock) && record.deploymentBlock > 0, `${name} provenance missing`);
  }
  assert.ok(Array.isArray(m.governanceTransactions), "Missing governanceTransactions");
}

export function encodeO4SafeCall(call: O4SafeCall): { to: string; value: "0"; data: string } {
  return { to: call.to, value: "0", data: ABI.encodeFunctionData(call.function, call.args) };
}

/** Re-derive the entire sequence; no step can supply its own target, selector or arguments. */
export function buildO4SafeCalls(kind: O4SafeBatchKind, m: Manifest): O4SafeCall[] {
  validateManifest(m);
  assert.ok(Object.values(O4SafeBatchKind).includes(kind), "Unknown O4 batch kind");
  const c = m.configuration;
  const fresh = (name: keyof typeof NEW_CONTRACTS): string => address(m.contracts[name]!.address);
  const existing = (name: string): string => address(c.existing[name].address);
  const call = (step: string, to: string, contract: O4SafeContract, fn: O4SafeFunction, args: unknown[]): O4SafeCall => ({ step, to, contract, function: fn, args });
  if (kind === O4SafeBatchKind.Rollback) return [call("pause-orchestrator", fresh("OrchestratorV4"), O4SafeContract.OrchestratorV4, O4SafeFunction.PauseOrchestrator, [])];
  const calls = [
    call("accept:StakeVaultV2", fresh("StakeVaultV2"), O4SafeContract.StakeVaultV2, O4SafeFunction.AcceptOwnership, []),
    call("accept:DisputeProtectionPolicyV2", fresh("DisputeProtectionPolicyV2"), O4SafeContract.DisputeProtectionPolicyV2, O4SafeFunction.AcceptOwnership, []),
    call("authorize-policy-writer", existing("DisputeNullifierRegistry"), O4SafeContract.DisputeNullifierRegistry, O4SafeFunction.AddWriter, [fresh("DisputeProtectionPolicyV2")]),
  ];
  if (m.governanceTransactions.some(({ step }) => typeof step === "string" && /^(remove|add)-route:/.test(step))) {
    for (const { method } of [...c.paymentMethods].reverse()) calls.push(call(`remove-route:${method}`, existing("PaymentVerifierRegistry"), O4SafeContract.PaymentVerifierRegistry, O4SafeFunction.RemoveMethod, [method]));
    for (const { method, currencies } of c.paymentMethods) calls.push(call(`add-route:${method}`, existing("PaymentVerifierRegistry"), O4SafeContract.PaymentVerifierRegistry, O4SafeFunction.AddMethod, [method, existing("UnifiedPaymentVerifierV4"), [...currencies]]));
  }
  calls.push(call("register-orchestrator", existing("OrchestratorRegistry"), O4SafeContract.OrchestratorRegistry, O4SafeFunction.RegisterOrchestrator, [fresh("OrchestratorV4")]));
  assert.equal(m.governanceTransactions.length, calls.length, "Governance call count mismatch");
  for (const [index, expected] of calls.entries()) {
    const tx = m.governanceTransactions[index], encoded = encodeO4SafeCall(expected);
    assert.equal(tx.step, expected.step, `Governance step/order mismatch at ${index}`);
    assert.equal(tx.value, "0", `Governance value mismatch at ${index}`);
    assert.equal(address(tx.to), encoded.to, `Governance target mismatch at ${index}`);
    assert.equal(tx.data, encoded.data, `Governance calldata mismatch at ${index}`);
  }
  return calls;
}

export function renderO4SafeBatch(kind: O4SafeBatchKind, m: Manifest): O4SafeBatch {
  const calls = buildO4SafeCalls(kind, m), prepared = m.governancePreparedAt!;
  return {
    version: "1.0", chainId: "8453", createdAt: prepared.timestamp * 1000,
    meta: {
      name: NAMES[kind],
      description: `${calls.length} ${calls.length === 1 ? "call" : "calls"}. O4 ${m.contracts.OrchestratorV4!.address}; ` +
        `DPPV2 ${m.contracts.DisputeProtectionPolicyV2!.address}; StakeVaultV2 ${m.contracts.StakeVaultV2!.address}. ` +
        `Source ${m.sourceCommit}. Prepared block ${prepared.blockNumber} (${prepared.blockHash}). ` +
        (kind === O4SafeBatchKind.Rollback ? "Pauses O4 only. " : "") +
        "O3 stays registered and the UPV3 writer is NOT revoked.",
      txBuilderVersion: "1.16.5", createdFromSafeAddress: BASE_SAFE, createdFromOwnerAddress: "",
    },
    transactions: calls.map((call) => ({ ...encodeO4SafeCall(call), contractMethod: null, contractInputsValues: null })),
  };
}

export const serializeO4SafeBatch = serializeUpv4SafeBatch;
export const o4SafeBatchSidecar = upv4SafeBatchSidecar;
export const serializeO4SafeBatchSidecar = serializeUpv4SafeBatchSidecar;

export function decodeO4SafeBatch(batch: O4SafeBatch, m: Manifest): O4DecodedRow[] {
  const kind = Object.values(O4SafeBatchKind).find((candidate) => NAMES[candidate] === batch.meta?.name);
  assert.ok(kind, "Unknown O4 batch name");
  assert.deepEqual(batch, renderO4SafeBatch(kind, m), "O4 batch differs from manifest");
  return buildO4SafeCalls(kind, m).map((call, index) => ({ index, ...call }));
}

export function o4SafeTransactions(kind: O4SafeBatchKind, calls: readonly O4SafeCall[], safeNonce: number): O4SafeTransactionCandidate[] {
  assert.ok(Object.values(O4SafeBatchKind).includes(kind), "Unknown O4 batch kind");
  assert.ok(calls.length > 0, "Empty O4 batch");
  const encoded = calls.map((call) => ({ ...encodeO4SafeCall(call), operation: 0 }));
  const multiSend = buildSafeTransaction(encoded, safeNonce);
  const transactions: SafeTransaction[] = O4_MULTI_SEND_CANDIDATES.map((to) => ({ ...multiSend, to }));
  if (calls.length === 1) transactions.push({ ...multiSend, ...encoded[0], operation: 0 });
  return transactions.map((safeTx) => ({ kind, safeTx, safeTxHash: safeTransactionHash(safeTx) }));
}
