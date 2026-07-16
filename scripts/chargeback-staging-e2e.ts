import "module-alias/register";

import assert from "assert";
import { BigNumber, Contract, ContractReceipt, Wallet } from "ethers";
import hre, { ethers } from "hardhat";

import {
  CHARGEBACK_E2E_DEPLOYER,
  CHARGEBACK_E2E_DEPLOYMENTS,
  CHARGEBACK_WITNESS_THRESHOLD,
  PAYMENT_WITNESS_THRESHOLD,
  REQUIRED_WITNESS_COUNT,
} from "../deploy/28_deploy_chargeback_e2e_staging";
import { USDC } from "../deployments/parameters";

const USD = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
const VENMO = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
const ZERO = ethers.constants.AddressZero;
const ZERO_BYTES = "0x";
const DEPOSIT_AMOUNT = BigNumber.from(300_000);
const RELEASE_AMOUNT = BigNumber.from(200_000);
const FIAT_MINOR_AMOUNT = BigNumber.from(20);
const TAKER_ETH_AMOUNT = ethers.utils.parseEther("0.002");
const CONVERSION_RATE = ethers.utils.parseEther("1");
const RISK_WINDOW = 3_600;
const GRIEFING_CLIFF = 900;
const GRIEFING_PENALTY_BPS_PER_HOUR = 10;

type Mode = "preflight" | "setup" | "positive" | "negative" | "cleanup" | "verify";

type RunIdentifiers = {
  runId: string;
  paymentMethod: string;
  payeeId: string;
  originalPaymentId: string;
  disputeId: string;
};

type Context = {
  chainId: number;
  network: string;
  deployer: any;
  escrow: Contract;
  paymentVerifierRegistry: Contract;
  nullifierRegistry: Contract;
  orchestratorRegistry: Contract;
  paymentAttestationVerifier: Contract;
  chargebackAttestationVerifier: Contract;
  orchestrator: Contract;
  unifiedPaymentVerifier: Contract;
  stakeVault: Contract;
  riskManager: Contract;
  usdc: Contract;
  baselinePaymentWitnesses: string[];
  baselineChargebackWitnesses: string[];
  riskDeploymentBlock: number;
};

type SettledFixture = {
  depositId: BigNumber;
  intentHash: string;
  taker: Wallet;
  takerEthFloor: BigNumber;
  paymentId: string;
  disputeId: string;
  paymentAmount: BigNumber;
};

export function deriveRunIdentifiers(runId: string, suffix = "positive"): RunIdentifiers {
  if (!/^[A-Za-z0-9._-]{8,80}$/.test(runId)) {
    throw new Error("CHARGEBACK_E2E_RUN_ID must be 8-80 public URL-safe characters");
  }
  const scope = `${runId}:${suffix}`;
  return {
    runId,
    paymentMethod: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`venmo-chargeback-e2e:${runId}`)),
    payeeId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`chargeback-e2e-payee:${runId}`)),
    originalPaymentId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`chargeback-e2e-payment:${scope}`)),
    disputeId: ethers.utils.keccak256(ethers.utils.toUtf8Bytes(`chargeback-e2e-dispute:${scope}`)),
  };
}

function normalize(addresses: string[]): string[] {
  return addresses.map((address) => address.toLowerCase()).sort();
}

