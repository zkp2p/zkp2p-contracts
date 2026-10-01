import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { runInNewContext } from "vm";
import * as ts from "typescript";

import { SOURCE_ABI_ARTIFACTS } from "../scripts/extractors/abis";
import { CHAINLINK_FEEDS, OracleFeedProvider } from "../scripts/data/oracleFeeds";
import { extractOracleFeeds, renderOracleFeeds } from "../scripts/extractors/oracleFeeds";

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

  it("generates a runtime provider enum and matching published declarations", async () => {
    await extractOracleFeeds();
    const oracleDir = path.resolve(__dirname, "../oracleFeeds");
    const indexPath = path.join(oracleDir, "index.ts");
    const indexSource = fs.readFileSync(indexPath, "utf8");
    const compiled = ts.transpileModule(indexSource, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    }).outputText;
    const generatedExports: Record<string, unknown> = {};
    runInNewContext(compiled, { exports: generatedExports, require: createRequire(indexPath) });
    expect(generatedExports.OracleFeedProvider).toEqual({ Chainlink: "chainlink", Zkp2p: "zkp2p" });
    expect(generatedExports.OracleFeedProvider).toEqual(OracleFeedProvider);

    const indexDeclaration = fs.readFileSync(path.join(oracleDir, "index.d.ts"), "utf8");
    const enumDefinition = indexSource.match(/export enum OracleFeedProvider \{[^}]+\}/)?.[0];
    expect(enumDefinition).toBeDefined();
    expect(indexDeclaration).toContain(enumDefinition);
    const types = fs.readFileSync(path.join(oracleDir, "types.d.ts"), "utf8");
    expect(types).toContain("import type { OracleFeedProvider } from './index';");
    expect(types).toContain("provider?: OracleFeedProvider;");
    expect(types).not.toMatch(/provider\?\s*:[^;]*['"]/);
  });

  it("binds each ZKP2P feed to its Base deployment", () => {
    const deploymentsByPair: Record<string, string> = {
      "CNY/USD": "FxRateFeedCnyUsd",
      "INR/USD": "FxRateFeedInrUsd",
    };
    const feeds = CHAINLINK_FEEDS.filter((entry) => entry.provider === OracleFeedProvider.Zkp2p);
    expect(feeds.map((feed) => feed.pair).sort()).toEqual(Object.keys(deploymentsByPair).sort());
    for (const feed of feeds) {
      const name = deploymentsByPair[feed.pair];
      expect(feed.decimals).toBe(8);
      const deployment = JSON.parse(fs.readFileSync(
        path.resolve(__dirname, "../../../deployments/base", `${name}.json`), "utf8",
      ));
      expect(feed.feed.toLowerCase()).toBe(deployment.address.toLowerCase());
    }
  });
});
