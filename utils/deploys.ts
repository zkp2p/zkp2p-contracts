import { BigNumber, Signer, ethers } from "ethers";

import { Address } from "@utils/types";

const circom = require("circomlibjs");

import {
  USDCMock,
  Escrow,
  EscrowV2,
  ProtocolViewer,
  Orchestrator,
  OrchestratorV2,
  RateManagerV1,
  OrchestratorRegistry,
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
  ReentrantPreIntentHookMock,
  ReentrantSignalIntentCallerMock,
  ReentrantOrchestratorMock,
  PartialPullPostIntentHookMock,
  PartialPullPostIntentHookV2Mock,
  PushPostIntentHookMock,
  PushPostIntentHookV2Mock,
  ReentrantPostIntentHookV2,
  RateManagerMock,
  ReentrantSignalIntentCallerV2Mock,
  PostIntentHookRegistry,
  PostIntentHookV2Mock
} from "./contracts";
import {
  USDCMock__factory,
  PostIntentHookMock__factory,
  PreIntentHookMock__factory,
  OrchestratorMock__factory,
  RateManagerMock__factory,
  ReentrantPostIntentHook__factory,
  ReentrantSignalIntentCallerMock__factory,
  ReentrantOrchestratorMock__factory,
  PartialPullPostIntentHookMock__factory,
  PartialPullPostIntentHookV2Mock__factory,
  PushPostIntentHookMock__factory,
  PushPostIntentHookV2Mock__factory,
  ReentrantPostIntentHookV2__factory,
  PostIntentHookV2Mock__factory
} from "../typechain/factories/contracts/mocks";
import { ReentrantSignalIntentCallerV2Mock__factory } from "../typechain/factories/contracts/mocks/ReentrantSignalIntentCallerV2Mock__factory";
import { ReentrantPreIntentHookMock__factory } from "../typechain/factories/contracts/mocks/ReentrantPreIntentHookMock.sol/ReentrantPreIntentHookMock__factory";
import { PaymentVerifierMock__factory } from "../typechain/factories/contracts/mocks";
import {
  ThresholdSigVerifierUtilsMock__factory
} from "../typechain/factories/contracts/mocks/ThresholdSigVerifierUtilsMock__factory";
import { NullifierRegistry__factory } from "../typechain/factories/contracts/registries";
import { PaymentVerifierRegistry__factory } from "../typechain/factories/contracts/registries";
import { RelayerRegistry__factory } from "../typechain/factories/contracts/registries";
import { EscrowRegistry__factory } from "../typechain/factories/contracts/registries";
import { PostIntentHookRegistry__factory } from "../typechain/factories/contracts/registries";
import { Escrow__factory } from "../typechain/factories/contracts/index";
import { EscrowV2__factory } from "../typechain/factories/contracts/EscrowV2__factory";
import { ProtocolViewer__factory } from "../typechain/factories/contracts/index";
import { Orchestrator__factory } from "../typechain/factories/contracts/index";
import { OrchestratorV2__factory } from "../typechain/factories/contracts/OrchestratorV2__factory";
import { RateManagerV1__factory } from "../typechain/factories/contracts/RateManagerV1__factory";
import { UnifiedPaymentVerifier__factory } from "../typechain/factories/contracts/unifiedVerifier";
import { SimpleAttestationVerifier__factory } from "../typechain/factories/contracts/unifiedVerifier";
import { SignatureGatingPreIntentHook__factory } from "../typechain/factories/contracts/hooks/SignatureGatingPreIntentHook__factory";
import { WhitelistPreIntentHook__factory } from "../typechain/factories/contracts/hooks/WhitelistPreIntentHook__factory";
import { OrchestratorRegistry__factory } from "../typechain/factories/contracts/registries/OrchestratorRegistry__factory";
import {
  SignatureGatingPreIntentHook,
  WhitelistPreIntentHook
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

  public async deployOrchestratorRegistry(owner?: Address): Promise<OrchestratorRegistry> {
    const registry = await new OrchestratorRegistry__factory(this._deployerSigner).deploy();
    if (owner) {
      const deployerAddress = await this._deployerSigner.getAddress();
      if (deployerAddress.toLowerCase() !== owner.toLowerCase()) {
        await registry.transferOwnership(owner);
      }
    }
    return registry;
  }

  public async deployEscrowV2(
    owner: Address,
    chainId: BigNumber,
    orchestratorRegistry: Address,
    paymentVerifierRegistry: Address,
    dustRecipient: Address,
    dustThreshold: BigNumber,
    maxIntentsPerDeposit: BigNumber,
    intentExpirationPeriod: BigNumber
  ): Promise<EscrowV2> {
    return await new EscrowV2__factory(this._deployerSigner).deploy(
      owner,
      chainId.toString(),
      orchestratorRegistry,
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
    postIntentHookRegistry: Address,
    relayerRegistry: Address,
    protocolFee: BigNumber,
    protocolFeeRecipient: Address
  ): Promise<Orchestrator> {
    return await new Orchestrator__factory(this._deployerSigner).deploy(
      owner,
      chainId.toString(),
      escrowRegistry,
      paymentVerifierRegistry,
      postIntentHookRegistry,
      relayerRegistry,
      protocolFee,
      protocolFeeRecipient
    );
  }

  public async deployOrchestratorV2(
    owner: Address,
    chainId: BigNumber,
    escrowRegistry: Address,
    paymentVerifierRegistry: Address,
    relayerRegistry: Address,
    protocolFee: BigNumber,
    protocolFeeRecipient: Address
  ): Promise<OrchestratorV2> {
    return await new OrchestratorV2__factory(this._deployerSigner).deploy(
      owner,
      chainId.toString(),
      escrowRegistry,
      paymentVerifierRegistry,
      relayerRegistry,
      protocolFee,
      protocolFeeRecipient
    );
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

  public async deployPostIntentHookRegistry(): Promise<PostIntentHookRegistry> {
    return await new PostIntentHookRegistry__factory(this._deployerSigner).deploy();
  }

  public async deployRateManagerV1(escrowRegistry: Address): Promise<RateManagerV1> {
    return await new RateManagerV1__factory(this._deployerSigner).deploy(escrowRegistry);
  }

  public async deployRateManagerMock(): Promise<RateManagerMock> {
    return await new RateManagerMock__factory(this._deployerSigner).deploy();
  }

  public async deploySignatureGatingPreIntentHook(
    orchestratorRegistry: Address,
    chainId: BigNumber
  ): Promise<SignatureGatingPreIntentHook> {
    return await new SignatureGatingPreIntentHook__factory(this._deployerSigner).deploy(orchestratorRegistry, chainId);
  }

  public async deployWhitelistPreIntentHook(
    orchestratorRegistry: Address
  ): Promise<WhitelistPreIntentHook> {
    return await new WhitelistPreIntentHook__factory(this._deployerSigner).deploy(orchestratorRegistry);
  }


  public async deployUnifiedPaymentVerifier(
    orchestratorRegistry: Address,
    nullifierRegistry: Address,
    attestationVerifier: Address
  ): Promise<UnifiedPaymentVerifier> {
    return await new UnifiedPaymentVerifier__factory(this._deployerSigner).deploy(
      orchestratorRegistry,
      nullifierRegistry,
      attestationVerifier
    );
  }

  public async deployPostIntentHookV2Mock(
    usdc: Address,
    orchestrator: Address
  ): Promise<PostIntentHookV2Mock> {
    return await new PostIntentHookV2Mock__factory(this._deployerSigner).deploy(usdc, orchestrator);
  }

  public async deployPartialPullPostIntentHookV2Mock(
    usdc: Address,
    orchestrator: Address
  ): Promise<PartialPullPostIntentHookV2Mock> {
    return await new PartialPullPostIntentHookV2Mock__factory(this._deployerSigner).deploy(usdc, orchestrator);
  }

  public async deployPushPostIntentHookV2Mock(
    usdc: Address,
    orchestrator: Address
  ): Promise<PushPostIntentHookV2Mock> {
    return await new PushPostIntentHookV2Mock__factory(this._deployerSigner).deploy(usdc, orchestrator);
  }

  public async deployReentrantPostIntentHookV2(
    usdc: Address,
    orchestrator: Address
  ): Promise<ReentrantPostIntentHookV2> {
    return await new ReentrantPostIntentHookV2__factory(this._deployerSigner).deploy(
      usdc,
      orchestrator
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

  public async deployReentrantSignalIntentCallerMock(
    orchestrator: Address
  ): Promise<ReentrantSignalIntentCallerMock> {
    return await new ReentrantSignalIntentCallerMock__factory(this._deployerSigner).deploy(orchestrator);
  }

  public async deployReentrantSignalIntentCallerV2Mock(
    orchestrator: Address
  ): Promise<ReentrantSignalIntentCallerV2Mock> {
    return await new ReentrantSignalIntentCallerV2Mock__factory(this._deployerSigner).deploy(orchestrator);
  }

  public async deployReentrantPreIntentHookMock(
    reentrantCaller: Address
  ): Promise<ReentrantPreIntentHookMock> {
    return await new ReentrantPreIntentHookMock__factory(this._deployerSigner).deploy(reentrantCaller);
  }

  public async deployReentrantOrchestratorMock(
    escrow: Address
  ): Promise<ReentrantOrchestratorMock> {
    return await new ReentrantOrchestratorMock__factory(this._deployerSigner).deploy(escrow);
  }
}