function sameAddresses(left: string[], right: string[]): boolean {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function assertWitnessDomains(paymentWitnesses: string[], chargebackWitnesses: string[]): void {
  assert.equal(paymentWitnesses.length, REQUIRED_WITNESS_COUNT, "payment verifier must have three witnesses");
  assert.equal(chargebackWitnesses.length, REQUIRED_WITNESS_COUNT, "chargeback verifier must have three witnesses");
  assert.equal(new Set(normalize(paymentWitnesses)).size, REQUIRED_WITNESS_COUNT, "payment witnesses must be unique");
  assert.equal(new Set(normalize(chargebackWitnesses)).size, REQUIRED_WITNESS_COUNT, "chargeback witnesses must be unique");
  const payment = new Set(normalize(paymentWitnesses));
  assert(!chargebackWitnesses.some((address) => payment.has(address.toLowerCase())), "witness domains overlap");
}

function publicRunId(): string {
  return process.env.CHARGEBACK_E2E_RUN_ID ?? "";
}

async function deploymentAddress(name: string): Promise<string> {
  return (await hre.deployments.get(name)).address;
}

function publicConstructorWitnesses(deployment: any): string[] {
  const args = deployment.args as unknown[] | undefined;
  if (!args || !Array.isArray(args[0])) throw new Error(`${deployment.address} is missing public constructor args`);
  return (args[0] as string[]).map((address) => ethers.utils.getAddress(address));
}

async function loadContext(): Promise<Context> {
  const networkInfo = await ethers.provider.getNetwork();
  const network = hre.deployments.getNetworkName();
  const [deployer] = await ethers.getSigners();
  const paymentVerifierDeployment = await hre.deployments.get(
    CHARGEBACK_E2E_DEPLOYMENTS.paymentAttestationVerifier,
  );
  const chargebackVerifierDeployment = await hre.deployments.get(
    CHARGEBACK_E2E_DEPLOYMENTS.chargebackAttestationVerifier,
  );
  const riskManagerDeployment = await hre.deployments.get(CHARGEBACK_E2E_DEPLOYMENTS.riskManager);
  const usdcAddress = USDC[network];
  if (!usdcAddress) throw new Error(`USDC is not configured for ${network}`);

  return {
    chainId: networkInfo.chainId,
    network,
    deployer,
    escrow: await ethers.getContractAt("EscrowV2", await deploymentAddress("EscrowV2")),
    paymentVerifierRegistry: await ethers.getContractAt(
      "PaymentVerifierRegistry",
      await deploymentAddress("PaymentVerifierRegistry"),
    ),
    nullifierRegistry: await ethers.getContractAt("NullifierRegistry", await deploymentAddress("NullifierRegistry")),
    orchestratorRegistry: await ethers.getContractAt(
      "OrchestratorRegistry",
      await deploymentAddress("OrchestratorRegistry"),
    ),
    paymentAttestationVerifier: await ethers.getContractAt(
      "MultiAttestationVerifier",
      paymentVerifierDeployment.address,
    ),
    chargebackAttestationVerifier: await ethers.getContractAt(
      "MultiAttestationVerifier",
      chargebackVerifierDeployment.address,
    ),
    orchestrator: await ethers.getContractAt(
      "OrchestratorV3",
      await deploymentAddress(CHARGEBACK_E2E_DEPLOYMENTS.orchestrator),
    ),
    unifiedPaymentVerifier: await ethers.getContractAt(
      "UnifiedPaymentVerifier",
      await deploymentAddress(CHARGEBACK_E2E_DEPLOYMENTS.unifiedPaymentVerifier),
    ),
    stakeVault: await ethers.getContractAt(
      "StakeVault",
      await deploymentAddress(CHARGEBACK_E2E_DEPLOYMENTS.stakeVault),
    ),
    riskManager: await ethers.getContractAt(
      "RiskManager",
      riskManagerDeployment.address,
    ),
    usdc: await ethers.getContractAt("IERC20", usdcAddress),
    baselinePaymentWitnesses: publicConstructorWitnesses(paymentVerifierDeployment),
    baselineChargebackWitnesses: publicConstructorWitnesses(chargebackVerifierDeployment),
    riskDeploymentBlock: riskManagerDeployment.receipt?.blockNumber ?? 0,
  };
}

async function requireCode(contract: Contract, label: string): Promise<void> {
  assert.notEqual(await ethers.provider.getCode(contract.address), "0x", `${label} runtime code missing`);
}

async function assertOwner(contract: Contract, owner: string, label: string): Promise<void> {
  assert.equal((await contract.owner()).toLowerCase(), owner.toLowerCase(), `${label} owner mismatch`);
}

async function preflight(ctx: Context, requireBaselineWitnesses = true, requireFunding = true): Promise<void> {
  if (ctx.network === "base_staging") {
    assert.equal(ctx.chainId, 8453, "staging chain ID mismatch");
    assert.equal(ctx.deployer.address.toLowerCase(), CHARGEBACK_E2E_DEPLOYER.toLowerCase(), "staging deployer mismatch");
  }

  for (const [label, contract] of Object.entries({
    EscrowV2: ctx.escrow,
    PaymentVerifierRegistry: ctx.paymentVerifierRegistry,
    NullifierRegistry: ctx.nullifierRegistry,
    OrchestratorRegistry: ctx.orchestratorRegistry,
    PaymentAttestationVerifier: ctx.paymentAttestationVerifier,
    ChargebackAttestationVerifier: ctx.chargebackAttestationVerifier,
    OrchestratorV3: ctx.orchestrator,
    UnifiedPaymentVerifier: ctx.unifiedPaymentVerifier,
    StakeVault: ctx.stakeVault,
    RiskManager: ctx.riskManager,
  })) await requireCode(contract, label);

  await assertOwner(ctx.paymentVerifierRegistry, ctx.deployer.address, "PaymentVerifierRegistry");
  await assertOwner(ctx.nullifierRegistry, ctx.deployer.address, "NullifierRegistry");
  await assertOwner(ctx.orchestratorRegistry, ctx.deployer.address, "OrchestratorRegistry");
  await assertOwner(ctx.paymentAttestationVerifier, ctx.deployer.address, "payment verifier");
  await assertOwner(ctx.chargebackAttestationVerifier, ctx.deployer.address, "chargeback verifier");
  await assertOwner(ctx.orchestrator, ctx.deployer.address, "OrchestratorV3");
  await assertOwner(ctx.stakeVault, ctx.deployer.address, "StakeVault");
  await assertOwner(ctx.riskManager, ctx.deployer.address, "RiskManager");

  assert.equal(await ctx.stakeVault.controller(), ctx.riskManager.address, "vault controller mismatch");
  assert.equal(await ctx.riskManager.orchestrator(), ctx.orchestrator.address, "risk orchestrator mismatch");
  assert.equal(await ctx.riskManager.stakeVault(), ctx.stakeVault.address, "risk vault mismatch");
  assert.equal(
    await ctx.riskManager.attestationVerifier(),
    ctx.chargebackAttestationVerifier.address,
    "risk verifier mismatch",
  );
  assert.equal(
    (await ctx.escrow.orchestratorRegistry()).toLowerCase(),
    ctx.orchestratorRegistry.address.toLowerCase(),
    "EscrowV2 registry mismatch",
  );
  assert.equal((await ctx.paymentAttestationVerifier.requiredSignatures()).toNumber(), 2, "payment threshold mismatch");
  assert.equal((await ctx.chargebackAttestationVerifier.requiredSignatures()).toNumber(), 2, "chargeback threshold mismatch");

  const paymentWitnesses: string[] = await ctx.paymentAttestationVerifier.witnesses();
  const chargebackWitnesses: string[] = await ctx.chargebackAttestationVerifier.witnesses();
  assertWitnessDomains(paymentWitnesses, chargebackWitnesses);
  if (requireBaselineWitnesses) {
    assert(sameAddresses(paymentWitnesses, ctx.baselinePaymentWitnesses), "payment witness set is not at baseline");
    assert(sameAddresses(chargebackWitnesses, ctx.baselineChargebackWitnesses), "chargeback witness set is not at baseline");
  }

  await ctx.unifiedPaymentVerifier.getPaymentDetailsHash(ctx.orchestrator.address, ethers.constants.HashZero);
  if (requireFunding) {
    assert((await ctx.usdc.balanceOf(ctx.deployer.address)).gte(500_000), "deployer has less than 500,000 USDC units");
    assert((await ethers.provider.getBalance(ctx.deployer.address)).gte(ethers.utils.parseEther("0.002")), "deployer ETH low");
  }

  const venmoVerifier = await ctx.paymentVerifierRegistry.getVerifier(VENMO);
  assert.notEqual(deriveRunIdentifiers(publicRunId()).paymentMethod, VENMO, "run method collides with Venmo");
  console.log(`preflight chain=${ctx.chainId} deployer=${ctx.deployer.address}`);
  console.log(`canonicalVenmoVerifier=${venmoVerifier}`);
  console.log(`paymentWitnesses=${paymentWitnesses.join(",")} threshold=2`);
  console.log(`chargebackWitnesses=${chargebackWitnesses.join(",")} threshold=2`);
}

async function send(label: string, txPromise: Promise<any>): Promise<ContractReceipt> {
  const transaction = await txPromise;
  // The staging deployer is an EIP-7702 delegated account. Waiting for the next block avoids the
  // Base RPC's one-in-flight-transaction guard before submitting the following owner operation.
  const receipt = await transaction.wait(hre.deployments.getNetworkName() === "base_staging" ? 2 : 1);
  console.log(`${label} tx=${receipt.transactionHash} block=${receipt.blockNumber}`);
  return receipt;
}

function platformConfigMatches(config: any, riskWindow = RISK_WINDOW): boolean {
  return config.enabled
    && config.chargeback.chargebackable
    && !config.chargeback.deferredPayoutEnabled
    && BigNumber.from(config.chargeback.reserveBps).eq(10_000)
    && BigNumber.from(config.chargeback.riskWindow).eq(riskWindow)
    && BigNumber.from(config.griefing.griefingCliff).eq(GRIEFING_CLIFF)
    && BigNumber.from(config.griefing.griefingPenaltyBpsPerHour).eq(GRIEFING_PENALTY_BPS_PER_HOUR)
    && BigNumber.from(config.griefing.freeTakeCount).isZero()
    && BigNumber.from(config.griefing.freeTakeAmount).isZero();
}

async function configureRun(ctx: Context, ids: RunIdentifiers, riskWindow = RISK_WINDOW): Promise<void> {
  const configuredMethods: string[] = await ctx.unifiedPaymentVerifier.getPaymentMethods();
  if (!configuredMethods.map((method) => method.toLowerCase()).includes(ids.paymentMethod.toLowerCase())) {
    await send("upv.addPaymentMethod", ctx.unifiedPaymentVerifier.addPaymentMethod(ids.paymentMethod));
  }

  if (!(await ctx.paymentVerifierRegistry.isPaymentMethod(ids.paymentMethod))) {
    await send(
      "registry.addPaymentMethod",
      ctx.paymentVerifierRegistry.addPaymentMethod(ids.paymentMethod, ctx.unifiedPaymentVerifier.address, [USD]),
    );
  } else {
    assert.equal(
      (await ctx.paymentVerifierRegistry.getVerifier(ids.paymentMethod)).toLowerCase(),
      ctx.unifiedPaymentVerifier.address.toLowerCase(),
      "run method points to another verifier",
    );
    assert(await ctx.paymentVerifierRegistry.isCurrency(ids.paymentMethod, USD), "run method does not support USD");
  }

  if (!(await ctx.nullifierRegistry.isWriter(ctx.unifiedPaymentVerifier.address))) {
    await send("nullifier.addWritePermission", ctx.nullifierRegistry.addWritePermission(ctx.unifiedPaymentVerifier.address));
  }
  if (!(await ctx.orchestratorRegistry.isOrchestrator(ctx.orchestrator.address))) {
    await send("orchestratorRegistry.add", ctx.orchestratorRegistry.addOrchestrator(ctx.orchestrator.address));
  }
  if (await ctx.riskManager.admissionPaused()) {
    await send("riskManager.unpause", ctx.riskManager.setAdmissionPaused(false));
  }
  const currentConfig = await ctx.riskManager.getPlatformRiskConfig(ids.paymentMethod);
  if (!platformConfigMatches(currentConfig, riskWindow)) {
    await send("riskManager.setPlatformRiskConfig", ctx.riskManager.setPlatformRiskConfig(ids.paymentMethod, {
      enabled: true,
      chargeback: {
        chargebackable: true,
        deferredPayoutEnabled: false,
        reserveBps: 10_000,
        riskWindow,
      },
      griefing: {
        griefingCliff: GRIEFING_CLIFF,
        griefingPenaltyBpsPerHour: GRIEFING_PENALTY_BPS_PER_HOUR,
        freeTakeCount: 0,
        freeTakeAmount: 0,
      },
    }));
  }
}

async function replaceWitnesses(verifier: Contract, desired: string[], label: string): Promise<void> {
  const current: string[] = await verifier.witnesses();
  if (sameAddresses(current, desired)) return;
  for (const witness of desired) {
    if (!current.some((existing) => existing.toLowerCase() === witness.toLowerCase())) {
      await send(`${label}.addWitness(${witness})`, verifier.addWitness(witness));
    }
  }
  for (const witness of current) {
    if (!desired.some((replacement) => replacement.toLowerCase() === witness.toLowerCase())) {
      await send(`${label}.removeWitness(${witness})`, verifier.removeWitness(witness));
    }
  }
  // Base's public RPC is load balanced and can briefly serve a stale latest block even after a
  // receipt is returned. Poll until the mutation is visible instead of trusting one backend's tip.
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const finalWitnesses: string[] = await verifier.witnesses();
      const threshold = (await verifier.requiredSignatures()).toNumber();
      if (sameAddresses(finalWitnesses, desired) && threshold === 2) return;
    } catch (_) {
      // A backend can briefly lack the receipt block; retry against the next load-balanced read.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`${label} witness rotation incomplete`);
}

function parseEvent(receipt: ContractReceipt, contract: Contract, eventName: string): any {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== contract.address.toLowerCase()) continue;
    try {
      const event = contract.interface.parseLog(log);
      if (event.name === eventName) return event.args;
    } catch (_) {
      // Ignore logs from other interfaces at the same transaction boundary.
    }
  }
  throw new Error(`${eventName} event missing from ${receipt.transactionHash}`);
}

