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

    it("lets the taker clear an unwanted stake owner and disables reassignment", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);

      await expect(vault.connect(taker).clearStakeOwner())
        .to.emit(vault, "TakerAuthorizationUpdated")
        .withArgs(staker.address, taker.address, false)
        .and.to.emit(vault, "StakeDelegationEnabledUpdated")
        .withArgs(taker.address, false);

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(taker.address);
      expect(await vault.stakeDelegationEnabled(taker.address)).to.eq(false);
    });

    it("rejects forced reassignment after the taker clears its stake owner", async () => {
      const { nextController: otherStakeOwner, staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);
      await vault.connect(taker).clearStakeOwner();

      await expect(
        vault.connect(otherStakeOwner).setTakerAuthorization(taker.address, true),
      ).to.be.revertedWithCustomError(vault, "StakeDelegationDisabled");
    });

    it("lets the taker re-enable one-sided stake delegation", async () => {
      const { nextController: otherStakeOwner, staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).setTakerAuthorization(taker.address, true);
      await vault.connect(taker).clearStakeOwner();

      await expect(vault.connect(taker).setStakeDelegationEnabled(true))
        .to.emit(vault, "StakeDelegationEnabledUpdated")
        .withArgs(taker.address, true);
      await vault.connect(otherStakeOwner).setTakerAuthorization(taker.address, true);

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(otherStakeOwner.address);
    });

    it("lets the taker disable delegation before any stake owner is assigned", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(taker).setStakeDelegationEnabled(false);

      await expect(
        vault.connect(staker).setTakerAuthorization(taker.address, true),
      ).to.be.revertedWithCustomError(vault, "StakeDelegationDisabled");
    });

    it("lets the taker pre-approve one exact stake owner", async () => {
      const { nextController: otherStakeOwner, staker, maker: taker, vault } = await deployFixture();

      await expect(vault.connect(taker).setAllowedStakeOwner(staker.address))
        .to.emit(vault, "AllowedStakeOwnerUpdated")
        .withArgs(taker.address, staker.address);
      await expect(
        vault.connect(otherStakeOwner).setTakerAuthorization(taker.address, true),
      ).to.be.revertedWithCustomError(vault, "StakeOwnerNotAllowed");
      await vault.connect(staker).depositStakeFor(taker.address, usdc(100));

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(staker.address);
    });

    it("atomically replaces a squatter with one allowed stake owner", async () => {
      const { nextController: squatter, staker, maker: taker, vault } = await deployFixture();
      await vault.connect(squatter).setTakerAuthorization(taker.address, true);

      await expect(vault.connect(taker).setAllowedStakeOwner(staker.address))
        .to.emit(vault, "TakerAuthorizationUpdated")
        .withArgs(squatter.address, taker.address, false)
        .and.to.emit(vault, "AllowedStakeOwnerUpdated")
        .withArgs(taker.address, staker.address);
      await expect(
        vault.connect(squatter).setTakerAuthorization(taker.address, true),
      ).to.be.revertedWithCustomError(vault, "StakeOwnerNotAllowed");
      await vault.connect(staker).setTakerAuthorization(taker.address, true);

      expect(await vault.stakeOwnerOf(taker.address)).to.eq(staker.address);
    });

    it("does not give the taker stake withdrawal rights", async () => {
      const { staker, maker: taker, vault } = await deployFixture();
      await vault.connect(staker).depositStakeFor(taker.address, usdc(100));

      await expect(vault.connect(taker).requestExit()).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("updates several taker authorizations atomically", async () => {
      const { staker, maker: firstTaker, recipient: secondTaker, vault } = await deployFixture();

      await vault
        .connect(staker)
        .setTakerAuthorizations([firstTaker.address, secondTaker.address], true);

      expect(await vault.stakeOwnerOf(firstTaker.address)).to.eq(staker.address);
      expect(await vault.stakeOwnerOf(secondTaker.address)).to.eq(staker.address);
    });

    it("rolls back every taker authorization when one batch item is invalid", async () => {
      const {
        nextController: otherStakeOwner,
        staker,
        maker: existingTaker,
        recipient: newTaker,
        vault,
      } = await deployFixture();
      await vault.connect(otherStakeOwner).setTakerAuthorization(existingTaker.address, true);

      await expect(
        vault
          .connect(staker)
          .setTakerAuthorizations([newTaker.address, existingTaker.address], true),
      ).to.be.revertedWithCustomError(vault, "TakerAlreadyAuthorized");

      expect(await vault.stakeOwnerOf(newTaker.address)).to.eq(newTaker.address);
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

    it("withdraws compensation aggregated across multiple intent claims", async () => {
      const { controller, staker, maker, recipient, token, vault } = await deployFixture();
      const firstIntent = ethers.utils.id("first-intent");
      const secondIntent = ethers.utils.id("second-intent");
      await vault.connect(staker).depositStake(usdc(200));
      await vault.connect(controller).reserveStake(staker.address, firstIntent, usdc(50), 0);
      await vault.connect(controller).reserveStake(staker.address, secondIntent, usdc(50), 0);
      await vault.connect(controller).slashReservation(firstIntent, maker.address, usdc(10));
      await vault.connect(controller).slashReservation(secondIntent, maker.address, usdc(20));

      await vault.connect(maker).withdrawCompensation(recipient.address);

      expect(await token.balanceOf(recipient.address)).to.eq(usdc(30));
      expect(await vault.claimableCompensation(maker.address)).to.eq(0);
    });
  });

  describe("partial stake withdrawals", () => {
    it("immediately excludes a requested amount from eligible and free stake", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(1_000));

      await expect(vault.connect(staker).requestStakeWithdrawal(usdc(400))).to.emit(
        vault,
        "StakeWithdrawalRequested",
      );

      const withdrawalRequest = await vault.getStakeWithdrawalRequest(staker.address);
      expect(withdrawalRequest.amount).to.eq(usdc(400));
      expect(withdrawalRequest.availableAt.sub(withdrawalRequest.requestedAt)).to.eq(30 * DAY);
      expect(await vault.eligibleStake(staker.address)).to.eq(usdc(600));
      expect(await vault.freeStake(staker.address)).to.eq(usdc(600));
    });

    it("rejects a request larger than currently free stake", async () => {
      const { controller, staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, ethers.utils.id("intent"), usdc(700), 0);

      await expect(
        vault.connect(staker).requestStakeWithdrawal(usdc(301)),
      ).to.be.revertedWithCustomError(vault, "InsufficientFreeStake");
    });

    it("rejects execution before the withdrawal delay", async () => {
      const { staker, recipient, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestStakeWithdrawal(usdc(40));

      await expect(
        vault.connect(staker).withdrawRequestedStake(recipient.address),
      ).to.be.revertedWithCustomError(vault, "StakeWithdrawalNotReady");
    });

    it("withdraws the isolated amount while another reservation remains active", async () => {
      const { controller, staker, recipient, token, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, ethers.utils.id("intent"), usdc(400), 0);
      await vault.connect(staker).requestStakeWithdrawal(usdc(600));
      await time.increase(30 * DAY);

      await expect(vault.connect(staker).withdrawRequestedStake(recipient.address))
        .to.emit(vault, "StakeWithdrawn")
        .withArgs(staker.address, recipient.address, usdc(600));

      expect(await token.balanceOf(recipient.address)).to.eq(usdc(600));
      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(400));
      expect(await vault.reservedStake(staker.address)).to.eq(usdc(400));
    });

    it("restores eligibility when the stake owner cancels the request", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestStakeWithdrawal(usdc(40));

      await expect(vault.connect(staker).cancelStakeWithdrawal())
        .to.emit(vault, "StakeWithdrawalCancelled")
        .withArgs(staker.address, usdc(40));

      expect(await vault.eligibleStake(staker.address)).to.eq(usdc(100));
      expect(await vault.freeStake(staker.address)).to.eq(usdc(100));
    });

    it("prevents a full exit while a partial withdrawal is pending", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestStakeWithdrawal(usdc(40));

      await expect(vault.connect(staker).requestExit()).to.be.revertedWithCustomError(
        vault,
        "PendingStakeWithdrawal",
      );
    });

    it("prevents a partial withdrawal while a full exit is pending", async () => {
      const { staker, vault } = await deployFixture();
      await vault.connect(staker).depositStake(usdc(100));
      await vault.connect(staker).requestExit();

      await expect(vault.connect(staker).requestStakeWithdrawal(usdc(40))).to.be.revertedWithCustomError(
        vault,
        "AlreadyExiting",
      );
    });

    it("preserves a pending withdrawal when reserved stake is slashed", async () => {
      const { controller, staker, maker, recipient, vault } = await deployFixture();
      const intentHash = ethers.utils.id("intent");
      await vault.connect(staker).depositStake(usdc(1_000));
      await vault.connect(controller).reserveStake(staker.address, intentHash, usdc(600), 0);
      await vault.connect(staker).requestStakeWithdrawal(usdc(400));

      await vault.connect(controller).slashReservation(intentHash, maker.address, usdc(200));
      await time.increase(30 * DAY);
      await vault.connect(staker).withdrawRequestedStake(recipient.address);

      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(400));
      expect(await vault.reservedStake(staker.address)).to.eq(usdc(400));
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

  describe("deferred stake", () => {
    it("converts the full gross settlement into fully reserved taker stake", async () => {
      const { controller, staker, maker: protocol, recipient: referrer, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      const releaseTime = (await time.latest()) + DAY;
      const fees = [
        { feeType: 0, recipient: protocol.address, amount: usdc(2) },
        { feeType: 1, recipient: referrer.address, amount: usdc(1) },
      ];
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, releaseTime);
      await token.transfer(vault.address, usdc(100));

      await expect(
        vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), releaseTime, fees),
      )
        .to.emit(vault, "DeferredStakeFunded")
        .withArgs(intentHash, staker.address, usdc(100), usdc(3), usdc(97), releaseTime);

      const deferredStake = await vault.getDeferredStake(intentHash);
      expect(deferredStake.grossAmount).to.eq(usdc(100));
      expect(deferredStake.feeAmount).to.eq(usdc(3));
      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(100));
      expect(await vault.reservedStake(staker.address)).to.eq(usdc(100));
      expect(await vault.freeStake(staker.address)).to.eq(0);
      expect(await vault.totalDeferredFees()).to.eq(usdc(3));
      expect(await vault.totalLiabilities()).to.eq(usdc(100));
      expect((await vault.getDeferredFeeAllocations(intentHash)).length).to.eq(2);
    });

    it("rejects deferred accounting without unaccounted backing tokens", async () => {
      const { controller, staker, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, 0);

      await expect(
        vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(1), 0, []),
      ).to.be.revertedWithCustomError(vault, "InsufficientUnaccountedTokens");
    });

    it("vests fee claims and leaves the net amount as reusable stake at maturity", async () => {
      const { controller, staker, maker: protocol, recipient: referrer, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      const releaseTime = (await time.latest()) + DAY;
      const fees = [
        { feeType: 0, recipient: protocol.address, amount: usdc(2) },
        { feeType: 1, recipient: referrer.address, amount: usdc(1) },
      ];
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, releaseTime);
      await token.transfer(vault.address, usdc(100));
      await vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), releaseTime, fees);

      await expect(vault.connect(controller).releaseDeferredStake(intentHash)).to.be.revertedWithCustomError(
        vault,
        "DeferredStakeNotMature",
      );
      await time.increase(DAY);
      await vault.connect(controller).releaseDeferredStake(intentHash);

      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(97));
      expect(await vault.reservedStake(staker.address)).to.eq(0);
      expect(await vault.freeStake(staker.address)).to.eq(usdc(97));
      expect(await vault.claimableFees(protocol.address)).to.eq(usdc(2));
      expect(await vault.claimableFees(referrer.address)).to.eq(usdc(1));
      expect(await vault.totalDeferredFees()).to.eq(0);
      expect(await vault.totalLiabilities()).to.eq(usdc(100));

      await vault.connect(staker).withdrawFeeClaimFor(protocol.address);
      await vault.connect(staker).withdrawFeeClaimFor(referrer.address);
      expect(await token.balanceOf(protocol.address)).to.eq(usdc(2));
      expect(await token.balanceOf(referrer.address)).to.eq(usdc(1));
      expect(await vault.totalLiabilities()).to.eq(usdc(97));
    });

    it("aggregates duplicate fee recipients without changing total liabilities", async () => {
      const { controller, staker, maker: feeRecipient, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("duplicate-fee-recipient");
      const releaseTime = (await time.latest()) + DAY;
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, releaseTime);
      await token.transfer(vault.address, usdc(100));
      await vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), releaseTime, [
        { feeType: 0, recipient: feeRecipient.address, amount: usdc(2) },
        { feeType: 1, recipient: feeRecipient.address, amount: usdc(1) },
      ]);

      await time.increaseTo(releaseTime);
      await vault.connect(controller).releaseDeferredStake(intentHash);

      expect(await vault.claimableFees(feeRecipient.address)).to.eq(usdc(3));
      expect(await vault.totalClaimableFees()).to.eq(usdc(3));
      expect(await vault.stakeBalance(staker.address)).to.eq(usdc(97));
      expect(await vault.totalLiabilities()).to.eq(usdc(100));
    });

    it("slashes the full gross stake to the maker and cancels every contingent fee", async () => {
      const { controller, staker, maker, recipient: feeRecipient, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, 0);
      await token.transfer(vault.address, usdc(100));
      await vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), 0, [
        { feeType: 0, recipient: feeRecipient.address, amount: usdc(2) },
      ]);

      await vault.connect(controller).slashDeferredStake(intentHash, maker.address);

      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(0);
      expect(await vault.stakeBalance(staker.address)).to.eq(0);
      expect(await vault.reservedStake(staker.address)).to.eq(0);
      expect(await vault.claimableCompensation(maker.address)).to.eq(usdc(100));
      expect(await vault.claimableFees(feeRecipient.address)).to.eq(0);
      expect(await vault.totalDeferredFees()).to.eq(0);
      expect(await vault.totalLiabilities()).to.eq(usdc(100));
    });

    it("rejects new deferred authorizations while reservations are paused", async () => {
      const { owner, controller, staker, vault } = await deployFixture();
      await vault.connect(owner).setStakeOperationsPaused(false, true);

      await expect(
        vault.connect(controller).authorizeDeferredStake(ethers.utils.id("deferred"), staker.address, 0),
      ).to.be.revertedWithCustomError(vault, "StakeActionPaused");
    });

    it("funds an already-authorized deferred stake while new reservations are paused", async () => {
      const { owner, controller, staker, token, vault } = await deployFixture();
      const intentHash = ethers.utils.id("deferred");
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, DAY);
      await vault.connect(owner).setStakeOperationsPaused(false, true);
      await token.transfer(vault.address, usdc(100));

      await vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), 2 * DAY, []);

      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(usdc(100));
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
      await vault.connect(controller).authorizeDeferredStake(intentHash, staker.address, DAY);
      await vault.connect(owner).proposeController(nextController.address);
      await time.increase(DAY);
      await vault.connect(nextController).acceptController();
      await token.transfer(vault.address, usdc(100));

      await expect(
        vault.connect(nextController).recordDeferredStake(intentHash, staker.address, usdc(100), 2 * DAY, []),
      ).to.be.revertedWithCustomError(vault, "UnauthorizedPositionController");
      await vault.connect(controller).recordDeferredStake(intentHash, staker.address, usdc(100), 2 * DAY, []);

      expect((await vault.getDeferredStake(intentHash)).grossAmount).to.eq(usdc(100));
    });
  });
});
