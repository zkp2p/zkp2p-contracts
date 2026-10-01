import * as fs from "fs";
import * as path from "path";

import { SOURCE_ABI_ARTIFACTS } from "../scripts/extractors/abis";
import { CHAINLINK_FEEDS, OracleFeedProvider } from "../scripts/data/oracleFeeds";
import { renderOracleFeeds } from "../scripts/extractors/oracleFeeds";

describe("FX rate feed package", () => {
  it("exports the generic FX source ABI artifacts", () => {
    expect(SOURCE_ABI_ARTIFACTS).toEqual(expect.objectContaining({
      FxRateStore: "contracts/oracles/FxRateStore.sol/FxRateStore.json",
      FxRateFeed: "contracts/oracles/FxRateFeed.sol/FxRateFeed.json",
    }));
  });

  it("exports provider values and labels every configured feed", () => {
    expect(OracleFeedProvider).toEqual({ Chainlink: "chainlink", Zkp2p: "zkp2p" });
    expect(CHAINLINK_FEEDS.length).toBeGreaterThan(0);
    for (const feed of CHAINLINK_FEEDS) {
      expect(["chainlink", "zkp2p"]).toContain(feed.provider);
    }
  });

  it("renders providers as plain JSON strings", () => {
    expect(renderOracleFeeds).toEqual(expect.any(Function));
    const generatedAt = "2026-10-01T00:00:00.000Z";
    const rendered = JSON.parse(JSON.stringify(renderOracleFeeds(CHAINLINK_FEEDS, generatedAt)));
    expect(rendered).toEqual({ generatedAt, network: "base", feeds: CHAINLINK_FEEDS });
    for (const feed of rendered.feeds) {
      expect(typeof feed.provider).toBe("string");
      expect(["chainlink", "zkp2p"]).toContain(feed.provider);
    }
  });

  it("binds each ZKP2P feed to its Base deployment", () => {
    for (const feed of CHAINLINK_FEEDS.filter((entry) => entry.provider === OracleFeedProvider.Zkp2p)) {
      expect(feed.pair).toMatch(/^[A-Z]{3}\/USD$/);
      const currency = feed.pair.split("/")[0];
      const name = `FxRateFeed${currency[0]}${currency.slice(1).toLowerCase()}Usd`;
      const deployment = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, "../../../deployments/base", `${name}.json`), "utf8",
      ));
      expect(feed.feed.toLowerCase()).toBe(deployment.address.toLowerCase());
    }
  });
});