export async function buildPaymentProof(
  ctx: Pick<Context, "chainId" | "unifiedPaymentVerifier">,
  witnesses: Wallet[],
  ids: RunIdentifiers,
  intentHash: string,
  intent: any,
  paymentId = ids.originalPaymentId,
): Promise<string> {
  const details = {
    method: ids.paymentMethod,
    payeeId: intent.payeeId,
    amount: FIAT_MINOR_AMOUNT,
    currency: USD,
    timestamp: BigNumber.from(intent.timestamp).mul(1000),
    paymentId,
  };
  const snapshot = {
    intentHash,
    amount: intent.amount,
    paymentMethod: intent.paymentMethod,
    fiatCurrency: intent.fiatCurrency,
    payeeDetails: intent.payeeId,
    conversionRate: intent.conversionRate,
    signalTimestamp: intent.timestamp,
    timestampBuffer: 0,
  };
  const data = ethers.utils.defaultAbiCoder.encode(
    [
      "tuple(bytes32 method,bytes32 payeeId,uint256 amount,bytes32 currency,uint256 timestamp,bytes32 paymentId)",
      "tuple(bytes32 intentHash,uint256 amount,bytes32 paymentMethod,bytes32 fiatCurrency,bytes32 payeeDetails,uint256 conversionRate,uint256 signalTimestamp,uint256 timestampBuffer)",
    ],
    [details, snapshot],
  );
  const dataHash = ethers.utils.keccak256(data);
  const domain = {
    name: "UnifiedPaymentVerifier",
    version: "1",
    chainId: ctx.chainId,
    verifyingContract: ctx.unifiedPaymentVerifier.address,
  };
  const types = {
    PaymentAttestation: [
      { name: "intentHash", type: "bytes32" },
      { name: "releaseAmount", type: "uint256" },
      { name: "dataHash", type: "bytes32" },
    ],
  };
  const value = { intentHash, releaseAmount: RELEASE_AMOUNT, dataHash };
  const signatures = await Promise.all(witnesses.slice(0, 2).map((witness) => witness._signTypedData(domain, types, value)));
  return ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash,bytes[] signatures,bytes data,bytes metadata)"],
    [[intentHash, RELEASE_AMOUNT, dataHash, signatures, data, ZERO_BYTES]],
  );
}

