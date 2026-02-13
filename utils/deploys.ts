import { BigNumber, Signer, ethers } from "ethers";

import { Address } from "@utils/types";

const circom = require("circomlibjs");

import {
  USDCMock,
  Escrow,
  ProtocolViewer,
  Orchestrator,
  PaymentVerifierMock,
  PreIntentHookMock,
  NullifierRegistry,
  PostIntentHookMock,
  PaymentVerifierRegistry,
  RelayerRegistry,
  OrchestratorMock,
  EscrowRegistry,
  UnifiedPaymentVerifier,
  ThresholdSigVerifierUtilsMock,
  SimpleAttestationVerifier,
  ReentrantPostIntentHook,
  ReentrantOrchestratorMock,
  PartialPullPostIntentHookMock,
  PushPostIntentHookMock
} from "./contracts";
import {
  USDCMock__factory,
  PostIntentHookMock__factory,
  PreIntentHookMock__factory,
  OrchestratorMock__factory,
  ReentrantPostIntentHook__factory,
  ReentrantOrchestratorMock__factory,
  PartialPullPostIntentHookMock__factory,
  PushPostIntentHookMock__factory
} from "../typechain/factories/contracts/mocks";
import { PaymentVerifierMock__factory } from "../typechain/factories/contracts/mocks";
import {
  ThresholdSigVerifierUtilsMock__factory
} from "../typechain/factories/contracts/mocks/ThresholdSigVerifierUtilsMock__factory";
import { NullifierRegistry__factory } from "../typechain/factories/contracts/registries";
import { PaymentVerifierRegistry__factory } from "../typechain/factories/contracts/registries";
import { RelayerRegistry__factory } from "../typechain/factories/contracts/registries";
import { EscrowRegistry__factory } from "../typechain/factories/contracts/registries";
import { ManualRateManagerRegistry__factory } from "../typechain/factories/contracts/registries/ManualRateManagerRegistry__factory";
import { OracleRateManagerRegistry__factory } from "../typechain/factories/contracts/registries/OracleRateManagerRegistry__factory";
import { DepositRateManagerController__factory } from "../typechain/factories/contracts/DepositRateManagerController.sol/DepositRateManagerController__factory";
import { Escrow__factory } from "../typechain/factories/contracts/index";
import { ProtocolViewer__factory } from "../typechain/factories/contracts/index";
import { Orchestrator__factory } from "../typechain/factories/contracts/index";
import { UnifiedPaymentVerifier__factory } from "../typechain/factories/contracts/unifiedVerifier";
import { SimpleAttestationVerifier__factory } from "../typechain/factories/contracts/unifiedVerifier";
import { RateManagerDepositHookMock__factory } from "../typechain/factories/contracts/mocks/RateManagerDepositHookMock__factory";
import { DepositRateManagerHookV1__factory } from "../typechain/factories/contracts/hooks/DepositRateManagerHookV1__factory";
import { SignatureGatingPreIntentHook__factory } from "../typechain/factories/contracts/hooks/SignatureGatingPreIntentHook.sol/SignatureGatingPreIntentHook__factory";
import {
  ManualRateManagerRegistry,
  OracleRateManagerRegistry,
  DepositRateManagerController,
  RateManagerDepositHookMock,
  DepositRateManagerHookV1,
  SignatureGatingPreIntentHook
} from "../typechain";

export default class DeployHelper {
  private _deployerSigner: Signer;

  constructor(deployerSigner: Signer) {
    this._deployerSigner = deployerSigner;
  }

  public async deployUSDCMock(mintAmount: BigNumber, name: string, symbol: string): Promise<USDCMock> {
    return await new USDCMock__factory(this._deployerSigner).deploy(mintAmount.toString(), name, symbol);
  }

  public async deployEscrow(
    owner: Address,
    chainId: BigNumber,
    paymentVerifierRegistry: Address,
    dustRecipient: Address,
    dustThreshold: BigNumber,
    maxIntentsPerDeposit: BigNumber,
    intentExpirationPeriod: BigNumber
  ): Promise<Escrow> {
    return await new Escrow__factory(this._deployerSigner).deploy(
      owner,
      chainId.toString(),
      paymentVerifierRegistry,
      dustRecipient,
      dustThreshold,
      maxIntentsPerDeposit,
      intentExpirationPeriod
    );
  }

  public async deployOrchestrator(
    owner: Address,
    chainId: BigNumber,
    escrowRegistry: Address,
    paymentVerifierRegistry: Address,
    relayerRegistry: Address,
    protocolFee: BigNumber,
    protocolFeeRecipient: Address,
    depositRateManagerController?: Address,
    controllerSetter?: Signer
  ): Promise<Orchestrator> {
    const orchestrator = await new Orchestrator__factory(this._deployerSigner).deploy(
      owner,
      chainId.toString(),
      escrowRegistry,
      paymentVerifierRegistry,
      relayerRegistry,
      protocolFee,
      protocolFeeRecipient
    );
    const controllerAddress = depositRateManagerController ?? (await this.deployDepositRateManagerController()).address;
    const deployerAddress = await this._deployerSigner.getAddress();
    const setter =
      controllerSetter ??
      (deployerAddress.toLowerCase() === owner.toLowerCase() ? this._deployerSigner : undefined);
    if (setter) {
      await orchestrator.connect(setter).setDepositRateManagerController(controllerAddress);
    }
    return orchestrator;
  }

