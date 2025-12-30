import "module-alias/register";

import { BigNumber, Contract } from "ethers";
import { ethers } from "hardhat";

import DeployHelper from "@utils/deploys";
import { Account } from "@utils/test/types";
import { getAccounts, getWaffleExpect } from "@utils/test/index";
import { usdc, ether } from "@utils/common";
import { ADDRESS_ZERO, ONE_HOUR_IN_SECONDS } from "@utils/constants";

const expect = getWaffleExpect();

const RELAY_QUOTE_AUTH_TYPES = {
  RelayQuoteAuthorization: [
    { name: "intentDigest", type: "bytes32" },
    { name: "intentHash", type: "bytes32" },
    { name: "orderId", type: "bytes32" },
    { name: "quoteExpiration", type: "uint256" },
    { name: "paymentChainId", type: "uint256" },
    { name: "paymentDepository", type: "address" },
    { name: "paymentCurrency", type: "address" },
    { name: "paymentAmount", type: "uint256" },
    { name: "destinationChainId", type: "uint256" },
    { name: "destinationCurrency", type: "address" },
    { name: "recipient", type: "address" },
    { name: "refundTo", type: "address" },
    { name: "slippageBps", type: "uint16" }
  ]
};

describe("RelayBridgeHook", () => {
  let owner: Account;
  let orchestrator: Account;
  let trustedSigner: Account;
  let recipient: Account;
  let attacker: Account;

  let deployer: DeployHelper;
  let usdcToken: Contract;
  let depository: Contract;
  let hook: Contract;

  let chainId: number;

  beforeEach(async () => {
    [owner, orchestrator, trustedSigner, recipient, attacker] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);
    usdcToken = await deployer.deployUSDCMock(usdc(1_000_000), "USDC", "USDC");

    const RelayDepositoryMock = await ethers.getContractFactory("RelayDepositoryMock", owner.wallet);
    depository = await RelayDepositoryMock.deploy();

    const RelayBridgeHook = await ethers.getContractFactory("RelayBridgeHook", owner.wallet);
    hook = await RelayBridgeHook.deploy(
      usdcToken.address,
      orchestrator.address,
      depository.address,
      trustedSigner.address
    );

    const network = await ethers.provider.getNetwork();
    chainId = network.chainId;

    await usdcToken.transfer(orchestrator.address, usdc(1000));
  });

  const encodeCommitment = (commitment: any): string => {
    return ethers.utils.defaultAbiCoder.encode(
      ["tuple(uint256 destinationChainId,address destinationCurrency,address recipient,uint16 maxSlippageBps,address refundTo)"],
      [commitment]
    );
  };

  const buildIntent = async (commitmentData: string): Promise<any> => {
    const latestBlock = await ethers.provider.getBlock("latest");
    const paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
    const fiatCurrency = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
    const payeeId = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("payee"));

    return {
      owner: owner.address,
      to: recipient.address,
      escrow: owner.address,
      depositId: BigNumber.from(1),
      amount: usdc(100),
      timestamp: BigNumber.from(latestBlock.timestamp),
      paymentMethod: paymentMethod,
      fiatCurrency: fiatCurrency,
      conversionRate: ether(1),
      payeeId: payeeId,
      referrer: ADDRESS_ZERO,
      referrerFee: BigNumber.from(0),
      postIntentHook: hook.address,
      data: commitmentData
    };
  };

  const hashIntent = (intent: any): string => {
    return ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "tuple(address owner,address to,address escrow,uint256 depositId,uint256 amount,uint256 timestamp,bytes32 paymentMethod,bytes32 fiatCurrency,uint256 conversionRate,bytes32 payeeId,address referrer,uint256 referrerFee,address postIntentHook,bytes data)"
        ],
        [intent]
      )
    );
  };

  const buildQuoteData = async (
    intent: any,
    commitment: any,
    amountNetFees: BigNumber,
    signer: Account,
    overrides: any = {}
  ): Promise<{ encoded: string; quote: any }> => {
    const intentDigest = hashIntent(intent);
    const intentHash = overrides.intentHash ?? ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const orderId = overrides.orderId ?? ethers.utils.hexlify(ethers.utils.randomBytes(32));
    const quoteExpiration = overrides.quoteExpiration ?? BigNumber.from(intent.timestamp).add(ONE_HOUR_IN_SECONDS);

    const payment = {
      chainId: overrides.paymentChainId ?? chainId,
      depository: overrides.paymentDepository ?? depository.address,
      currency: overrides.paymentCurrency ?? usdcToken.address,
      amount: overrides.paymentAmount ?? amountNetFees
    };

    const destinationChainId = overrides.destinationChainId ?? commitment.destinationChainId;
    const destinationCurrency = overrides.destinationCurrency ?? commitment.destinationCurrency;
    const recipientAddress = overrides.recipient ?? commitment.recipient;
    const refundTo = overrides.refundTo ?? commitment.refundTo;
    const slippageBps = overrides.slippageBps ?? commitment.maxSlippageBps;

    const domain = {
      name: "RelayBridgeHook",
      version: "1",
      chainId,
      verifyingContract: hook.address
    };

    const value = {
      intentDigest,
      intentHash,
      orderId,
      quoteExpiration,
      paymentChainId: payment.chainId,
      paymentDepository: payment.depository,
      paymentCurrency: payment.currency,
      paymentAmount: payment.amount,
      destinationChainId,
      destinationCurrency,
      recipient: recipientAddress,
      refundTo,
      slippageBps
    };

    const signature = await signer.wallet._signTypedData(domain, RELAY_QUOTE_AUTH_TYPES, value);

    const quote = {
      intentHash,
      orderId,
      payment,
      quoteExpiration,
      destinationChainId,
      destinationCurrency,
      recipient: recipientAddress,
      refundTo,
      slippageBps,
      signature
    };

    const encoded = ethers.utils.defaultAbiCoder.encode(
      ["tuple(bytes32 intentHash, bytes32 orderId, tuple(uint256 chainId,address depository,address currency,uint256 amount) payment, uint256 quoteExpiration, uint256 destinationChainId, address destinationCurrency, address recipient, address refundTo, uint16 slippageBps, bytes signature)"],
      [quote]
    );

    return { encoded, quote };
  };

  describe("#execute", () => {
    let commitment: any;
    let commitmentData: string;
    let intent: any;
    let amountNetFees: BigNumber;

    beforeEach(async () => {
      commitment = {
        destinationChainId: BigNumber.from(10),
        destinationCurrency: recipient.address,
        recipient: recipient.address,
        maxSlippageBps: 100,
        refundTo: recipient.address
      };

      commitmentData = encodeCommitment(commitment);
      intent = await buildIntent(commitmentData);
      amountNetFees = usdc(50);

      await usdcToken.connect(orchestrator.wallet).approve(hook.address, amountNetFees);
    });

    async function subject(encodedQuoteData: string): Promise<any> {
      return hook.connect(orchestrator.wallet).execute(intent, amountNetFees, encodedQuoteData);
    }

    it("should execute with a valid signed quote", async () => {
      const { encoded, quote } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner);

      const orchestratorBalanceBefore = await usdcToken.balanceOf(orchestrator.address);

      await expect(subject(encoded)).to.emit(hook, "RelayBridgeInitiated").withArgs(
        quote.intentHash,
        quote.orderId,
        amountNetFees,
        commitment.destinationChainId,
        commitment.destinationCurrency,
        commitment.recipient
      );

      const orchestratorBalanceAfter = await usdcToken.balanceOf(orchestrator.address);
      const hookBalance = await usdcToken.balanceOf(hook.address);
      const depositoryBalance = await usdcToken.balanceOf(depository.address);

      expect(orchestratorBalanceBefore.sub(orchestratorBalanceAfter)).to.eq(amountNetFees);
      expect(hookBalance).to.eq(0);
      expect(depositoryBalance).to.eq(amountNetFees);

      expect(await depository.lastId()).to.eq(quote.orderId);
      expect(await depository.lastDepositor()).to.eq(hook.address);
      expect(await depository.lastSender()).to.eq(hook.address);
    });

    it("should revert when caller is not orchestrator", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner);

      await expect(
        hook.connect(attacker.wallet).execute(intent, amountNetFees, encoded)
      ).to.be.revertedWithCustomError(hook, "UnauthorizedCaller");
    });

    it("should revert with an invalid signature", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, attacker);

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "InvalidSignature");
    });

    it("should revert when orderId is zero", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner, {
        orderId: ethers.constants.HashZero
      });

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "InvalidOrderId");
    });

    it("should revert when quote is expired", async () => {
      const expired = BigNumber.from(intent.timestamp).sub(1);
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner, {
        quoteExpiration: expired
      });

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "QuoteExpired");
    });

    it("should revert when destination chain mismatches commitment", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner, {
        destinationChainId: BigNumber.from(1)
      });

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "DestinationChainMismatch");
    });

    it("should revert when refundTo mismatches commitment", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner, {
        refundTo: attacker.address
      });

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "RefundAddressMismatch");
    });

    it("should revert when slippage exceeds commitment max", async () => {
      const { encoded } = await buildQuoteData(intent, commitment, amountNetFees, trustedSigner, {
        slippageBps: commitment.maxSlippageBps + 1
      });

      await expect(subject(encoded))
        .to.be.revertedWithCustomError(hook, "SlippageExceedsMax");
    });
  });
});