type DetailsOverrides = Partial<{
  paymentMethod: string;
  originalPaymentId: string;
  disputeId: string;
  paymentAmount: BigNumber;
  paymentCurrency: string;
}>;

export async function buildChargebackAttestation(
  ctx: Pick<Context, "chainId" | "riskManager">,
  witnesses: Wallet[],
  ids: RunIdentifiers,
  intentHash: string,
  overrides: DetailsOverrides = {},
  domainOverrides: Partial<{ chainId: number; verifyingContract: string }> = {},
): Promise<any> {
  const details = {
    paymentMethod: overrides.paymentMethod ?? ids.paymentMethod,
    originalPaymentId: overrides.originalPaymentId ?? ids.originalPaymentId,
    disputeId: overrides.disputeId ?? ids.disputeId,
    paymentAmount: overrides.paymentAmount ?? FIAT_MINOR_AMOUNT,
    paymentCurrency: overrides.paymentCurrency ?? USD,
  };
  const data = ethers.utils.defaultAbiCoder.encode(
    ["tuple(bytes32 paymentMethod,bytes32 originalPaymentId,bytes32 disputeId,uint256 paymentAmount,bytes32 paymentCurrency)"],
    [details],
  );
  const dataHash = ethers.utils.keccak256(data);
  const domain = {
    name: "ZKP2P RiskManager",
    version: "1",
    chainId: domainOverrides.chainId ?? ctx.chainId,
    verifyingContract: domainOverrides.verifyingContract ?? ctx.riskManager.address,
  };
  const types = {
    ChargebackAttestation: [
      { name: "intentHash", type: "bytes32" },
      { name: "dataHash", type: "bytes32" },
    ],
  };
  const signatures = await Promise.all(
    witnesses.slice(0, 2).map((witness) => witness._signTypedData(domain, types, { intentHash, dataHash })),
  );
  return { intentHash, dataHash, signatures, data, metadata: ZERO_BYTES };
}

