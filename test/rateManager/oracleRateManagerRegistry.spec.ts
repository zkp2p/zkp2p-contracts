import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber, BytesLike } from "ethers";

import { getWaffleExpect, getAccounts } from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/common";
import { Currency } from "@utils/protocolUtils";

import {
  AggregatorV3Mock,
  ChainlinkOracleAdapter,
  IBaseRateManagerRegistry,
  OracleRateManagerRegistry,
  RevertingOracleAdapterMock,
  StaticOracleAdapterMock,
} from "../../typechain";

const expect = getWaffleExpect();

describe("OracleRateManagerRegistry", () => {
  // Accounts
  let owner: any;
  let manager: any;
  let feeRecipient: any;
  let other: any;

  // Contracts
  let registry: OracleRateManagerRegistry;
  let chainlinkAdapter: ChainlinkOracleAdapter;

  let paymentMethod: BytesLike;

  function encodeChainlinkRawConfig(feed: string, invert: boolean): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "bool"], [feed, invert]);
  }

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

    chainlinkAdapter = (await (
      await ethers.getContractFactory("ChainlinkOracleAdapter", owner.wallet)
    ).deploy()) as ChainlinkOracleAdapter;

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

    describe("USD via Chainlink adapter (direct quote)", () => {
      let feed: AggregatorV3Mock;

      beforeEach(async () => {
        // USD per token = 1.00, 8 decimals
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 100_000_000)) as AggregatorV3Mock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.USD,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100, // 1%
          3600
        );
      });

      it("returns marketRate * (1 + spread) in preciseUnits", async () => {
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.USD);
        expect(min).to.eq(ether(1.01));
      });

      it("returns config via getOracleConfig", async () => {
        const cfg = await registry.getOracleConfig(rateManagerId, paymentMethod as any, Currency.USD);
        expect(cfg.isConfigured).to.eq(true);
        expect(cfg.adapter).to.eq(chainlinkAdapter.address);
        expect(cfg.spreadBps).to.eq(100);
        expect(cfg.maxStaleness).to.eq(3600);

        // adapterConfig = abi.encodePacked(feed, decimals, invertFlag)
        expect(cfg.adapterConfig).to.have.length(2 + 22 * 2);
        const packedFeed = ethers.utils.getAddress("0x" + cfg.adapterConfig.slice(2, 42));
        const decimals = BigNumber.from("0x" + cfg.adapterConfig.slice(42, 44)).toNumber();
        const invertFlag = BigNumber.from("0x" + cfg.adapterConfig.slice(44, 46)).toNumber();
        expect(packedFeed).to.eq(feed.address);
        expect(decimals).to.eq(8);
        expect(invertFlag).to.eq(0);
      });
    });

    describe("EUR via EUR/USD feed inversion", () => {
      let feed: AggregatorV3Mock;

      beforeEach(async () => {
        // EUR/USD = 1.10 (USD per EUR), 8 decimals. Invert -> EUR per USD.
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(8, 110_000_000)) as AggregatorV3Mock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, true),
          100, // 1%
          3600
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

      it("returns 0 when updatedAt is in the future", async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 110_000_000, now, now + 60, 1);
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
        expect(cfg.adapter).to.eq(chainlinkAdapter.address);
        expect(cfg.spreadBps).to.eq(100);
        expect(cfg.maxStaleness).to.eq(3600);

        const packedFeed = ethers.utils.getAddress("0x" + cfg.adapterConfig.slice(2, 42));
        const decimals = BigNumber.from("0x" + cfg.adapterConfig.slice(42, 44)).toNumber();
        const invertFlag = BigNumber.from("0x" + cfg.adapterConfig.slice(44, 46)).toNumber();
        expect(packedFeed).to.eq(feed.address);
        expect(decimals).to.eq(8);
        expect(invertFlag).to.eq(1);
      });
    });

    describe("Non-inverted feed (covers direct math path)", () => {
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
          chainlinkAdapter.address,
          encodeChainlinkRawConfig(feed.address, false),
          100, // 1%
          3600
        );
      });

      it("scales answer to 1e18 and applies spread", async () => {
        const expectedBase = ether(0.9);
        const expected = expectedBase.mul(10_000 + 100).add(10_000 - 1).div(10_000); // ceil(base * 10100 / 10000)

        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(expected);
      });
    });

    describe("when adapter reverts", () => {
      let adapter: RevertingOracleAdapterMock;

      beforeEach(async () => {
        adapter = (await (
          await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
        ).deploy()) as RevertingOracleAdapterMock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          adapter.address,
          "0x",
          100,
          3600
        );
      });

      it("returns 0 (pair disabled) rather than reverting", async () => {
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });
    });

    describe("when adapter returns updatedAt = 0 but marks quote valid (defensive)", () => {
      let adapter: StaticOracleAdapterMock;

      beforeEach(async () => {
        adapter = (await (
          await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
        ).deploy()) as StaticOracleAdapterMock;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          adapter.address,
          ethers.utils.defaultAbiCoder.encode(["bool", "uint256", "uint256"], [true, ether(1), 0]),
          100,
          3600
        );
      });

      it("returns 0", async () => {
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });
    });

    describe("when adapter returns rate = 0 but marks quote valid (defensive)", () => {
      let adapter: StaticOracleAdapterMock;

      beforeEach(async () => {
        adapter = (await (
          await ethers.getContractFactory("StaticOracleAdapterMock", owner.wallet)
        ).deploy()) as StaticOracleAdapterMock;

        const now = (await ethers.provider.getBlock("latest")).timestamp;

        await registry.connect(manager.wallet).setOracleConfig(
          rateManagerId,
          paymentMethod as any,
          Currency.EUR,
          adapter.address,
          ethers.utils.defaultAbiCoder.encode(["bool", "uint256", "uint256"], [true, 0, now]),
          100,
          3600
        );
      });

      it("returns 0", async () => {
        const min = await registry.getMinRate(rateManagerId, paymentMethod as any, Currency.EUR);
        expect(min).to.eq(0);
      });
    });
  });

  describe("#setOracleConfig", () => {
    let rateManagerId: string;
    let feed: AggregatorV3Mock;

    let subjectPaymentMethod: BytesLike;
    let subjectCurrency: BytesLike;
    let subjectAdapter: string;
    let subjectRawAdapterConfig: string;
    let subjectSpreadBps: number;
    let subjectMaxStaleness: number;
    let subjectCaller: any;

    async function subject() {
      return registry.connect(subjectCaller.wallet).setOracleConfig(
        rateManagerId,
        subjectPaymentMethod as any,
        subjectCurrency as any,
        subjectAdapter,
        subjectRawAdapterConfig,
        subjectSpreadBps,
        subjectMaxStaleness
      );
    }

    beforeEach(async () => {
      rateManagerId = await createRateManagerAndGetId({ manager: manager.address, feeRecipient: feeRecipient.address, fee: 0 });

      feed = (await (
        await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
      ).deploy(8, 100_000_000)) as AggregatorV3Mock;

      subjectCaller = manager;
      subjectPaymentMethod = paymentMethod;
      subjectCurrency = Currency.USD;
      subjectAdapter = chainlinkAdapter.address;
      subjectRawAdapterConfig = encodeChainlinkRawConfig(feed.address, false);
      subjectSpreadBps = 100;
      subjectMaxStaleness = 3600;
    });

    describe("reverts when caller is not manager", () => {
      beforeEach(() => {
        subjectCaller = other;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Caller is not manager");
      });
    });

    describe("reverts when payment method is zero", () => {
      beforeEach(() => {
        subjectPaymentMethod = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid payment method");
      });
    });

    describe("reverts when currency is zero", () => {
      beforeEach(() => {
        subjectCurrency = ethers.constants.HashZero;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid currency");
      });
    });

    describe("reverts when adapter is zero", () => {
      beforeEach(() => {
        subjectAdapter = ADDRESS_ZERO;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid adapter");
      });
    });

    describe("reverts when adapter is not a contract", () => {
      beforeEach(() => {
        subjectAdapter = other.address; // EOA
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid adapter");
      });
    });

    describe("reverts when spread > 100%", () => {
      beforeEach(() => {
        subjectSpreadBps = 10_001;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid spread");
      });
    });

    describe("reverts when maxStaleness is 0", () => {
      beforeEach(() => {
        subjectMaxStaleness = 0;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid staleness");
      });
    });

    describe("reverts when adapter config is invalid (feed is zero)", () => {
      beforeEach(() => {
        subjectRawAdapterConfig = encodeChainlinkRawConfig(ADDRESS_ZERO, false);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid feed");
      });
    });

    describe("reverts when adapter rejects (unsupported decimals)", () => {
      beforeEach(async () => {
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(19, 1)) as AggregatorV3Mock;
        subjectRawAdapterConfig = encodeChainlinkRawConfig(feed.address, false);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unsupported decimals");
      });
    });

    describe("reverts when normalized adapter config is too long", () => {
      let adapter: RevertingOracleAdapterMock;

      beforeEach(async () => {
        adapter = (await (
          await ethers.getContractFactory("RevertingOracleAdapterMock", owner.wallet)
        ).deploy()) as RevertingOracleAdapterMock;

        subjectAdapter = adapter.address;
        subjectRawAdapterConfig = ethers.utils.hexlify(new Uint8Array(257).fill(0x11));
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Config too long");
      });
    });
  });
});
