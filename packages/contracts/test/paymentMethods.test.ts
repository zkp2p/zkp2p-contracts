import * as fs from "fs";
import * as path from "path";

import { extractPaymentMethods } from "../scripts/extractors/paymentMethods";

const GENERIC_ZELLE_HASH = "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";
const LEGACY_ZELLE_HASHES = [
  "0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5",
  "0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e",
  "0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d",
];

describe("payment method package extraction", () => {
  const paymentMethodsDir = path.resolve(__dirname, "../paymentMethods");

  beforeAll(async () => {
    await extractPaymentMethods();
  });

  it.each([
    ["upi", "0xe99a5081226cbbff9440a63da5caa04fa30f210c12c4dd9976132ac075054cd9", "0xaad766fbc07fb357bed9fd8b03b935f2f71fe29fc48f08274bc2a01d7f642afc"],
    ["xmoney", "0x790dd0cc68b6e7f474649a6c0a5463a964be9d2589e2076b6dc99f5701543f51", "0xc4ae21aac0c6549d71dd96035b7e0bdb6c79ebdba8891b666115bc976d16a29e"],
  ])("publishes registered %s on Base and Base staging in every module format", (method, methodHash, currencyHash) => {
    for (const format of ["", "_cjs", "_esm"]) {
      const directory = path.resolve(__dirname, "..", format, "paymentMethods");
      for (const network of ["base", "baseStaging"]) {
        const data = JSON.parse(fs.readFileSync(path.join(directory, `${network}.json`), "utf8"));
        expect(data.methods[method].paymentMethodHash).toBe(methodHash);
        expect(data.methods[method].currencies).toEqual([currencyHash]);
      }
      const lookups = JSON.parse(fs.readFileSync(path.join(directory, "lookups.json"), "utf8"));
      expect(lookups.nameToHash[method]).toBe(methodHash);
      expect(lookups.hashToName[methodHash]).toBe(method);
    }
  });

  it("publishes the live staging Monobank UAH rail without enabling production", () => {
    const methodHash = "0x1d966dbd6aeb8674d7c05174bd0ded7b56a798672bfb862ef20bbe8c2bbfce18";
    const currencyHash = "0x763ce5da7605b2b5ec3e9ec5b0ab2bbcf8b27d28da2b5002e4e364278d729d14";
    for (const format of ["", "_cjs", "_esm"]) {
      const directory = path.resolve(__dirname, "..", format, "paymentMethods");
      const staging = JSON.parse(fs.readFileSync(path.join(directory, "baseStaging.json"), "utf8"));
      const production = JSON.parse(fs.readFileSync(path.join(directory, "base.json"), "utf8"));
      const lookups = JSON.parse(fs.readFileSync(path.join(directory, "lookups.json"), "utf8"));
      expect(staging.methods.monobank.paymentMethodHash).toBe(methodHash);
      expect(staging.methods.monobank.currencies).toEqual([currencyHash]);
      expect(production.methods).not.toHaveProperty("monobank");
      expect(lookups.nameToHash.monobank).toBe(methodHash);
      expect(lookups.hashToName[methodHash]).toBe("monobank");
      const currencies = JSON.parse(fs.readFileSync(path.resolve(directory, "../currencies/currencies.json"), "utf8"));
      expect(currencies.codeToHash.UAH).toBe(currencyHash);
      expect(currencies.hashToCode[currencyHash]).toBe("UAH");
    }
  });

  it("publishes one generic Zelle method with no variant compatibility API", () => {
    const base = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "base.json"), "utf8"));
    const baseStaging = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "baseStaging.json"), "utf8"));
    const lookups = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "lookups.json"), "utf8"));

    for (const network of [base, baseStaging]) {
      expect(network.methods.zelle.paymentMethodHash).toBe(GENERIC_ZELLE_HASH);
      expect(Object.keys(network.methods).filter((name) => name.startsWith("zelle-"))).toEqual([]);
    }

    expect(lookups.nameToHash.zelle).toBe(GENERIC_ZELLE_HASH);
    expect(lookups.hashToName[GENERIC_ZELLE_HASH]).toBe("zelle");
    expect(Object.keys(lookups.nameToHash).filter((name) => name.startsWith("zelle-"))).toEqual([]);
    expect(Object.values(lookups.hashToName).filter((name) => String(name).startsWith("zelle-"))).toEqual([]);
    expect(lookups).not.toHaveProperty("zelleVariantHashes");
    expect(lookups).not.toHaveProperty("zelleUnspecifiedHash");

    const generatedPackage = [
      JSON.stringify({ base, baseStaging, lookups }),
      ...["_cjs", "_esm"].flatMap((format) =>
        ["base.json", "baseStaging.json", "lookups.json"].map((file) =>
          fs.readFileSync(path.resolve(__dirname, `../${format}/paymentMethods/${file}`), "utf8")
        )
      ),
    ]
      .join("\n")
      .toLowerCase();

    for (const legacyHash of LEGACY_ZELLE_HASHES) {
      expect(generatedPackage).not.toContain(legacyHash);
    }
  });
});