async function createAndSettle(
  ctx: Context,
  ids: RunIdentifiers,
  paymentWitnesses: Wallet[],
  taker: Wallet,
  paymentId = ids.originalPaymentId,
): Promise<SettledFixture> {
  const paymentNullifier = ethers.utils.keccak256(
    ethers.utils.solidityPack(["bytes32", "bytes32"], [ids.paymentMethod, paymentId]),
  );
  assert(!(await ctx.nullifierRegistry.isNullified(paymentNullifier)), "payment identifier was already nullified");

  // Fund against the provider's advertised EIP-1559 max fee, not only Base's usually much lower
  // effective gas price. Admission invokes the risk hook and can exceed a simple transfer estimate.
  const takerEthFloor = await ethers.provider.getBalance(taker.address);
  if (taker.address.toLowerCase() !== ctx.deployer.address.toLowerCase()) {
    await send("fundTaker", ctx.deployer.sendTransaction({ to: taker.address, value: TAKER_ETH_AMOUNT }));
  }
  await send("usdc.approveEscrow", ctx.usdc.approve(ctx.escrow.address, DEPOSIT_AMOUNT));
  const createReceipt = await send("escrow.createDeposit", ctx.escrow.createDeposit({
    token: ctx.usdc.address,
    amount: DEPOSIT_AMOUNT,
    intentAmountRange: { min: RELEASE_AMOUNT, max: RELEASE_AMOUNT },
    paymentMethods: [ids.paymentMethod],
    paymentMethodData: [{ intentGatingService: ZERO, payeeDetails: ids.payeeId, data: ZERO_BYTES }],
    currencies: [[{
      code: USD,
      minConversionRate: CONVERSION_RATE,
      oracleRateConfig: { adapter: ZERO, adapterConfig: ZERO_BYTES, spreadBps: 0, maxStaleness: 0 },
    }]],
    delegate: ZERO,
    intentGuardian: ZERO,
    retainOnEmpty: true,
  }));
  const depositId: BigNumber = parseEvent(createReceipt, ctx.escrow, "DepositReceived").depositId;
  await send(
    "orchestrator.setDepositRiskHook",
    ctx.orchestrator.setDepositRiskHook(ctx.escrow.address, depositId, ctx.riskManager.address),
  );

  await send("usdc.approveStakeVault", ctx.usdc.approve(ctx.stakeVault.address, RELEASE_AMOUNT));
  await send("stakeVault.depositStakeFor", ctx.stakeVault.depositStakeFor(taker.address, RELEASE_AMOUNT));

  const signalReceipt = await send("orchestrator.signalIntent", ctx.orchestrator.connect(taker).signalIntent({
    escrow: ctx.escrow.address,
    depositId,
    amount: RELEASE_AMOUNT,
    to: taker.address,
    paymentMethod: ids.paymentMethod,
    fiatCurrency: USD,
    conversionRate: CONVERSION_RATE,
    referralFees: [],
    gatingServiceSignature: ZERO_BYTES,
    signatureExpiration: 0,
    postIntentHook: ZERO,
    preIntentHookData: ZERO_BYTES,
    data: ZERO_BYTES,
  }));
  const intentHash: string = parseEvent(signalReceipt, ctx.orchestrator, "IntentSignaled").intentHash;
  const intent = await ctx.orchestrator.getIntent(intentHash);
  assert.equal(await ctx.orchestrator.getIntentRiskHook(intentHash), ctx.riskManager.address, "risk hook not snapshotted");
  let position = await ctx.riskManager.getRiskPosition(intentHash);
  assert.equal(position.status, 1, "position is not pending");
  assert.equal(position.paymentVerifier, ctx.unifiedPaymentVerifier.address, "payment verifier snapshot mismatch");

  const paymentProof = await buildPaymentProof(ctx, paymentWitnesses, ids, intentHash, intent, paymentId);
  const takerBalanceBefore = await ctx.usdc.balanceOf(taker.address);
  const fulfillReceipt = await send("orchestrator.fulfillIntent", ctx.orchestrator.fulfillIntent({
    paymentProof,
    intentHash,
    verificationData: ZERO_BYTES,
    postIntentHookData: ZERO_BYTES,
  }));
  const paymentEvent = parseEvent(fulfillReceipt, ctx.unifiedPaymentVerifier, "PaymentVerified");
  assert.equal(paymentEvent.method, ids.paymentMethod, "verified payment method mismatch");
  assert(BigNumber.from(paymentEvent.amount).eq(FIAT_MINOR_AMOUNT), "verified fiat amount mismatch");
  assert.equal(paymentEvent.currency, USD, "verified currency mismatch");
  assert.equal(paymentEvent.paymentId, paymentId, "verified payment ID mismatch");
  assert((await ctx.usdc.balanceOf(taker.address)).sub(takerBalanceBefore).eq(RELEASE_AMOUNT), "gross release mismatch");

  const expectedPaymentDetailsHash = ethers.utils.keccak256(ethers.utils.defaultAbiCoder.encode(
    ["bytes32", "bytes32", "uint256", "bytes32"],
    [ids.paymentMethod, paymentId, FIAT_MINOR_AMOUNT, USD],
  ));
  assert.equal(
    await ctx.unifiedPaymentVerifier.getPaymentDetailsHash(ctx.orchestrator.address, intentHash),
    expectedPaymentDetailsHash,
    "UPV payment commitment mismatch",
  );
  position = await ctx.riskManager.getRiskPosition(intentHash);
  assert.equal(position.status, 3, "position is not settled");
  assert(position.releasedAmount.eq(RELEASE_AMOUNT), "released amount mismatch");
  assert(position.reservedAmount.eq(RELEASE_AMOUNT), "reserved amount mismatch");
  assert.equal(position.paymentDetailsHash, expectedPaymentDetailsHash, "risk payment commitment mismatch");

  console.log(`depositId=${depositId.toString()} intentHash=${intentHash}`);
  return {
    depositId,
    intentHash,
    taker,
    takerEthFloor,
    paymentId,
    disputeId: ids.disputeId,
    paymentAmount: FIAT_MINOR_AMOUNT,
  };
}

