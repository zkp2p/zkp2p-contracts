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
  });
});

