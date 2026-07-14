import * as fs from "fs";
import * as path from "path";

import { extractPaymentMethods } from "../scripts/extractors/paymentMethods";

const GENERIC_ZELLE_HASH = "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";

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
  });
});
