import { expect } from "chai";
import { ContractFactory } from "ethers";
import hre, { artifacts, ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

const MAX_PROTOCOL_FEE = ethers.utils.parseEther("0.05");
const MIN_CALLBACK_GAS = 750_000;
const MAX_CALLBACK_GAS = 2_000_000;
const ZERO = ethers.constants.AddressZero;

describe("OrchestratorV3 constructor validation", () => {
  async function deployFixture() {
    const [owner, other] = await ethers.getSigners();
    const { chainId } = await ethers.provider.getNetwork();
    const boundedCall = await (await ethers.getContractFactory("BoundedCall")).deploy();
    const feeLib = await (await ethers.getContractFactory("OrchestratorV3FeeLib")).deploy();
    const postIntentHookExecutor = await (await ethers.getContractFactory("PostIntentHookExecutor")).deploy();
    const riskCallbackRecorder = await (await ethers.getContractFactory("RiskCallbackRecorder")).deploy();
    const riskLib = await (await ethers.getContractFactory("OrchestratorV3RiskLib", {
      libraries: {
        BoundedCall: boundedCall.address,
        RiskCallbackRecorder: riskCallbackRecorder.address,
      },
    })).deploy();
    const validation = await (await ethers.getContractFactory("OrchestratorV3Validation")).deploy();
    const escrowRegistry = await (await ethers.getContractFactory("EscrowRegistry")).deploy();
    const paymentVerifierRegistry = await (await ethers.getContractFactory("PaymentVerifierRegistry")).deploy();
    const relayerRegistry = await (await ethers.getContractFactory("RelayerRegistry")).deploy();
    const factory = await ethers.getContractFactory("OrchestratorV3", {
      libraries: {
        BoundedCall: boundedCall.address,
        OrchestratorV3FeeLib: feeLib.address,
        PostIntentHookExecutor: postIntentHookExecutor.address,
        OrchestratorV3RiskLib: riskLib.address,
        OrchestratorV3Validation: validation.address,
      },
    });

    const validArgs = [
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      MAX_PROTOCOL_FEE,
      owner.address,
      MIN_CALLBACK_GAS,
    ] as const;

    return { owner, other, chainId, factory, validArgs };
  }

  async function deployWith(factory: ContractFactory, args: readonly unknown[], index: number, value: unknown) {
    const changedArgs = [...args];
    changedArgs[index] = value;
    return factory.deploy(...changedArgs);
  }

  it("accepts the maximum supported protocol fee", async () => {
    const { factory, validArgs } = await loadFixture(deployFixture);
    const orchestrator = await factory.deploy(...validArgs);
    expect(await orchestrator.protocolFee()).to.eq(MAX_PROTOCOL_FEE);
  });

  it("rejects a protocol fee above the supported maximum", async () => {
    const { factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 5, MAX_PROTOCOL_FEE.add(1)))
      .to.be.revertedWithCustomError(factory, "FeeExceedsMaximum");
  });

  it("rejects a chain identifier other than the execution chain", async () => {
    const { chainId, factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 1, chainId + 1))
      .to.be.revertedWithCustomError(factory, "InvalidChainId");
  });

  it("rejects a zero registry dependency", async () => {
    const { factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 2, ZERO))
      .to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects a registry dependency without deployed code", async () => {
    const { other, factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 3, other.address))
      .to.be.revertedWithCustomError(factory, "InvalidContract");
  });

  it("rejects a zero protocol fee recipient", async () => {
    const { factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 6, ZERO))
      .to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("rejects a callback gas allowance above the reconciliation-safe maximum", async () => {
    const { factory, validArgs } = await loadFixture(deployFixture);
    await expect(deployWith(factory, validArgs, 7, MAX_CALLBACK_GAS + 1))
      .to.be.revertedWithCustomError(factory, "RiskCallbackGasLimitTooHigh")
      .withArgs(MAX_CALLBACK_GAS + 1, MAX_CALLBACK_GAS);
  });

  it("keeps deployed bytecode within the EIP-170 limit", async () => {
    if ((hre as any).__SOLIDITY_COVERAGE_RUNNING) return;
    await loadFixture(deployFixture);
    const artifact = await artifacts.readArtifact("OrchestratorV3");
    expect((artifact.deployedBytecode.length - 2) / 2).to.be.at.most(24_576);
  });
});
