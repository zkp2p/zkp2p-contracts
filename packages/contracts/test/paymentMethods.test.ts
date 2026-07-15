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
