import "module-alias/register";
import "module-alias/register";
import { ethers } from "hardhat";
import { getWaffleExpect, getAccounts } from "@utils/test";
import { ADDRESS_ZERO } from "@utils/constants";
import { ether } from "@utils/common";
import { DepositRateManagerRegistryV1 } from "@typechain";

const expect = getWaffleExpect();

describe("DepositRateManagerRegistryV1", () => {
  // Accounts
  let owner: any, manager: any, other: any, feeRecipient: any;
  // Contract
  let registry: DepositRateManagerRegistryV1;

  beforeEach(async () => {
    [owner, manager, other, feeRecipient] = await getAccounts();
    registry = (await (await ethers.getContractFactory("DepositRateManagerRegistryV1", owner.wallet)).deploy()) as DepositRateManagerRegistryV1;
  });

  // Local helper to create a manager and return id without double-wait pattern
  async function create(config?: { maxFee?: any; fee?: any; hook?: string; name?: string; uri?: string }) {
    const tx = await registry.createRateManager({
      manager: manager.address,
      feeRecipient: feeRecipient.address,
      maxFee: config?.maxFee ?? ether(0.05),
      fee: config?.fee ?? ether(0.01),
      depositHook: config?.hook ?? ADDRESS_ZERO,
      name: config?.name ?? "name",
      uri: config?.uri ?? "uri",
    });
    const rcpt = await tx.wait();
    const ev = rcpt.events?.find((e: any) => e.event === "RateManagerCreated");
    expect(ev?.args?.depositHook).to.eq(config?.hook ?? ADDRESS_ZERO);
    return ev?.args?.rateManagerId as string;
  }

  it("createRateManager stores config and emits", async () => {
    const id = await create();
    const cfg = await registry.getRateManager(id);
    expect(cfg.manager).to.eq(manager.address);
    expect(cfg.feeRecipient).to.eq(feeRecipient.address);
    expect(cfg.maxFee).to.eq(ether(0.05));
    expect(cfg.fee).to.eq(ether(0.01));
  });

  it("createRateManager rejects invalid inputs", async () => {
    await expect(
      registry.createRateManager({ manager: ADDRESS_ZERO, feeRecipient: feeRecipient.address, maxFee: ether(0.05), fee: 0, depositHook: ADDRESS_ZERO, name: "", uri: "" })
    ).to.be.revertedWith("Invalid manager");

    await expect(
      registry.createRateManager({ manager: manager.address, feeRecipient: ADDRESS_ZERO, maxFee: ether(0.05), fee: ether(0.01), depositHook: ADDRESS_ZERO, name: "", uri: "" })
    ).to.be.revertedWith("Invalid fee recipient");

    await expect(
      registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.10), fee: 0, depositHook: ADDRESS_ZERO, name: "", uri: "" })
    ).to.be.revertedWith("Max fee exceeds global");

    await expect(
      registry.createRateManager({ manager: manager.address, feeRecipient: feeRecipient.address, maxFee: ether(0.02), fee: ether(0.03), depositHook: ADDRESS_ZERO, name: "", uri: "" })
    ).to.be.revertedWith("Fee exceeds maxFee");
  });

  it("setRateManagerConfig updates fields (onlyManager)", async () => {
    const id = await create();
    await expect(
      registry.connect(other.wallet).setRateManagerConfig(id, manager.address, feeRecipient.address, ADDRESS_ZERO, "n2", "u2")
    ).to.be.revertedWith("Caller is not manager");

    await registry.connect(manager.wallet).setRateManagerConfig(id, manager.address, feeRecipient.address, ADDRESS_ZERO, "n2", "u2");
    const cfg = await registry.getRateManager(id);
    expect(cfg.name).to.eq("n2");
    expect(cfg.uri).to.eq("u2");
  });

  it("setFee enforces cap and recipient presence", async () => {
    const id = await create();
    await expect(registry.connect(other.wallet).setFee(id, ether(0.02))).to.be.revertedWith("Caller is not manager");
    await expect(registry.connect(manager.wallet).setFee(id, ether(0.10))).to.be.revertedWith("Fee exceeds maxFee");
    await registry.connect(manager.wallet).setFee(id, ether(0.02));
    const [fee, recipient] = await registry.getFeeAndRecipient(id);
    expect(recipient).to.eq(feeRecipient.address);
    expect(fee).to.eq(ether(0.02));
  });

  it("setMinRate and setMinRatesBatch update pairs", async () => {
    const id = await create();
    const pm = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("pm"));
    const usd = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("USD"));
    await registry.connect(manager.wallet).setMinRate(id, pm, usd, ether(1));
    expect(await registry.getMinRate(id, pm, usd)).to.eq(ether(1));

    const eur = ethers.utils.keccak256(ethers.utils.toUtf8Bytes("EUR"));
    await registry.connect(manager.wallet).setMinRatesBatch(id, [pm], [[eur]], [[ether(2)]]);
    expect(await registry.getMinRate(id, pm, eur)).to.eq(ether(2));
  });
});
