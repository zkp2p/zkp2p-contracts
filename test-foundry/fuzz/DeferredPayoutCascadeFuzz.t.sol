// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
import {IDisputeProtectionPolicyV2 as P} from "contracts/interfaces/IDisputeProtectionPolicyV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";

contract DeferredPayoutCascadeFuzzTest is Test {
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant ID = keccak256("payout");
    uint64 internal constant WINDOW = 14 days;
    address internal constant TAKER = address(0x11);
    address internal constant RECIPIENT = address(0x22);
    address internal constant DEPOSITOR = address(0x33);
    USDCMock internal token;
    StakeVault internal vault;
    DisputeProtectionPolicyV2 internal policy;

    function setUp() public {
        token = new USDCMock(1e18, "USDC", "USDC");
        vault = new StakeVault(address(this), token, address(0), 0);
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(0xA11CE);
        DisputeVerifier verifier = new DisputeVerifier(address(this), new NullifierRegistryV2(new NullifierRegistry()), new MultiAttestationVerifier(signers, 1));
        NullifierRegistry disputes = new NullifierRegistry();
        policy = new DisputeProtectionPolicyV2(address(this), vault, verifier, disputes);
        vault.initializeController(address(policy));
        policy.setLifecycleHookAuthorization(address(this), true);
        disputes.addWritePermission(address(policy));
    }

    function testFuzz_LockedAmountMatchesPath(uint256 releaseAmount, uint256 freeStake, bool whitelisted, uint256 protocolBps, uint256 referralBps) public {
        releaseAmount = bound(releaseAmount, 1, 1e12);
        freeStake = bound(freeStake, 0, 2e12);
        uint256 net = _settle(releaseAmount, freeStake, whitelisted, protocolBps, referralBps);
        uint256 expected = whitelisted ? 0 : freeStake >= releaseAmount ? releaseAmount : net;
        P.CollateralSource source = whitelisted ? P.CollateralSource.NONE : freeStake >= releaseAmount ? P.CollateralSource.STAKE : P.CollateralSource.DEFERRED_PAYOUT;
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(record.lockedAmount, expected);
        assertEq(uint256(record.collateralSource), uint256(source));
        (address owner, uint256 amount,) = vault.locks(ID);
        assertEq(amount, expected);
        assertEq(owner, whitelisted ? address(0) : freeStake >= releaseAmount ? TAKER : RECIPIENT);
        assertEq(token.balanceOf(RECIPIENT), source == P.CollateralSource.DEFERRED_PAYOUT ? 0 : net);
    }

    function testFuzz_VaultBalanceCoversAccounting(uint256 releaseAmount, uint256 freeStake, bool whitelisted, uint256 protocolBps, uint256 referralBps) public {
        releaseAmount = bound(releaseAmount, 1, 1e12);
        freeStake = bound(freeStake, 0, 2e12);
        _settle(releaseAmount, freeStake, whitelisted, protocolBps, referralBps);
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        if (!whitelisted) {
            vm.warp(record.releaseEligibleAt);
            policy.releaseMaturedDisputeProtectionIntent(ID);
            _accounting();
            if (record.collateralSource == P.CollateralSource.DEFERRED_PAYOUT) {
                vm.prank(TAKER);
                policy.claimFor(ID);
            } else {
                vm.prank(TAKER);
                vault.withdrawStake(freeStake);
            }
            _accounting();
        }
    }

    function testFuzz_AttestedWindowSetsMaturity(uint64 window, bool staked) public {
        window = uint64(bound(window, 1, 180 days));
        if (staked) _deposit(TAKER, 100e6);
        bool deferred = policy.onIntentSettled(P.SettleParams(ID, TAKER, RECIPIENT, DEPOSITOR, address(token), METHOD, 100e6, 99e6, window, false));
        P.DisputeProtectionIntent memory record = policy.getDisputeProtectionIntent(ID);
        assertEq(deferred, !staked);
        assertEq(record.riskWindow, window);
        assertEq(record.releaseEligibleAt, block.timestamp + window);
        assertEq(uint256(record.collateralSource), uint256(staked ? P.CollateralSource.STAKE : P.CollateralSource.DEFERRED_PAYOUT));
    }

    function testFuzz_ClaimForNeverExceedsLocked(uint256 releaseAmount, uint256 freeStake, uint256 protocolBps, uint256 referralBps, uint256 seed) public {
        releaseAmount = bound(releaseAmount, 1, 1e12);
        freeStake = bound(freeStake, 0, releaseAmount - 1);
        uint256 net = _settle(releaseAmount, freeStake, false, protocolBps, referralBps);
        vm.warp(policy.getDisputeProtectionIntent(ID).releaseEligibleAt);
        policy.releaseMaturedDisputeProtectionIntent(ID);
        _accounting();
        uint256 paid;
        for (uint256 step; step < 8; ++step) {
            seed = uint256(keccak256(abi.encode(seed, step)));
            uint256 available = vault.freeStake(RECIPIENT);
            uint256 relocked = bound(seed, 0, available);
            bytes32 lockId = keccak256(abi.encode("relock", step));
            if (relocked != 0) {
                assertFalse(policy.onIntentSettled(P.SettleParams(lockId, RECIPIENT, TAKER, DEPOSITOR, address(token), METHOD, relocked, relocked, WINDOW, false)));
                _accounting();
            }
            paid += _claim(net - paid, step % 2 == 0 ? TAKER : RECIPIENT);
            assertLe(paid, net);
            assertEq(policy.getDisputeProtectionIntent(ID).claimedAmount, paid);
            if (relocked != 0) {
                vm.warp(policy.getDisputeProtectionIntent(lockId).releaseEligibleAt);
                policy.releaseMaturedDisputeProtectionIntent(lockId);
                _accounting();
            }
        }
        paid += _claim(net - paid, TAKER);
        assertEq(paid, net);
        assertEq(token.balanceOf(RECIPIENT), net);
        _deposit(RECIPIENT, releaseAmount);
        _claim(0, TAKER);
        assertEq(token.balanceOf(RECIPIENT), net);
        assertEq(vault.freeStake(RECIPIENT), releaseAmount);
    }

    function _settle(uint256 gross, uint256 freeStake, bool whitelisted, uint256 protocolBps, uint256 referralBps) internal returns (uint256 net) {
        protocolBps = bound(protocolBps, 0, 6000);
        referralBps = bound(referralBps, 0, 6000 - protocolBps);
        uint256 protocolFee = gross * protocolBps / 10000;
        uint256 referralFee = gross * referralBps / 10000;
        net = gross - protocolFee - referralFee;
        if (freeStake != 0) _deposit(TAKER, freeStake);
        bool deferred = policy.onIntentSettled(P.SettleParams(ID, TAKER, RECIPIENT, DEPOSITOR, address(token), METHOD, gross, net, WINDOW, whitelisted));
        _accounting();
        token.transfer(address(0x44), protocolFee);
        token.transfer(address(0x55), referralFee);
        _accounting();
        token.transfer(deferred ? address(vault) : RECIPIENT, net);
        _accounting();
        if (deferred) {
            policy.onDeferredPayoutFunded(ID);
            _accounting();
        }
    }

    function _deposit(address owner, uint256 amount) internal {
        token.transfer(owner, amount);
        vm.startPrank(owner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
        _accounting();
    }

    function _claim(uint256 remaining, address caller) internal returns (uint256 paid) {
        uint256 available = vault.freeStake(RECIPIENT);
        uint256 expected = remaining < available ? remaining : available;
        uint256 beforeBalance = token.balanceOf(RECIPIENT);
        if (expected == 0) vm.expectRevert(abi.encodeWithSelector(P.NothingToClaim.selector, ID));
        vm.prank(caller);
        policy.claimFor(ID);
        paid = token.balanceOf(RECIPIENT) - beforeBalance;
        assertEq(paid, expected);
        _accounting();
    }

    function _accounting() internal view {
        assertGe(token.balanceOf(address(vault)), vault.totalAccounted());
    }
}