  public async deployProtocolViewer(escrowAddress: Address, orchestratorAddress: Address): Promise<ProtocolViewer> {
    return await new ProtocolViewer__factory(this._deployerSigner).deploy(escrowAddress, orchestratorAddress);
  }


  public async deployNullifierRegistry(): Promise<NullifierRegistry> {
    return await new NullifierRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployPaymentVerifierMock(): Promise<PaymentVerifierMock> {
    return await new PaymentVerifierMock__factory(this._deployerSigner).deploy();
  }

  public async deployPostIntentHookMock(
    usdc: Address,
    escrow: Address
  ): Promise<PostIntentHookMock> {
    return await new PostIntentHookMock__factory(this._deployerSigner).deploy(usdc, escrow);
  }

  public async deployPreIntentHookMock(): Promise<PreIntentHookMock> {
    return await new PreIntentHookMock__factory(this._deployerSigner).deploy();
  }

  public async deployPartialPullPostIntentHookMock(
    usdc: Address,
    escrow: Address
  ): Promise<PartialPullPostIntentHookMock> {
    return await new PartialPullPostIntentHookMock__factory(this._deployerSigner).deploy(usdc, escrow);
  }

  public async deployPushPostIntentHookMock(
    usdc: Address,
    orchestrator: Address
  ): Promise<PushPostIntentHookMock> {
    return await new PushPostIntentHookMock__factory(this._deployerSigner).deploy(usdc, orchestrator);
  }

  public async deployOrchestratorMock(
    escrow: Address
  ): Promise<OrchestratorMock> {
    return await new OrchestratorMock__factory(this._deployerSigner).deploy(escrow);
  }

  public async deployPaymentVerifierRegistry(): Promise<PaymentVerifierRegistry> {
    return await new PaymentVerifierRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployRelayerRegistry(): Promise<RelayerRegistry> {
    return await new RelayerRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployEscrowRegistry(): Promise<EscrowRegistry> {
    return await new EscrowRegistry__factory(this._deployerSigner).deploy();
  }

  // Deposit Rate Manager helpers
  public async deployManualRateManagerRegistry(): Promise<ManualRateManagerRegistry> {
    return await new ManualRateManagerRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployOracleRateManagerRegistry(): Promise<OracleRateManagerRegistry> {
    return await new OracleRateManagerRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployDepositRateManagerController(): Promise<DepositRateManagerController> {
    return await new DepositRateManagerController__factory(this._deployerSigner).deploy();
  }

  public async deployRateManagerDepositHookMock(): Promise<RateManagerDepositHookMock> {
    return await new RateManagerDepositHookMock__factory(this._deployerSigner).deploy();
  }

  public async deployDepositRateManagerHookV1(): Promise<DepositRateManagerHookV1> {
    return await new DepositRateManagerHookV1__factory(this._deployerSigner).deploy();
  }

  public async deploySignatureGatingPreIntentHook(
    orchestrator: Address
  ): Promise<SignatureGatingPreIntentHook> {
    return await new SignatureGatingPreIntentHook__factory(this._deployerSigner).deploy(orchestrator);
  }


  public async deployUnifiedPaymentVerifier(
    orchestrator: Address,
    nullifierRegistry: Address,
    attestationVerifier: Address
  ): Promise<UnifiedPaymentVerifier> {
    return await new UnifiedPaymentVerifier__factory(this._deployerSigner).deploy(
      orchestrator,
      nullifierRegistry,
      attestationVerifier
    );
  }

  public async deploySimpleAttestationVerifier(
    witness: Address
  ): Promise<SimpleAttestationVerifier> {
    return await new SimpleAttestationVerifier__factory(this._deployerSigner).deploy(
      witness
    );
  }

  public async deployThresholdSigVerifierUtilsMock(): Promise<ThresholdSigVerifierUtilsMock> {
    return await new ThresholdSigVerifierUtilsMock__factory(this._deployerSigner).deploy();
  }

  public async deployReentrantPostIntentHook(
    usdc: Address,
    orchestrator: Address
  ): Promise<ReentrantPostIntentHook> {
    return await new ReentrantPostIntentHook__factory(this._deployerSigner).deploy(
      usdc,
      orchestrator
    );
  }

  public async deployReentrantOrchestratorMock(
    escrow: Address
  ): Promise<ReentrantOrchestratorMock> {
    return await new ReentrantOrchestratorMock__factory(this._deployerSigner).deploy(escrow);
  }
}