async function settleChargeback(
  ctx: Context,
  ids: RunIdentifiers,
  chargebackWitnesses: Wallet[],
  fixture: SettledFixture,
): Promise<void> {
  const attestation = await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash);
  const deployerBalanceBefore = await ctx.usdc.balanceOf(ctx.deployer.address);
  const stakeBalanceBefore = await ctx.stakeVault.stakeBalance(ctx.deployer.address);
  const reservedStakeBefore = await ctx.stakeVault.reservedStake(ctx.deployer.address);
  assert(stakeBalanceBefore.gte(RELEASE_AMOUNT), "stake balance is below the chargeback amount");
  assert(reservedStakeBefore.eq(RELEASE_AMOUNT), "vault reservation is not the exact gross release");
  const receipt = await send("riskManager.submitChargeback", ctx.riskManager.submitChargeback(attestation));
  const event = parseEvent(receipt, ctx.riskManager, "ChargebackSettled");
  assert.equal(event.intentHash, fixture.intentHash, "chargeback intent mismatch");
  assert(BigNumber.from(event.compensatedAmount).eq(RELEASE_AMOUNT), "compensation event mismatch");
  let position = await ctx.riskManager.getRiskPosition(fixture.intentHash);
  assert.equal(position.status, 5, "position is not slashed");
  assert(position.slashedAmount.eq(RELEASE_AMOUNT), "slashed amount mismatch");
  assert(position.reservedAmount.isZero(), "reservation remains after slash");
  assert((await ctx.stakeVault.reservedStake(ctx.deployer.address)).isZero(), "vault reservedStake remains after slash");
  assert(
    (await ctx.stakeVault.stakeBalance(ctx.deployer.address)).eq(stakeBalanceBefore.sub(RELEASE_AMOUNT)),
    "vault stake balance did not fall by the gross release",
  );
  const reservation = await ctx.stakeVault.getReservation(fixture.intentHash);
  assert(!reservation.active && reservation.amount.isZero(), "intent reservation remains active after slash");
  assert((await ctx.stakeVault.claimableCompensation(ctx.deployer.address)).eq(RELEASE_AMOUNT), "claimable mismatch");

  await send("stakeVault.withdrawCompensation", ctx.stakeVault.withdrawCompensation(ctx.deployer.address));
  assert((await ctx.usdc.balanceOf(ctx.deployer.address)).sub(deployerBalanceBefore).eq(RELEASE_AMOUNT), "LP wallet claim mismatch");
  const nullifier = ethers.utils.keccak256(
    ethers.utils.solidityPack(["bytes32", "bytes32"], [ids.paymentMethod, ids.disputeId]),
  );
  assert(await ctx.riskManager.usedChargebackNullifiers(nullifier), "chargeback evidence was not nullified");

  await send("escrow.withdrawDeposit", ctx.escrow.withdrawDeposit(fixture.depositId));
  await send("stakeVault.revokeTaker", ctx.stakeVault.setTakerAuthorization(fixture.taker.address, false));
  await send("taker.returnUSDC", ctx.usdc.connect(fixture.taker).transfer(ctx.deployer.address, RELEASE_AMOUNT));
  position = await ctx.riskManager.getRiskPosition(fixture.intentHash);
  assert.equal(position.status, 5, "terminal position changed during cleanup");
}

async function sweepEth(wallet: Wallet, recipient: string, retainedBalance = BigNumber.from(0)): Promise<void> {
  if (wallet.address.toLowerCase() === recipient.toLowerCase()) return;
  const balance = await ethers.provider.getBalance(wallet.address);
  const fee = await ethers.provider.getFeeData();
  const quotedMaxFee = fee.maxFeePerGas ?? fee.gasPrice;
  if (!quotedMaxFee) return;
  // Pin a buffered max fee in the transaction. If ethers repopulates fees after this balance
  // calculation, even a tiny quote change can otherwise make the sweep exceed the wallet balance.
  const maxFeePerGas = quotedMaxFee.mul(2);
  const maxPriorityFeePerGas = fee.maxPriorityFeePerGas ?? quotedMaxFee;
  // 0x84 is an EIP-7702 delegated account, so receiving ETH can execute code and needs more than
  // the legacy 21,000-gas stipend. Estimate the delegated receive path and retain a 20% buffer.
  const estimatedGas = await wallet.estimateGas({ to: recipient, value: 1 });
  const gasLimit = estimatedGas.mul(120).div(100);
  const gasCost = maxFeePerGas.mul(gasLimit);
  if (balance.lte(retainedBalance.add(gasCost))) return;
  await send("taker.sweepETH", wallet.sendTransaction({
    to: recipient,
    value: balance.sub(retainedBalance).sub(gasCost),
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  }));
}

