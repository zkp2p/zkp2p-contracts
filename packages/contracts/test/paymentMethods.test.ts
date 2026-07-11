import * as fs from "fs";
import * as path from "path";

import { extractPaymentMethods } from "../scripts/extractors/paymentMethods";

const GENERIC_ZELLE_HASH = "0xf752c7d19698ecb0bb8988abf9b9a53a4c3657f3bc8850a6fb59fdf3e3ce8cd3";
const RETIRED_ZELLE_METHODS = {
  "zelle-citi": "0x817260692b75e93c7fbc51c71637d4075a975e221e1ebc1abeddfabd731fd90d",
  "zelle-chase": "0x6aa1d1401e79ad0549dced8b1b96fb72c41cd02b32a7d9ea1fed54ba9e17152e",
  "zelle-bofa": "0x4bc42b322a3ad413b91b2fde30549ca70d6ee900eded1681de91aaf32ffd7ab5",
} as const;

describe("payment method package extraction", () => {
  const paymentMethodsDir = path.resolve(__dirname, "../paymentMethods");

  beforeAll(async () => {
    await extractPaymentMethods();
  });

  it("publishes only generic Zelle as active while preserving historical reverse labels", () => {
    const base = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "base.json"), "utf8"));
    const baseStaging = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "baseStaging.json"), "utf8"));
    const lookups = JSON.parse(fs.readFileSync(path.join(paymentMethodsDir, "lookups.json"), "utf8"));

    for (const network of [base, baseStaging]) {
      expect(network.methods.zelle.paymentMethodHash).toBe(GENERIC_ZELLE_HASH);
      for (const retiredName of Object.keys(RETIRED_ZELLE_METHODS)) {
        expect(network.methods[retiredName]).toBeUndefined();
      }
    }

    expect(lookups.nameToHash.zelle).toBe(GENERIC_ZELLE_HASH);
    expect(lookups.zelleVariantHashes).toEqual([]);
    for (const [retiredName, retiredHash] of Object.entries(RETIRED_ZELLE_METHODS)) {
      expect(lookups.nameToHash[retiredName]).toBeUndefined();
      expect(lookups.hashToName[retiredHash]).toBe(retiredName);
    }
  });
});
