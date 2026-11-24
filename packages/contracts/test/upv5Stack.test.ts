import * as fs from "fs";
import * as path from "path";

import { SOURCE_ABI_ARTIFACTS } from "../scripts/extractors/abis";

const UPV5_STACK = {
  NullifierRegistryV3: "contracts/registries/NullifierRegistryV3.sol/NullifierRegistryV3.json",
  UnifiedPaymentVerifierV5: "contracts/unifiedVerifier/UnifiedPaymentVerifierV5.sol/UnifiedPaymentVerifierV5.json",
  DisputeVerifierV2: "contracts/unifiedVerifier/DisputeVerifierV2.sol/DisputeVerifierV2.json",
};

describe("UPV5 cutover stack exports", () => {
  it("exports the three source ABIs whether or not a network records an address", () => {
    expect(SOURCE_ABI_ARTIFACTS).toEqual(expect.objectContaining(UPV5_STACK));
  });

  it("release verification checks the same source ABIs", () => {
    const verifier = fs.readFileSync(path.resolve(__dirname, "../scripts/verify-release.mjs"), "utf8");
    for (const [name, artifact] of Object.entries(UPV5_STACK)) {
      expect(verifier).toContain(`${name}: "artifacts/${artifact}"`);
    }
  });
});