function ephemeralWitnesses(): { payment: Wallet[]; chargeback: Wallet[] } {
  const payment = Array.from({ length: 3 }, () => Wallet.createRandom());
  const chargeback = Array.from({ length: 3 }, () => Wallet.createRandom());
  assertWitnessDomains(payment.map((wallet) => wallet.address), chargeback.map((wallet) => wallet.address));
  return { payment, chargeback };
}

async function withEphemeralWitnesses(
  ctx: Context,
  callback: (payment: Wallet[], chargeback: Wallet[]) => Promise<void>,
): Promise<void> {
  const ephemeral = ephemeralWitnesses();
  console.log(`temporaryPaymentWitnesses=${ephemeral.payment.map((wallet) => wallet.address).join(",")} threshold=2`);
  console.log(`temporaryChargebackWitnesses=${ephemeral.chargeback.map((wallet) => wallet.address).join(",")} threshold=2`);
  await replaceWitnesses(ctx.paymentAttestationVerifier, ephemeral.payment.map((wallet) => wallet.address), "paymentVerifier");
  await replaceWitnesses(
    ctx.chargebackAttestationVerifier,
    ephemeral.chargeback.map((wallet) => wallet.address),
    "chargebackVerifier",
  );
  try {
    await callback(ephemeral.payment, ephemeral.chargeback);
  } finally {
    await replaceWitnesses(ctx.paymentAttestationVerifier, ctx.baselinePaymentWitnesses, "paymentVerifier.restore");
    await replaceWitnesses(
      ctx.chargebackAttestationVerifier,
      ctx.baselineChargebackWitnesses,
      "chargebackVerifier.restore",
    );
  }
}

async function runPositive(ctx: Context, ids: RunIdentifiers): Promise<void> {
  await configureRun(ctx, ids);
  await withEphemeralWitnesses(ctx, async (paymentWitnesses, chargebackWitnesses) => {
    const fixture = await createAndSettle(ctx, ids, paymentWitnesses, Wallet.createRandom().connect(ethers.provider));
    await settleChargeback(ctx, ids, chargebackWitnesses, fixture);
    await sweepEth(fixture.taker, ctx.deployer.address, fixture.takerEthFloor);
  });
}

async function expectRevert(label: string, action: () => Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (_) {
    console.log(`negative.${label}=PASS`);
    return;
  }
  throw new Error(`negative.${label} unexpectedly succeeded`);
}

async function runNegative(ctx: Context, ids: RunIdentifiers): Promise<void> {
  const takerPrivateKey = process.env.CHARGEBACK_E2E_TAKER_PRIVATE_KEY;
  if (!takerPrivateKey) throw new Error("CHARGEBACK_E2E_TAKER_PRIVATE_KEY is required for recoverable negative runs");
  const taker = new Wallet(takerPrivateKey, ethers.provider);
  assert.notEqual(taker.address.toLowerCase(), ctx.deployer.address.toLowerCase(), "negative taker must differ from stake owner");
  await configureRun(ctx, ids);
  await withEphemeralWitnesses(ctx, async (paymentWitnesses, chargebackWitnesses) => {
    // Require a recoverable non-owner signer so an interrupted diagnostic can be resumed without
    // persisting or logging a newly generated private key.
    const fixture = await createAndSettle(ctx, ids, paymentWitnesses, taker);
    const valid = await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash);
    const originalPosition = await ctx.riskManager.getRiskPosition(fixture.intentHash);
    const originalClaimable = await ctx.stakeVault.claimableCompensation(ctx.deployer.address);

    await expectRevert("one_signature", () => ctx.riskManager.callStatic.submitChargeback({
      ...valid,
      signatures: valid.signatures.slice(0, 1),
    }));
    await expectRevert("duplicate_signer", () => ctx.riskManager.callStatic.submitChargeback({
      ...valid,
      signatures: [valid.signatures[0], valid.signatures[0]],
    }));
    await expectRevert("wrong_chain", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {}, { chainId: ctx.chainId + 1 }),
    ));
    await expectRevert("wrong_manager", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {}, { verifyingContract: ctx.orchestrator.address }),
    ));
    await expectRevert("wrong_method", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {
        paymentMethod: ethers.utils.id("wrong-method"),
      }),
    ));
    await expectRevert("wrong_payment_id", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {
        originalPaymentId: ethers.utils.id("wrong-payment"),
      }),
    ));
    await expectRevert("wrong_fiat_amount", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {
        paymentAmount: FIAT_MINOR_AMOUNT.add(1),
      }),
    ));
    await expectRevert("wrong_currency", async () => ctx.riskManager.callStatic.submitChargeback(
      await buildChargebackAttestation(ctx, chargebackWitnesses, ids, fixture.intentHash, {
        paymentCurrency: ethers.utils.id("EUR"),
      }),
    ));
    await expectRevert("tampered_data", () => ctx.riskManager.callStatic.submitChargeback({
      ...valid,
      data: `${valid.data}00`,
    }));

    const afterInvalidPosition = await ctx.riskManager.getRiskPosition(fixture.intentHash);
    assert.equal(afterInvalidPosition.status, originalPosition.status, "negative case changed status");
    assert(afterInvalidPosition.reservedAmount.eq(originalPosition.reservedAmount), "negative case changed reservation");
    assert((await ctx.stakeVault.claimableCompensation(ctx.deployer.address)).eq(originalClaimable), "negative case credited LP");

    await settleChargeback(ctx, ids, chargebackWitnesses, fixture);
    await expectRevert("same_position_replay", () => ctx.riskManager.callStatic.submitChargeback(valid));
    await sweepEth(fixture.taker, ctx.deployer.address, fixture.takerEthFloor);
  });
  console.log("negative.long_lived_cases=NOT_RUN (global dispute replay, payment replay, manual release, deadline require independent positions)");
}

