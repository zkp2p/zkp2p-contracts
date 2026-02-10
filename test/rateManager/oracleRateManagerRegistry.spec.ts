import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { getWaffleExpect, getAccounts } from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

import {
  OracleRateManagerRegistry,
  IBaseRateManagerRegistry,
  AggregatorV3Mock,
} from "../../typechain";

const expect = getWaffleExpect();

describe("OracleRateManagerRegistry", () => {
  let owner: any;
  let manager: any;
  let feeRecipient: any;
  let other: any;

  let registry: OracleRateManagerRegistry;

  let paymentMethod: BytesLike;

  async function createRateManagerAndGetId(
    cfg?: Partial<IBaseRateManagerRegistry.RateManagerConfigStruct>
  ): Promise<string> {
    const tx = await registry.createRateManager({
      manager: cfg?.manager ?? manager.address,
      feeRecipient: cfg?.feeRecipient ?? feeRecipient.address,
      maxFee: cfg?.maxFee ?? ether(0.05),
      fee: cfg?.fee ?? ether(0.01),
      depositHook: cfg?.depositHook ?? ADDRESS_ZERO,
      name: cfg?.name ?? "name",
      uri: cfg?.uri ?? "uri",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
    return ev?.args?.rateManagerId as string;
  }

  beforeEach(async () => {
    [owner, manager, feeRecipient, other] = await getAccounts();
    registry = (await (
      await ethers.getContractFactory("OracleRateManagerRegistry", owner.wallet)
    ).deploy()) as OracleRateManagerRegistry;

    paymentMethod = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("venmo"));
  });

  describe("#getMinRate", () => {
    let rateManagerId: string;

    beforeEach(async () => {
      rateManagerId = await createRateManagerAndGetId({
        manager: manager.address,
        feeRecipient: feeRecipient.address,
        maxFee: ether(0.05),
        fee: ether(0),
        depositHook: ADDRESS_ZERO,
        name: "PeerOne",
        uri: "ipfs://peerone",
      });
    });

    it("returns 0 when tuple not configured", async () => {
      const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.USD);
      expect(min).to.eq(0);
    });

    describe("USD fixed-rate (feed = 0)", () => {
      beforeEach(async () => {
        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.USD,
          ADDRESS_ZERO,
          100, // 1%
          0,
          false
        );
      });

      it("returns 1.0 * (1 + spread) in preciseUnits", async () => {
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.USD);
        expect(min).to.eq(ether(1.01));
      });

      it("returns config via getOracleConfig", async () => {
        const cfg = await registry.getOracleConfig(rateManagerId, paymentMethod as any, Currency.USD);
        expect(cfg.isConfigured).to.eq(true);
        expect(cfg.feed).to.eq(ADDRESS_ZERO);
        expect(cfg.feedDecimals).to.eq(0);
        expect(cfg.spreadBps).to.eq(100);
        expect(cfg.maxStaleness).to.eq(0);
        expect(cfg.invert).to.eq(false);
      });
    });

    describe("EUR via EUR/USD feed inversion", () => {
      let feed: AggregatorV3Mock;

      beforeEach(async () => {
        // EUR/USD = 1.10 (USD per EUR), 8 decimals
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 110_000_000)) as AggregatorV3Mock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          feed.address,
          100, // 1%
          3600,
          true // invert -> EUR per USD
        );
      });

      it("returns inverted rate scaled to 1e18 with spread applied", async () => {
        // baseRate = 1e18 * 1e8 / 110000000 = 0.909090909...e18, then * 1.01
        const oneE26 = BigNumber.from(10).pow(26);
        const base = oneE26.add(110_000_000 - 1).div(110_000_000); // ceil(1e26/110000000)
        const expected = base.mul(10_000 + 100).add(10_000 - 1).div(10_000); // ceil(base * 10100 / 10000)
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(expected);
      });

      it("returns 0 when stale", async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        // updatedAt older than maxStaleness
        await feed.setRoundData(1, 110_000_000, now - 10_000, now - 10_000, 1);
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });

      it("returns 0 when updatedAt is 0", async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 110_000_000, now, 0, 1);
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });

      it("returns 0 when answer <= 0", async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 0, now, now, 1);
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });

      it("returns 0 when answeredInRound < roundId", async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(2, 110_000_000, now, now, 1);
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });

      it("returns config via getOracleConfig", async () => {
        const cfg = await registry.getOracleConfig(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(cfg.isConfigured).to.eq(true);
        expect(cfg.feed).to.eq(feed.address);
        expect(cfg.feedDecimals).to.eq(8);
        expect(cfg.spreadBps).to.eq(100);
        expect(cfg.maxStaleness).to.eq(3600);
        expect(cfg.invert).to.eq(true);
      });
    });

    describe("Non-inverted feed (covers non-invert math path)", () => {
      let feed: AggregatorV3Mock;

      beforeEach(async () => {
        // Feed answer 0.90 with 8 decimals
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 90_000_000)) as AggregatorV3Mock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          feed.address,
          100, // 1%
          3600,
          false
        );
      });

      it("scales answer to 1e18 and applies spread", async () => {
        // baseRate = 0.9e18, min = 0.9e18 * 1.01 = 0.909e18
        const expectedBase = ether(0.9);
        const expected = expectedBase.mul(10_000 + 100).add(10_000 - 1).div(10_000); // ceil(base * 10100 / 10000)
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(expected);
      });
    });

    describe("Defensive misconfiguration: feed=0 for non-USD currency", () => {
      beforeEach(async () => {
        // Configure USD tuple (this is the only allowed feed=0 config via setter).
        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.USD,
          ADDRESS_ZERO,
          100,
          0,
          false
        );
      });

      it("returns 0 (pair disabled) rather than reverting", async () => {
        // Simulate a corrupted storage entry for (rateManagerId, paymentMethod, EUR) by copying the USD tuple's slot.
        // This hits the defensive `currency != USD` branch inside _getBaseRate.
        const ORACLE_CONFIGS_SLOT = 2; // after BaseRateManagerRegistry's nextId (slot 0) and rateManagers mapping (slot 1)

        const level1 = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [rateManagerId, ORACLE_CONFIGS_SLOT])
        );
        const level2 = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [paymentMethod, BigNumber.from(level1)])
        );
        const usdSlot = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [Currency.USD, BigNumber.from(level2)])
        );
        const eurSlot = ethers.utils.keccak256(
          ethers.utils.defaultAbiCoder.encode(["bytes32", "uint256"], [Currency.EUR, BigNumber.from(level2)])
        );

        const usdValue = await ethers.provider.getStorageAt(registry.address, usdSlot);
        await ethers.provider.send("hardhat_setStorageAt", [registry.address, eurSlot, usdValue]);

        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });
    });
  });

  describe("#setOracleConfig", () => {
    let rateManagerId: string;
    let subjectPaymentMethod: BytesLike;
    let subjectCurrency: BytesLike;
    let subjectFeed: string;
    let subjectSpreadBps: number;
    let subjectMaxStaleness: number;
    let subjectInvert: boolean;
    let subjectCaller: any;

    async function subject() {
      return registry.connect(subjectCaller.wallet).setOracleConfig(
        rateManagerId,
        subjectPaymentMethod as any,
        subjectCurrency as any,
        subjectFeed,
        subjectSpreadBps,
        subjectMaxStaleness,
        subjectInvert
      );
    }

    beforeEach(async () => {
      rateManagerId = await createRateManagerAndGetId({ manager: manager.address, feeRecipient: feeRecipient.address, fee: 0 });
      subjectCaller = manager;
      subjectPaymentMethod = paymentMethod;
      subjectCurrency = Currency.USD;
      subjectFeed = ADDRESS_ZERO;
      subjectSpreadBps = 100;
      subjectMaxStaleness = 0;
      subjectInvert = false;
    });

    describe("reverts when caller is not manager", () => {
      beforeEach(async () => {
        subjectCaller = other;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Caller is not manager");
      });
    });

    describe("reverts when payment method is zero", () => {
      beforeEach(async () => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid payment method");
      });
    });

    describe("reverts when currency is zero", () => {
      beforeEach(async () => {
        subjectCurrency = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid currency");
      });
    });

    describe("reverts when spread > 100%", () => {
      beforeEach(async () => {
        subjectSpreadBps = 10_001;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid spread");
      });
    });

    describe("reverts when feed is zero for non-USD currency", () => {
      beforeEach(async () => {
        subjectCurrency = Currency.EUR;
        subjectFeed = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid feed");
      });
    });

    describe("reverts when maxStaleness is 0 for non-zero feed", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 110_000_000)) as AggregatorV3Mock;
        subjectCurrency = Currency.EUR;
        subjectFeed = feed.address;
        subjectMaxStaleness = 0;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid staleness");
      });
    });

    describe("reverts when feed decimals > 18", () => {
      beforeEach(async () => {
        const feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(19, 1)) as AggregatorV3Mock;
        subjectCurrency = Currency.EUR;
        subjectFeed = feed.address;
        subjectMaxStaleness = 3600;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unsupported decimals");
      });
    });
  });
});
