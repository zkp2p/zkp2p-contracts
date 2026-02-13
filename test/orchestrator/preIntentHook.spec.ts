import "module-alias/register";

import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import DeployHelper from "@utils/deploys";
import { ether, usdc } from "@utils/common";
import { Currency } from "@utils/protocolUtils";
import { Account } from "@utils/test/types";
import { ADDRESS_ZERO, ONE, ZERO } from "@utils/constants";
import { getAccounts, getWaffleExpect } from "@utils/test";
import { createSignalIntentParams } from "@utils/test/helpers";
import {
  Escrow,
  Orchestrator,
  PaymentVerifierRegistry,
  RelayerRegistry,
  EscrowRegistry,
  USDCMock,
  PaymentVerifierMock,
  PreIntentHookMock,
  SignatureGatingPreIntentHook,
} from "@utils/contracts";

const expect = getWaffleExpect();

describe("Orchestrator - PreIntentHook", () => {
  let owner: Account;
  let depositor: Account;
  let delegate: Account;
  let taker: Account;
  let unauthorizedCaller: Account;
  let feeRecipient: Account;

  let deployer: DeployHelper;

  let usdcToken: USDCMock;
  let escrow: Escrow;
  let orchestrator: Orchestrator;
  let paymentVerifierRegistry: PaymentVerifierRegistry;
  let relayerRegistry: RelayerRegistry;
  let escrowRegistry: EscrowRegistry;
  let verifier: PaymentVerifierMock;
  let preIntentHookMock: PreIntentHookMock;
  let signatureGatingPreIntentHook: SignatureGatingPreIntentHook;

  let chainId: BigNumber;
  let venmoPaymentMethod: BytesLike;
  let depositConversionRate: BigNumber;

  beforeEach(async () => {
    [owner, depositor, delegate, taker, unauthorizedCaller, feeRecipient] = await getAccounts();

    chainId = ONE;
    depositConversionRate = ether(1.01);
    venmoPaymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));

    deployer = new DeployHelper(owner.wallet);

    usdcToken = await deployer.deployUSDCMock(usdc(1000000000), "USDC", "USDC");
    await usdcToken.transfer(depositor.address, usdc(10000));

    escrowRegistry = await deployer.deployEscrowRegistry();
    paymentVerifierRegistry = await deployer.deployPaymentVerifierRegistry();
    relayerRegistry = await deployer.deployRelayerRegistry();

    escrow = await deployer.deployEscrow(
      owner.address,
      chainId,
      paymentVerifierRegistry.address,
      ADDRESS_ZERO,
      ZERO,
      BigNumber.from(10),
      BigNumber.from(60 * 60)
    );
    await escrowRegistry.addEscrow(escrow.address);

    orchestrator = await deployer.deployOrchestrator(
      owner.address,
      chainId,
      escrowRegistry.address,
      paymentVerifierRegistry.address,
      relayerRegistry.address,
      ZERO,
      feeRecipient.address
    );
    await escrow.connect(owner.wallet).setOrchestrator(orchestrator.address);

    verifier = await deployer.deployPaymentVerifierMock();
    await verifier.connect(owner.wallet).setVerificationContext(orchestrator.address, escrow.address);

    await paymentVerifierRegistry.addPaymentMethod(
      venmoPaymentMethod,
      verifier.address,
      [Currency.USD]
    );

    preIntentHookMock = await deployer.deployPreIntentHookMock();
    signatureGatingPreIntentHook = await deployer.deploySignatureGatingPreIntentHook(orchestrator.address);

    await usdcToken.connect(depositor.wallet).approve(escrow.address, usdc(10000));
    await escrow.connect(depositor.wallet).createDeposit({
      token: usdcToken.address,
      amount: usdc(100),
      intentAmountRange: { min: usdc(10), max: usdc(200) },
      paymentMethods: [venmoPaymentMethod],
      paymentMethodData: [
        {
          intentGatingService: ADDRESS_ZERO,
          payeeDetails: ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payeeDetails")),
          data: "0x",
        },
      ],
      currencies: [[{ code: Currency.USD, minConversionRate: depositConversionRate }]],
      delegate: delegate.address,
      intentGuardian: ADDRESS_ZERO,
      retainOnEmpty: false,
    });
  });

  describe("#setDepositPreIntentHook", () => {
    let subjectCaller: Account;
    let subjectEscrow: string;
    let subjectDepositId: BigNumber;
    let subjectHook: string;

    async function subject(): Promise<any> {
      return orchestrator.connect(subjectCaller.wallet).setDepositPreIntentHook(
        subjectEscrow,
        subjectDepositId,
        subjectHook
      );
    }

    beforeEach(async () => {
      subjectCaller = depositor;
      subjectEscrow = escrow.address;
      subjectDepositId = ZERO;
      subjectHook = preIntentHookMock.address;
    });

    it("allows depositor to set a pre-intent hook", async () => {
      await expect(subject()).to.emit(orchestrator, "DepositPreIntentHookSet")
        .withArgs(subjectEscrow, subjectDepositId, subjectHook, subjectCaller.address);

      const storedHook = await orchestrator.getDepositPreIntentHook(subjectEscrow, subjectDepositId);
      expect(storedHook).to.eq(subjectHook);
    });

    it("allows delegate to set a pre-intent hook", async () => {
      subjectCaller = delegate;

      await expect(subject()).to.emit(orchestrator, "DepositPreIntentHookSet")
        .withArgs(subjectEscrow, subjectDepositId, subjectHook, subjectCaller.address);

      const storedHook = await orchestrator.getDepositPreIntentHook(subjectEscrow, subjectDepositId);
      expect(storedHook).to.eq(subjectHook);
    });

    it("reverts for unauthorized caller", async () => {
      subjectCaller = unauthorizedCaller;

      await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
    });

    it("removes a pre-intent hook when set to zero address", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        subjectEscrow,
        subjectDepositId,
        preIntentHookMock.address
      );

      subjectHook = ADDRESS_ZERO;

      await expect(subject()).to.emit(orchestrator, "DepositPreIntentHookSet")
        .withArgs(subjectEscrow, subjectDepositId, ADDRESS_ZERO, subjectCaller.address);

      const storedHook = await orchestrator.getDepositPreIntentHook(subjectEscrow, subjectDepositId);
      expect(storedHook).to.eq(ADDRESS_ZERO);
    });

    describe("when hook is an EOA", () => {
      beforeEach(async () => {
        subjectHook = unauthorizedCaller.address;
      });

      it("reverts with InvalidPreIntentHook", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "InvalidPreIntentHook");
      });
    });

    describe("when deposit does not exist", () => {
      beforeEach(async () => {
        subjectDepositId = ONE;
      });

      it("reverts with UnauthorizedCallerOrDelegate", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "UnauthorizedCallerOrDelegate");
      });
    });

    describe("when escrow is zero address", () => {
      beforeEach(async () => {
        subjectEscrow = ADDRESS_ZERO;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWithCustomError(orchestrator, "ZeroAddress");
      });
    });
  });

  describe("#signalIntent (pre-intent hook)", () => {
    let subjectCaller: Account;
    let subjectConversionRate: BigNumber;
    let subjectPreIntentHookData: string;
    let subjectData: string;

    async function subject(): Promise<any> {
      const params = await createSignalIntentParams(
        orchestrator.address,
        escrow.address,
        ZERO,
        usdc(50),
        taker.address,
        venmoPaymentMethod,
        Currency.USD,
        subjectConversionRate,
        ADDRESS_ZERO,
        ZERO,
        null,
        chainId.toString(),
        ADDRESS_ZERO,
        subjectData,
        undefined,
        subjectPreIntentHookData
      );

      return orchestrator.connect(subjectCaller.wallet).signalIntent(params);
    }

    beforeEach(async () => {
      subjectCaller = taker;
      subjectConversionRate = ether(1.02);
      subjectPreIntentHookData = ethers.utils.defaultAbiCoder.encode(["uint256"], [7]);
      subjectData = ethers.utils.defaultAbiCoder.encode(["uint256"], [42]);
    });

    it("passes preIntentHookData to pre-hook and does not store it on intent", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        preIntentHookMock.address
      );

      const tx = await subject();
      const receipt = await tx.wait();
      const intentHash = receipt.events?.find((e: any) => e.event === "IntentSignaled")?.args?.intentHash;

      expect(intentHash).to.not.eq(undefined);
      const intent = await orchestrator.getIntent(intentHash);

      expect(await preIntentHookMock.callCount()).to.eq(1);
      expect(await preIntentHookMock.lastTaker()).to.eq(taker.address);
      expect(await preIntentHookMock.lastEscrow()).to.eq(escrow.address);
      expect(await preIntentHookMock.lastDepositId()).to.eq(ZERO);
      expect(await preIntentHookMock.lastPreIntentHookData()).to.eq(subjectPreIntentHookData);

      expect(intent.data).to.eq(subjectData);
      expect(intent.data).to.not.eq(subjectPreIntentHookData);
    });

    it("reverts when pre-intent hook rejects", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        preIntentHookMock.address
      );
      await preIntentHookMock.setShouldRevert(true);

      await expect(subject()).to.be.revertedWith("PreIntentHookMock: rejected");

      const accountIntents = await orchestrator.getAccountIntents(taker.address);
      expect(accountIntents.length).to.eq(0);
    });

    it("works normally when no pre-intent hook is set", async () => {
      await expect(subject()).to.emit(orchestrator, "IntentSignaled");

      const accountIntents = await orchestrator.getAccountIntents(taker.address);
      expect(accountIntents.length).to.eq(1);
      expect(await preIntentHookMock.callCount()).to.eq(0);
    });

    it("skips hook execution after hook removal", async () => {
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        preIntentHookMock.address
      );
      await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
        escrow.address,
        ZERO,
        ADDRESS_ZERO
      );

      await expect(subject()).to.emit(orchestrator, "IntentSignaled");
      expect(await preIntentHookMock.callCount()).to.eq(0);
    });
  });

  describe("SignatureGatingPreIntentHook", () => {
    describe("#constructor", () => {
      it("reverts when orchestrator is zero address", async () => {
        await expect(
          deployer.deploySignatureGatingPreIntentHook(ADDRESS_ZERO)
        ).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "ZeroAddress");
      });
    });

    describe("#setDepositSigner", () => {
      let subjectCaller: Account;
      let subjectEscrow: string;
      let subjectSigner: string;

      async function subject(): Promise<any> {
        return signatureGatingPreIntentHook.connect(subjectCaller.wallet).setDepositSigner(
          subjectEscrow,
          ZERO,
          subjectSigner
        );
      }

      beforeEach(async () => {
        subjectCaller = depositor;
        subjectEscrow = escrow.address;
        subjectSigner = delegate.address;
      });

      it("allows depositor to set signer per deposit", async () => {
        await expect(subject()).to.emit(signatureGatingPreIntentHook, "DepositSignerSet")
          .withArgs(escrow.address, ZERO, subjectSigner, subjectCaller.address);

        const storedSigner = await signatureGatingPreIntentHook.getDepositSigner(escrow.address, ZERO);
        expect(storedSigner).to.eq(subjectSigner);
      });

      it("allows delegate to set signer per deposit", async () => {
        subjectCaller = delegate;
        subjectSigner = owner.address;

        await expect(subject()).to.emit(signatureGatingPreIntentHook, "DepositSignerSet")
          .withArgs(escrow.address, ZERO, subjectSigner, subjectCaller.address);

        const storedSigner = await signatureGatingPreIntentHook.getDepositSigner(escrow.address, ZERO);
        expect(storedSigner).to.eq(subjectSigner);
      });

      describe("when called by unauthorized caller", () => {
        beforeEach(async () => {
          subjectCaller = unauthorizedCaller;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(
            signatureGatingPreIntentHook,
            "UnauthorizedCallerOrDelegate"
          );
        });
      });

      describe("when escrow is zero address", () => {
        beforeEach(async () => {
          subjectEscrow = ADDRESS_ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(
            signatureGatingPreIntentHook,
            "ZeroAddress"
          );
        });
      });
    });

    describe("#validateSignalIntent via signalIntent", () => {
      let subjectCaller: Account;
      let subjectTo: string;
      let subjectConversionRate: BigNumber;
      let subjectSignatureSigner: Account;
      let subjectSignatureExpiration: BigNumber;
      let subjectPreIntentHookData: string;
      let subjectData: string;

      async function generateSignature(
        signer: Account,
        signatureExpiration: BigNumber
      ): Promise<string> {
        const messageHash = ethers.utils.solidityKeccak256(
          [
            "address",
            "address",
            "uint256",
            "uint256",
            "address",
            "address",
            "bytes32",
            "bytes32",
            "uint256",
            "uint256",
            "uint256",
          ],
          [
            orchestrator.address,
            escrow.address,
            ZERO,
            usdc(50),
            subjectCaller.address,
            subjectTo,
            venmoPaymentMethod,
            Currency.USD,
            subjectConversionRate,
            signatureExpiration,
            chainId,
          ]
        );

        return signer.wallet.signMessage(ethers.utils.arrayify(messageHash));
      }

      async function subject(): Promise<any> {
        const params = await createSignalIntentParams(
          orchestrator.address,
          escrow.address,
          ZERO,
          usdc(50),
          subjectTo,
          venmoPaymentMethod,
          Currency.USD,
          subjectConversionRate,
          ADDRESS_ZERO,
          ZERO,
          null,
          chainId.toString(),
          ADDRESS_ZERO,
          subjectData,
          undefined,
          subjectPreIntentHookData
        );

        return orchestrator.connect(subjectCaller.wallet).signalIntent(params);
      }

      beforeEach(async () => {
        subjectCaller = taker;
        subjectTo = taker.address;
        subjectConversionRate = ether(1.02);
        subjectSignatureSigner = delegate;
        subjectData = ethers.utils.defaultAbiCoder.encode(["string"], ["post-intent-signal-data"]);

        await signatureGatingPreIntentHook.connect(depositor.wallet).setDepositSigner(
          escrow.address,
          ZERO,
          subjectSignatureSigner.address
        );
        await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
          escrow.address,
          ZERO,
          signatureGatingPreIntentHook.address
        );

        subjectSignatureExpiration = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp).add(3600);
        const signature = await generateSignature(subjectSignatureSigner, subjectSignatureExpiration);
        subjectPreIntentHookData = ethers.utils.defaultAbiCoder.encode(
          ["bytes", "uint256"],
          [signature, subjectSignatureExpiration]
        );
      });

      it("accepts valid signature data", async () => {
        await expect(subject()).to.emit(orchestrator, "IntentSignaled");
      });

      describe("when signature is invalid", () => {
        beforeEach(async () => {
          const badSignature = await generateSignature(unauthorizedCaller, subjectSignatureExpiration);
          subjectPreIntentHookData = ethers.utils.defaultAbiCoder.encode(
            ["bytes", "uint256"],
            [badSignature, subjectSignatureExpiration]
          );
        });

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "InvalidSignature");
        });
      });

      describe("when called directly (not via orchestrator)", () => {
        it("should revert", async () => {
          const dummyCtx = {
            taker: taker.address,
            escrow: escrow.address,
            depositId: ZERO,
            amount: usdc(50),
            to: taker.address,
            paymentMethod: venmoPaymentMethod,
            fiatCurrency: Currency.USD,
            conversionRate: subjectConversionRate,
            referrer: ADDRESS_ZERO,
            referrerFee: ZERO,
            preIntentHookData: "0x",
          };

          await expect(
            signatureGatingPreIntentHook.connect(taker.wallet).validateSignalIntent(dummyCtx)
          ).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "UnauthorizedOrchestratorCaller");
        });
      });

      describe("when signer is not set for deposit", () => {
        beforeEach(async () => {
          // Deploy a fresh hook with no signers configured
          const freshHook = await deployer.deploySignatureGatingPreIntentHook(orchestrator.address);
          await orchestrator.connect(depositor.wallet).setDepositPreIntentHook(
            escrow.address,
            ZERO,
            freshHook.address
          );
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "SignerNotSet");
        });
      });

      describe("when caller differs from signed taker", () => {
        beforeEach(async () => {
          const signatureForTaker = await generateSignature(subjectSignatureSigner, subjectSignatureExpiration);
          subjectPreIntentHookData = ethers.utils.defaultAbiCoder.encode(
            ["bytes", "uint256"],
            [signatureForTaker, subjectSignatureExpiration]
          );
          subjectCaller = unauthorizedCaller;
        });

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "InvalidSignature");
        });
      });

      describe("when signature is expired", () => {
        beforeEach(async () => {
          subjectSignatureExpiration = BigNumber.from((await ethers.provider.getBlock("latest")).timestamp).sub(1);
          const expiredSignature = await generateSignature(subjectSignatureSigner, subjectSignatureExpiration);
          subjectPreIntentHookData = ethers.utils.defaultAbiCoder.encode(
            ["bytes", "uint256"],
            [expiredSignature, subjectSignatureExpiration]
          );
        });

        it("reverts", async () => {
          await expect(subject()).to.be.revertedWithCustomError(signatureGatingPreIntentHook, "SignatureExpired");
        });
      });
    });
  });
});