async function cleanup(ctx: Context, ids: RunIdentifiers): Promise<void> {
  if (process.env.CHARGEBACK_E2E_CLEANUP_ACK !== "true") {
    throw new Error("set CHARGEBACK_E2E_CLEANUP_ACK=true after confirming every run position is terminal");
  }
  const createdPositions = await ctx.riskManager.queryFilter(
    ctx.riskManager.filters.RiskPositionCreated(),
    ctx.riskDeploymentBlock,
    "latest",
  );
  for (const created of createdPositions) {
    const intentHash = created.args?.intentHash;
    if (!intentHash) throw new Error("RiskPositionCreated log is missing intentHash");
    const position = await ctx.riskManager.getRiskPosition(intentHash);
    const status = BigNumber.isBigNumber(position.status) ? position.status.toNumber() : Number(position.status);
    if (![2, 4, 5].includes(status)) {
      throw new Error(`refusing cleanup while intent ${intentHash} has nonterminal status ${status}`);
    }
  }
  assert((await ctx.stakeVault.reservedStake(ctx.deployer.address)).isZero(), "deployer stake remains reserved");
  await replaceWitnesses(ctx.paymentAttestationVerifier, ctx.baselinePaymentWitnesses, "paymentVerifier.cleanup");
  await replaceWitnesses(
    ctx.chargebackAttestationVerifier,
    ctx.baselineChargebackWitnesses,
    "chargebackVerifier.cleanup",
  );
  if (!(await ctx.riskManager.admissionPaused())) {
    await send("riskManager.pause", ctx.riskManager.setAdmissionPaused(true));
  }
  if (await ctx.paymentVerifierRegistry.isPaymentMethod(ids.paymentMethod)) {
    assert.equal(
      (await ctx.paymentVerifierRegistry.getVerifier(ids.paymentMethod)).toLowerCase(),
      ctx.unifiedPaymentVerifier.address.toLowerCase(),
      "refusing to remove a run method owned by another verifier",
    );
    await send("registry.removePaymentMethod", ctx.paymentVerifierRegistry.removePaymentMethod(ids.paymentMethod));
  }
  if (await ctx.nullifierRegistry.isWriter(ctx.unifiedPaymentVerifier.address)) {
    await send("nullifier.removeWritePermission", ctx.nullifierRegistry.removeWritePermission(ctx.unifiedPaymentVerifier.address));
  }
  if (await ctx.orchestratorRegistry.isOrchestrator(ctx.orchestrator.address)) {
    await send("orchestratorRegistry.remove", ctx.orchestratorRegistry.removeOrchestrator(ctx.orchestrator.address));
  }
}

async function verify(ctx: Context, ids: RunIdentifiers): Promise<void> {
  await preflight(ctx, true, false);
  const expectClean = process.env.CHARGEBACK_E2E_EXPECT_CLEAN === "true";
  if (expectClean) {
    assert(await ctx.riskManager.admissionPaused(), "admission is not paused after cleanup");
    assert(!(await ctx.paymentVerifierRegistry.isPaymentMethod(ids.paymentMethod)), "run payment method remains registered");
    assert(!(await ctx.nullifierRegistry.isWriter(ctx.unifiedPaymentVerifier.address)), "UPV still has nullifier permission");
    assert(!(await ctx.orchestratorRegistry.isOrchestrator(ctx.orchestrator.address)), "isolated orchestrator remains registered");
    assert((await ctx.stakeVault.stakeBalance(ctx.deployer.address)).isZero(), "deployer stake remains after cleanup");
    assert((await ctx.stakeVault.reservedStake(ctx.deployer.address)).isZero(), "deployer reservation remains after cleanup");
    assert(
      (await ctx.stakeVault.claimableCompensation(ctx.deployer.address)).isZero(),
      "deployer compensation remains after cleanup",
    );
  } else {
    assert(await ctx.paymentVerifierRegistry.isPaymentMethod(ids.paymentMethod), "run payment method is not configured");
    assert(await ctx.nullifierRegistry.isWriter(ctx.unifiedPaymentVerifier.address), "UPV is not a nullifier writer");
    assert(await ctx.orchestratorRegistry.isOrchestrator(ctx.orchestrator.address), "isolated orchestrator is not registered");
  }
  console.log(`verify cleanup=${expectClean ? "complete" : "not-requested"}`);
}

async function main(): Promise<void> {
  const mode = (process.env.CHARGEBACK_E2E_MODE ?? "preflight") as Mode;
  if (!["preflight", "setup", "positive", "negative", "cleanup", "verify"].includes(mode)) {
    throw new Error(`unsupported CHARGEBACK_E2E_MODE=${mode}`);
  }
  const ids = deriveRunIdentifiers(publicRunId());
  const ctx = await loadContext();

  if (mode === "preflight") return preflight(ctx);
  if (mode === "setup") {
    await preflight(ctx);
    await configureRun(ctx, ids);
    return;
  }
  if (mode === "positive") {
    await preflight(ctx);
    return runPositive(ctx, ids);
  }
  if (mode === "negative") {
    await preflight(ctx);
    return runNegative(ctx, deriveRunIdentifiers(ids.runId, "negative"));
  }
  if (mode === "cleanup") return cleanup(ctx, ids);
  return verify(ctx, ids);
}

if (require.main === module) {
  main().catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
