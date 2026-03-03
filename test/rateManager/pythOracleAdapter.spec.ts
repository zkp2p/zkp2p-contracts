import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { getWaffleExpect, getAccounts } from "@utils/test";
import { ether } from "@utils/common";

import { PythMock, PythOracleAdapter } from "../../typechain";

const expect = getWaffleExpect();

describe("PythOracleAdapter", () => {
  let owner: any;

  let adapter: PythOracleAdapter;
  let pythMock: PythMock;

  const FEED_ID = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD/INR"));

  function encodeRawConfig(feedId: string, invert: boolean): string {
    return ethers.utils.defaultAbiCoder.encode(["bytes32", "bool"], [feedId, invert]);
  }

  beforeEach(async () => {
    [owner] = await getAccounts();

    pythMock = (await (
      await ethers.getContractFactory("PythMock", owner.wallet)
    ).deploy()) as PythMock;

    adapter = (await (
      await ethers.getContractFactory("PythOracleAdapter", owner.wallet)
    ).deploy(pythMock.address)) as PythOracleAdapter;

    // Set a default price: USD/INR = 83.475 with expo=-5 → price=8347500
    const now = (await ethers.provider.getBlock("latest")).timestamp;
    await pythMock.setPrice(FEED_ID, 8347500, 100, -5, now);
  });

  describe("#validateConfig", () => {
    let subjectRawConfig: string;

    async function subject() {
      return adapter.validateConfig(subjectRawConfig);
    }

    beforeEach(() => {
      subjectRawConfig = encodeRawConfig(FEED_ID, false);
    });

    it("returns packed 34-byte normalized config with absExpo", async () => {
      const cfg = await subject();

      // normalizedConfig = abi.encodePacked(feedId(32B), absExpo(1B), invertFlag(1B))
      expect(cfg).to.have.length(2 + 34 * 2); // 0x + 68 hex chars
      const packedFeedId = "0x" + cfg.slice(2, 66);
      const absExpo = BigNumber.from("0x" + cfg.slice(66, 68)).toNumber();
      const invertFlag = BigNumber.from("0x" + cfg.slice(68, 70)).toNumber();
      expect(packedFeedId).to.eq(FEED_ID);
      expect(absExpo).to.eq(5); // abs(-5) = 5
      expect(invertFlag).to.eq(0);
    });

    it("returns config with invert=true", async () => {
      subjectRawConfig = encodeRawConfig(FEED_ID, true);
      const cfg = await subject();

      const invertFlag = BigNumber.from("0x" + cfg.slice(68, 70)).toNumber();
      expect(invertFlag).to.eq(1);
    });

    it("stores correct absExpo for expo=-8", async () => {
      const now = (await ethers.provider.getBlock("latest")).timestamp;
      await pythMock.setPrice(FEED_ID, 110000000, 100, -8, now);

      const cfg = await subject();
      const absExpo = BigNumber.from("0x" + cfg.slice(66, 68)).toNumber();
      expect(absExpo).to.eq(8);
    });

    describe("when feedId is bytes32(0)", () => {
      beforeEach(() => {
        subjectRawConfig = encodeRawConfig(ethers.constants.HashZero, false);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Zero feedId");
      });
    });

    describe("when feed doesn't exist in Pyth", () => {
      beforeEach(() => {
        const unknownFeed = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("UNKNOWN/FEED"));
        subjectRawConfig = encodeRawConfig(unknownFeed, false);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("feed not found");
      });
    });

    describe("when exponent > 0", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await pythMock.setPrice(FEED_ID, 100, 0, 1, now);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Unsupported exponent");
      });
    });

    describe("when exponent < -18", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await pythMock.setPrice(FEED_ID, 100, 0, -19, now);
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Unsupported exponent");
      });
    });
  });

  describe("#getRate", () => {
    let subjectNormalizedConfig: string;

    async function subject() {
      return adapter.getRate(subjectNormalizedConfig);
    }

    beforeEach(async () => {
      subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(FEED_ID, false));
    });

    it("returns direct rate in preciseUnits (83.475e18)", async () => {
      const res = await subject();
      expect(res.valid).to.eq(true);

      // price=8347500, expo=-5 → 8347500 * 1e18 / 1e5 = 83.475e18
      const expected = BigNumber.from(8347500).mul(BigNumber.from(10).pow(18)).div(BigNumber.from(10).pow(5));
      expect(res.rate).to.eq(expected);
      expect(res.updatedAt).to.be.gt(0);
    });

    describe("when invert is true", () => {
      beforeEach(async () => {
        subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(FEED_ID, true));
      });

      it("returns inverted rate (INR/USD)", async () => {
        const res = await subject();
        expect(res.valid).to.eq(true);

        // inverted = 1e18 * 1e5 / 8347500
        const oneE23 = BigNumber.from(10).pow(23);
        const expected = oneE23.add(8347500 - 1).div(8347500); // rounding up
        expect(res.rate).to.eq(expected);
        expect(res.updatedAt).to.be.gt(0);
      });
    });

    describe("with expo=-8", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        // EUR/USD = 1.10000000 with expo=-8
        await pythMock.setPrice(FEED_ID, 110000000, 100, -8, now);
        subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(FEED_ID, false));
      });

      it("returns correct rate scaled to 1e18", async () => {
        const res = await subject();
        expect(res.valid).to.eq(true);
        expect(res.rate).to.eq(ether(1.1));
      });
    });

    describe("with expo=-18", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        // price=1000000000000000000 with expo=-18 → rate = 1.0e18
        await pythMock.setPrice(FEED_ID, BigNumber.from(10).pow(18), 0, -18, now);
        subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(FEED_ID, false));
      });

      it("returns correct rate", async () => {
        const res = await subject();
        expect(res.valid).to.eq(true);
        expect(res.rate).to.eq(ether(1));
      });
    });

    describe("when price <= 0", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await pythMock.setPrice(FEED_ID, 0, 0, -5, now);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when price is negative", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await pythMock.setPrice(FEED_ID, -100, 0, -5, now);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when publishTime is 0", () => {
      beforeEach(async () => {
        await pythMock.setPrice(FEED_ID, 8347500, 100, -5, 0);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when Pyth reverts (feed removed)", () => {
      beforeEach(async () => {
        await pythMock.removePrice(FEED_ID);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when config length is invalid", () => {
      beforeEach(() => {
        subjectNormalizedConfig = "0x";
      });

      it("reverts", async () => {
        await expect(subject()).to.be.revertedWith("Invalid config");
      });
    });
  });
});
