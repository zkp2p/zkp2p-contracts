import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";

describe("NullifierRegistryV2", () => {
  async function fixture() {
    const [owner, writer, other] = await ethers.getSigners();
    const legacy = await (await ethers.getContractFactory("NullifierRegistry")).deploy();
    const registry = await (await ethers.getContractFactory("NullifierRegistryV2")).deploy(legacy.address);
    return { owner, writer, other, legacy, registry };
  }

  it("requires a deployed legacy registry", async () => {
    const [owner] = await ethers.getSigners();
    const factory = await ethers.getContractFactory("NullifierRegistryV2");
    await expect(factory.deploy(ethers.constants.AddressZero)).to.be.revertedWithCustomError(factory, "ZeroAddress");
    await expect(factory.deploy(owner.address)).to.be.revertedWithCustomError(factory, "ZeroAddress");
  });

  it("reads predecessor nullifiers without inventing a binding", async () => {
    const { owner, legacy, registry } = await loadFixture(fixture);
    const nullifier = ethers.utils.id("legacy-payment");
    await legacy.addWritePermission(owner.address);
    await legacy.addNullifier(nullifier);

    expect(await registry.isNullified(nullifier)).to.eq(true);
    expect(await registry.intentHashByNullifier(nullifier)).to.eq(ethers.constants.HashZero);
    expect(await registry.nullifierByIntentHash(ethers.utils.id("intent"))).to.eq(ethers.constants.HashZero);
  });

  it("atomically creates an immutable bidirectional binding", async () => {
    const { writer, registry } = await loadFixture(fixture);
    const nullifier = ethers.utils.id("new-payment");
    const intentHash = ethers.utils.id("new-intent");
    await registry.addWritePermission(writer.address);

    await expect(registry.connect(writer).addNullifier(nullifier, intentHash))
      .to.emit(registry, "NullifierAdded")
      .withArgs(nullifier, intentHash, writer.address);
    expect(await registry.isNullified(nullifier)).to.eq(true);
    expect(await registry.intentHashByNullifier(nullifier)).to.eq(intentHash);
    expect(await registry.nullifierByIntentHash(intentHash)).to.eq(nullifier);

    await expect(registry.connect(writer).addNullifier(nullifier, ethers.utils.id("other-intent")))
      .to.be.revertedWithCustomError(registry, "NullifierAlreadyExists");
    await expect(registry.connect(writer).addNullifier(ethers.utils.id("other-payment"), intentHash))
      .to.be.revertedWithCustomError(registry, "IntentAlreadyBound");
  });

  it("rejects predecessor replay, zero values, and unauthorized writes", async () => {
    const { owner, writer, other, legacy, registry } = await loadFixture(fixture);
    const legacyNullifier = ethers.utils.id("legacy-replay");
    await legacy.addWritePermission(owner.address);
    await legacy.addNullifier(legacyNullifier);
    await registry.addWritePermission(writer.address);

    await expect(registry.connect(other).addNullifier(ethers.utils.id("x"), ethers.utils.id("y")))
      .to.be.revertedWithCustomError(registry, "UnauthorizedWriter");
    await expect(registry.connect(writer).addNullifier(ethers.constants.HashZero, ethers.utils.id("y")))
      .to.be.revertedWithCustomError(registry, "ZeroNullifier");
    await expect(registry.connect(writer).addNullifier(ethers.utils.id("x"), ethers.constants.HashZero))
      .to.be.revertedWithCustomError(registry, "ZeroIntentHash");
    await expect(registry.connect(writer).addNullifier(legacyNullifier, ethers.utils.id("y")))
      .to.be.revertedWithCustomError(registry, "NullifierAlreadyExists");
  });

  it("governs an explicit enumerable writer set", async () => {
    const { owner, writer, other, registry } = await loadFixture(fixture);
    await expect(registry.connect(other).addWritePermission(writer.address)).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(registry.addWritePermission(ethers.constants.AddressZero))
      .to.be.revertedWithCustomError(registry, "ZeroAddress");
    await expect(registry.addWritePermission(writer.address))
      .to.emit(registry, "WriterAdded").withArgs(writer.address);
    await expect(registry.addWritePermission(writer.address))
      .to.be.revertedWithCustomError(registry, "WriterAlreadyAuthorized");
    await registry.addWritePermission(owner.address);
    expect(await registry.getWriters()).to.deep.eq([writer.address, owner.address]);

    await expect(registry.connect(other).removeWritePermission(writer.address)).to.be.revertedWith("Ownable: caller is not the owner");
    await expect(registry.removeWritePermission(other.address))
      .to.be.revertedWithCustomError(registry, "WriterNotAuthorized");
    await expect(registry.removeWritePermission(writer.address))
      .to.emit(registry, "WriterRemoved").withArgs(writer.address);
    expect(await registry.getWriters()).to.deep.eq([owner.address]);
    expect(await registry.isWriter(writer.address)).to.eq(false);
  });
});
