import { expect } from "chai";

import { SafeBatchCollector } from "../../deployments/safeBatchCollector";

describe("SafeBatchCollector", () => {
  it("deduplicates identical transactions case-insensitively", () => {
    const collector = new SafeBatchCollector();
    const target = "0x1111111111111111111111111111111111111111";
    const calldata = "0xABCDEF";

    collector.add(target, calldata);
    collector.add(target.toUpperCase().replace("0X", "0x"), calldata.toLowerCase());

    expect(collector.count()).to.eq(1);
  });

  it("retains calls that differ by target or calldata", () => {
    const collector = new SafeBatchCollector();
    const firstTarget = "0x1111111111111111111111111111111111111111";
    const secondTarget = "0x2222222222222222222222222222222222222222";

    collector.add(firstTarget, "0xaaaa");
    collector.add(firstTarget, "0xbbbb");
    collector.add(secondTarget, "0xaaaa");

    expect(collector.count()).to.eq(3);
  });
});
