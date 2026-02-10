import "module-alias/register";
import { ethers } from "hardhat";
import { BigNumber } from "ethers";

import { getWaffleExpect, getAccounts } from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/common";

import { AggregatorV3Mock, ChainlinkOracleAdapter } from "../../typechain";

const expect = getWaffleExpect();

describe("ChainlinkOracleAdapter", () => {
  // Accounts
  let owner: any;

  // Contracts
  let adapter: ChainlinkOracleAdapter;
  let feed: AggregatorV3Mock;

  function encodeRawConfig(feedAddress: string, invert: boolean): string {
    return ethers.utils.defaultAbiCoder.encode(["address", "bool"], [feedAddress, invert]);
  }

  beforeEach(async () => {
    [owner] = await getAccounts();

    adapter = (await (
      await ethers.getContractFactory("ChainlinkOracleAdapter", owner.wallet)
    ).deploy()) as ChainlinkOracleAdapter;

    feed = (await (
      await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
    ).deploy(8, 110_000_000)) as AggregatorV3Mock;
  });

  describe("#validateConfig", () => {
    let subjectRawConfig: string;

    async function subject() {
      return adapter.validateConfig(subjectRawConfig);
    }

    beforeEach(() => {
      subjectRawConfig = encodeRawConfig(feed.address, true);
    });

    it("returns packed normalized config", async () => {
      const cfg = await subject();

      // adapterConfig = abi.encodePacked(feed, decimals, invertFlag)
      expect(cfg).to.have.length(2 + 22 * 2);
      const packedFeed = ethers.utils.getAddress("0x" + cfg.slice(2, 42));
      const decimals = BigNumber.from("0x" + cfg.slice(42, 44)).toNumber();
      const invertFlag = BigNumber.from("0x" + cfg.slice(44, 46)).toNumber();
      expect(packedFeed).to.eq(feed.address);
      expect(decimals).to.eq(8);
      expect(invertFlag).to.eq(1);
    });

    describe("reverts when feed is zero", () => {
      beforeEach(() => {
        subjectRawConfig = encodeRawConfig(ADDRESS_ZERO, false);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid feed");
      });
    });

    describe("reverts when feed decimals > 18", () => {
      beforeEach(async () => {
        feed = (await (
          await ethers.getContractFactory("AggregatorV3Mock", owner.wallet)
        ).deploy(19, 1)) as AggregatorV3Mock;
        subjectRawConfig = encodeRawConfig(feed.address, false);
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Unsupported decimals");
      });
    });
  });

  describe("#getRate", () => {
    let subjectNormalizedConfig: string;

    async function subject() {
      return adapter.getRate(subjectNormalizedConfig);
    }

    beforeEach(async () => {
      subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(feed.address, true));
    });

    it("returns inverted rate in preciseUnits and updatedAt", async () => {
      const res = await subject();
      expect(res.valid).to.eq(true);

      // baseRate = 1e18 * 1e8 / 110000000 = 0.909090909...e18
      const oneE26 = BigNumber.from(10).pow(26);
      const expected = oneE26.add(110_000_000 - 1).div(110_000_000);

      expect(res.rate).to.eq(expected);
      expect(res.updatedAt).to.be.gt(0);
    });

    describe("when invert is false", () => {
      beforeEach(async () => {
        subjectNormalizedConfig = await adapter.validateConfig(encodeRawConfig(feed.address, false));
      });

      it("returns direct rate scaled to 1e18", async () => {
        // 1.10 with 8 decimals -> 1.1e18
        const res = await subject();
        expect(res.valid).to.eq(true);
        expect(res.rate).to.eq(ether(1.1));
        expect(res.updatedAt).to.be.gt(0);
      });
    });

    describe("when answer <= 0", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 0, now, now, 1);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when updatedAt is 0", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(1, 110_000_000, now, 0, 1);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("when answeredInRound < roundId", () => {
      beforeEach(async () => {
        const now = (await ethers.provider.getBlock("latest")).timestamp;
        await feed.setRoundData(2, 110_000_000, now, now, 1);
      });

      it("returns invalid", async () => {
        const res = await subject();
        expect(res.valid).to.eq(false);
        expect(res.rate).to.eq(0);
        expect(res.updatedAt).to.eq(0);
      });
    });

    describe("reverts when config length is invalid", () => {
      beforeEach(() => {
        subjectNormalizedConfig = "0x";
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Invalid config");
      });
    });
  });
});

