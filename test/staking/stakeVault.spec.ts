import { expect } from "chai";
import { ethers } from "hardhat";
import { time } from "@nomicfoundation/hardhat-network-helpers";

const usdc = (amount: string | number) => ethers.utils.parseUnits(String(amount), 6);
const DAY = 24 * 60 * 60;

describe("StakeVault", () => {
  async function deployFixture() {
    const [owner, controller, nextController, staker, maker, recipient] = await ethers.getSigners();

    const token = await (await ethers.getContractFactory("USDCMock"))
      .deploy(usdc(1_000_000), "USD Coin", "USDC");
    const vault = await (await ethers.getContractFactory("StakeVault")).deploy(
      owner.address,
      token.address,
      controller.address,
      30 * DAY,
      DAY,
    );

    await token.transfer(staker.address, usdc(10_000));
    await token.connect(staker).approve(vault.address, ethers.constants.MaxUint256);

    return { owner, controller, nextController, staker, maker, recipient, token, vault };
  }

  describe("#depositStake", () => {
    it("records stake and emits the resulting balance", async () => {
      const { staker, vault } = await deployFixture();

      await expect(vault.connect(staker).depositStake(usdc(1_000)))
        .to.emit(vault, "StakeDeposited")
        .withArgs(staker.address, usdc(1_000), usdc(1_000));

      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(1_000));
      expect(await vault.totalLiabilities()).to.eq(usdc(1_000));
    });

    it("rejects zero-value stake", async () => {
      const { staker, vault } = await deployFixture();

      await expect(vault.connect(staker).depositStake(0)).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("rejects deposits while stake deposits are paused", async () => {
      const { owner, staker, vault } = await deployFixture();
      await vault.connect(owner).setStakeOperationsPaused(true, false);

      await expect(vault.connect(staker).depositStake(usdc(1))).to.be.revertedWithCustomError(
        vault,
        "StakeActionPaused",
      );
    });
  });

  describe("delegated stake ownership", () => {
    it("lets a stake owner deposit for a taker without transferring ownership", async () => {
      const { staker, maker: taker, vault } = await deployFixture();

      await expect(vault.connect(staker).depositStakeFor(taker.address, usdc(1_000)))
        .to.emit(vault, "TakerAuthorizationUpdated")
        .withArgs(staker.address, taker.address, true)
        .and.to.emit(vault, "StakeDeposited")
        .withArgs(staker.address, usdc(1_000), usdc(1_000));

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(staker.address);
      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(1_000));
      expect(await vault.stakeBalance(taker.address)).to.eq(0);
    });

    it("prevents another stake owner from replacing an existing authorization", async () => {
      const { nextController: otherStakeOwner, staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);

      await expect(
        vault.connect(otherStakeOwner).setTakerAuthorization(taker.address, true),
      ).to.be.revertedWithCustomError(vault, "TakerAlreadyAuthorized");
    });

    it("lets the stake owner revoke a taker for future intents", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);

      await expect(vault.connect(staker).setTakerAuthorization(taker.address, false))
        .to.emit(vault, "TakerAuthorizationUpdated")
        .withArgs(staker.address, taker.address, false);

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(taker.address);
    });

    it("lets the taker clear an unwanted stake owner", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);

      await expect(vault.connect(taker).clearStakeOwner())
        .to.emit(vault, "TakerAuthorizationUpdated")
        .withArgs(staker.address, taker.address, false);

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(taker.address);
    });

    it("does not give the taker stake withdrawal rights", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).depositStakeFor(taker.address, usdc(100));

      await expect(vault.connect(taker).requestExit()).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });
  });

  describe("reservations", () => {
    it("reserves free stake against a unique intent", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent-1");
      await vault.connect(staker).depositStake(usdc(1_000));
      const releaseTime = (await time.latest()) + 30 * DAY;

      await expect(vault.connect(controller).reserveStake(staker.address, intentHash, usdc(400), releaseTime))
        .to.emit(vault, "StakeReserved")
        .withArgs(intentHash, staker.address, controller.address, usdc(400), usdc(400), releaseTime);

      expect(await vault.reservedStake(staker.address)).to.eq(usdc(400));
      expect(await vault.freeStake(staker.address)).to.eq(usdc(600));
    });

    it("rejects a reservation larger than free stake", async () => {
      const { controller, staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));

      await expect(
        vault.connect(controller).reserveStake(staker.address, ethers.utils.id("intent"), usdc(101), 0),
      ).to.be.revertedWithCustomError(vault, "InsufficientFreeStake");
    });

    it("rejects reusing an active intent reservation", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(50), 0);

      await expect(
        vault.connect(controller).reserveStake(staker.address, intentHash, usdc(10), 0),
      ).to.be.revertedWithCustomError(vault, "ReservationAlreadyExists");
    });

    it("reduces an exact reservation after partial fulfillment", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(500), 100);

      await expect(vault.connect(controller).updateReservation(intentHash, usdc(200), 200))
        .to.emit(vault, "StakeReservationUpdated")
        .withArgs(intentHash, staker.address, usdc(500), usdc(200), usdc(200), 200);

      expect(await vault.freeStake(staker.address)).to.eq(usdc(800));
    });

    it("releases a cancelled intent reservation", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(500));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(200), 0);

      await vault.connect(controller).releaseReservation(intentHash);

      expect(await vault.reservedStake(staker.address)).to.eq(0);
      expect((await vault.getReservation(intentHash)).active).to.eq(false);
    });

    it("allows only the controller to mutate reservations", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(500));

      await expect(
        vault.connect(staker).reserveStake(staker.address, ethers.utils.id("intent"), usdc(1), 0),
      ).to.be.revertedWithCustomError(vault, "UnauthorizedController");
    });
  });

  describe("slashing and compensation", () => {
    it("slashes no more than requested and retains the remaining reservation", async () => {
      const { controller, staker, maker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(500), 0);

      await expect(vault.connect(controller).slashReservation(intentHash, maker.address, usdc(200)))
        .to.emit(vault, "StakeSlashed")
        .withArgs(intentHash, staker.address, maker.address, usdc(200), usdc(800), usdc(300));

      expect(await vault.reservedStake(staker.address)).to.eq(usdc(300));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(200));
      expect(await vault.totalLiabilities()).to.eq(usdc(1_000));
    });

    it("rejects slashing above the active reservation", async () => {
      const { controller, staker, maker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(50), 0);

      await expect(
        vault.connect(controller).slashReservation(intentHash, maker.address, usdc(51)),
      ).to.be.revertedWithCustomError(vault, "InvalidReservationAmount");
    });

    it("lets the maker pull credited compensation", async () => {
      const { controller, staker, maker, recipient, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(50), 0);
      await vault.connect(controller).slashReservation(intentHash, maker.address, usdc(20));

      await vault.connect(maker).withdrawCompensation(recipient.address);

      expect(await token.balanceOf(recipient.address)).to.eq(usdc(20));
      expect(await vault.claimableCompensation(maker.address)).to.eq(0);
    });
  });

  describe("full exit", () => {
    it("marks the staker exiting immediately", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));

      await expect(vault.connect(staker).requestExit()).to.emit(vault, "ExitRequested");

      expect(await vault.isExiting(staker.address)).to.eq(true);
    });

    it("blocks new reservations after exit is requested", async () => {
      const { controller, staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestExit();

      await expect(
        vault.connect(controller).reserveStake(staker.address, ethers.utils.id("intent"), usdc(1), 0),
      ).to.be.revertedWithCustomError(vault, "AlreadyExiting");
    });

    it("blocks withdrawal until both delay and reservations are resolved", async () => {
      const { controller, staker, recipient, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(20), 0);
      await vault.connect(staker).requestExit();
      await time.increase(30 * DAY);

      await expect(vault.connect(staker).withdrawStake(recipient.address)).to.be.revertedWithCustomError(
        vault,
        "ActiveReservations",
      );
    });

    it("withdraws the entire remaining balance after exit matures", async () => {
      const { staker, recipient, token, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestExit();
      await time.increase(30 * DAY);

      await vault.connect(staker).withdrawStake(recipient.address);

      expect(await token.balanceOf(recipient.address)).to.eq(usdc(100));
      expect(await vault.stakeBalance(staker.address)).to.eq(0);
    });

    it("cancels exit without changing the remaining stake", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestExit();

      await vault.connect(staker).cancelExit();

      expect(await vault.isExiting(staker.address)).to.eq(false);
      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(100));
    });
  });

  describe("deferred payouts", () => {
    it("accounts for tokens transferred into the vault after deferred admission authorization", async () => {
      const { controller, staker, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      const releaseTime = (await time.latest()) + DAY;
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, releaseTime);
      await token.transfer(vault.address, usdc(100));

      await expect(
        vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(100), releaseTime),
      ).to.emit(vault, "DeferredPayoutRecorded");

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(100));
      expect(await vault.totalLiabilities()).to.eq(usdc(100));
    });

    it("rejects deferred accounting without unaccounted backing tokens", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, 0);

      await expect(
        vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(1), 0),
      ).to.be.revertedWithCustomError(vault, "InsufficientUnaccountedTokens");
    });

    it("lets the beneficiary withdraw unslashed proceeds at maturity", async () => {
      const { controller, staker, recipient, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      const releaseTime = (await time.latest()) + DAY;
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, releaseTime);
      await token.transfer(vault.address, usdc(100));
      await vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(100), releaseTime);
      await time.increase(DAY);

      await vault.connect(staker).withdrawDeferredPayout(intentHash, recipient.address);

      expect(await token.balanceOf(recipient.address)).to.eq(usdc(100));
    });

    it("credits a partial deferred slash and leaves the remainder for the taker", async () => {
      const { controller, staker, maker, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, 0);
      await token.transfer(vault.address, usdc(100));
      await vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(100), 0);

      await vault.connect(controller).slashDeferredPayout(intentHash, maker.address, usdc(40));

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(60));
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(40));
    });

    it("rejects new deferred authorizations while reservations are paused", async () => {
      const { owner, controller, staker, vault } = await deployFixture();
      await vault.connect(owner).setStakeOperationsPaused(false, true);

      await expect(
        vault.connect(controller).authorizeDeferredPayout(ethers.utils.id("deferred"), staker.address, 0),
      ).to.be.revertedWithCustomError(vault, "StakeActionPaused");
    });

    it("records an already-authorized deferred payout while new reservations are paused", async () => {
      const { owner, controller, staker, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, DAY);
      await vault.connect(owner).setStakeOperationsPaused(false, true);
      await token.transfer(vault.address, usdc(100));

      await vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(100), 2 * DAY);

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(100));
    });
  });

  describe("controller handover", () => {
    it("enforces delayed two-step controller acceptance", async () => {
      const { owner, nextController, vault } = await deployFixture();
      await vault.connect(owner).proposeController(nextController.address);

      await expect(vault.connect(nextController).acceptController()).to.be.revertedWithCustomError(
        vault,
        "ControllerProposalNotReady",
      );

      await time.increase(DAY);
      await vault.connect(nextController).acceptController();
      expect(await vault.controller()).to.eq(nextController.address);
    });

    it("lets the previous controller settle only its snapshotted stake reservations", async () => {
      const { owner, controller, nextController, staker, vault } = await deployFixture();
      const oldIntent = ethers.utils.id("old-intent");
      const newIntent = ethers.utils.id("new-intent");
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, oldIntent, usdc(400), 0);
      await vault.connect(owner).proposeController(nextController.address);
      await time.increase(DAY);
      await vault.connect(nextController).acceptController();
      await vault.connect(nextController).reserveStake(staker.address, newIntent, usdc(200), 0);

      await expect(vault.connect(nextController).releaseReservation(oldIntent))
        .to.be.revertedWithCustomError(vault, "UnauthorizedPositionController");
      await expect(vault.connect(controller).releaseReservation(newIntent))
        .to.be.revertedWithCustomError(vault, "UnauthorizedPositionController");

      await vault.connect(controller).releaseReservation(oldIntent);
      await vault.connect(nextController).releaseReservation(newIntent);
      expect(await vault.reservedStake(staker.address)).to.eq(0);
    });

    it("lets the previous controller fund its deferred authorization after handover", async () => {
      const { owner, controller, nextController, staker, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("old-deferred-intent");
      await vault.connect(controller).authorizeDeferredPayout(intentHash, staker.address, DAY);
      await vault.connect(owner).proposeController(nextController.address);
      await time.increase(DAY);
      await vault.connect(nextController).acceptController();
      await token.transfer(vault.address, usdc(100));

      await expect(
        vault.connect(nextController).recordDeferredPayout(intentHash, staker.address, usdc(100), 2 * DAY),
      ).to.be.revertedWithCustomError(vault, "UnauthorizedPositionController");
      await vault.connect(controller).recordDeferredPayout(intentHash, staker.address, usdc(100), 2 * DAY);

      expect((await vault.getDeferredPayout(intentHash)).amount).to.eq(usdc(100));
    });
  });
});
