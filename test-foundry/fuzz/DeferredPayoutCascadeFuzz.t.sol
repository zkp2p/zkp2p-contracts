// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IIntentSettlementPolicy as S} from "contracts/interfaces/IIntentSettlementPolicy.sol";
import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {DisputeProtectionStackV2Fixture} from "../deterministic/helpers/DisputeProtectionStackV2Fixture.sol";
import {StakeVaultV2} from "contracts/StakeVaultV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {DisputeProtectionPolicyV2} from "contracts/hooks/DisputeProtectionPolicyV2.sol";
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
    StakeVaultV2 internal vault;
    DisputeProtectionPolicyV2 internal policy;

    function setUp() public {
        token = new USDCMock(1e18, "USDC", "USDC");
        vault = new StakeVaultV2(address(this), token);
        address[] memory signers = new address[](1);
        signers[0] = vm.addr(0xA11CE);
        DisputeVerifier verifier = new DisputeVerifier(address(this), new NullifierRegistryV2(new NullifierRegistry()), new MultiAttestationVerifier(signers, 1));
        NullifierRegistry disputes = new NullifierRegistry();
        policy = new DisputeProtectionPolicyV2(address(this), vault, verifier, disputes);
        vault.setController(address(policy), true);
        policy.setOrchestratorAuthorization(address(this), true);
        disputes.addWritePermission(address(policy));
    }

    function testFuzz_LockedAmountMatchesPath(uint256 releaseAmount, uint256 freeStake, uint256 protocolBps, uint256 referralBps) public {
        releaseAmount = bound(releaseAmount, 1, 1e12);
        freeStake = bound(freeStake, 0, 2e12);
        uint256 net = _settle(releaseAmount, freeStake, protocolBps, referralBps);
        bool staked = freeStake >= releaseAmount;
        assertEq(policy.getProtection(ID).depositor, DEPOSITOR);
        (address owner, uint256 amount,) = vault.locks(ID);
        assertEq(amount, staked ? releaseAmount : net);
        assertEq(owner, staked ? TAKER : RECIPIENT);
        assertEq(token.balanceOf(RECIPIENT), staked ? net : 0);
    }

    function testFuzz_VaultBalanceCoversAccounting(uint256 releaseAmount, uint256 freeStake, uint256 protocolBps, uint256 referralBps) public {
        releaseAmount = bound(releaseAmount, 1, 1e12);
        freeStake = bound(freeStake, 0, 2e12);
        _settle(releaseAmount, freeStake, protocolBps, referralBps);
        (address owner, uint256 amount, uint64 maturesAt) = vault.locks(ID);
        vm.warp(maturesAt);
        policy.release(_ids(ID));
        _accounting();
        if (owner == RECIPIENT) {
            vm.prank(RECIPIENT);
            vault.withdrawStake(amount);
        } else {
            vm.prank(TAKER);
            vault.withdrawStake(freeStake);
        }
        _accounting();
    }

    function testFuzz_AttestedWindowSetsMaturity(uint64 window, bool staked) public {
        window = uint64(bound(window, 1, 180 days));
        if (staked) _deposit(TAKER, 100e6);
        S.SettlementContext memory context = S.SettlementContext(ID, address(token), TAKER, RECIPIENT, DEPOSITOR, METHOD, 100e6, 99e6, abi.encode(uint256(window)));
        bool deferred = policy.settleIntent(context) != address(0);
        assertEq(deferred, !staked);
        if (deferred) {
            token.transfer(address(vault), 99e6);
            policy.onDeferredPayoutFunded(context);
        }
        (address owner,, uint64 maturesAt) = vault.locks(ID);
        assertEq(owner, staked ? TAKER : RECIPIENT);
        assertEq(maturesAt, block.timestamp + window);
    }

    function _settle(uint256 gross, uint256 freeStake, uint256 protocolBps, uint256 referralBps) internal returns (uint256 net) {
        protocolBps = bound(protocolBps, 0, 6000);
        referralBps = bound(referralBps, 0, 6000 - protocolBps);
        uint256 protocolFee = gross * protocolBps / 10000;
        uint256 referralFee = gross * referralBps / 10000;
        net = gross - protocolFee - referralFee;
        if (freeStake != 0) _deposit(TAKER, freeStake);
        S.SettlementContext memory context = S.SettlementContext(ID, address(token), TAKER, RECIPIENT, DEPOSITOR, METHOD, gross, net, abi.encode(uint256(WINDOW)));
        bool deferred = policy.settleIntent(context) != address(0);
        _accounting();
        token.transfer(address(0x44), protocolFee);
        token.transfer(address(0x55), referralFee);
        _accounting();
        token.transfer(deferred ? address(vault) : RECIPIENT, net);
        _accounting();
        if (deferred) {
            policy.onDeferredPayoutFunded(context);
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

    function _accounting() internal view {
        assertGe(token.balanceOf(address(vault)), vault.totalAccounted());
    }

    function _ids(bytes32 id) internal pure returns (bytes32[] memory ids) {
        ids = new bytes32[](1);
        ids[0] = id;
    }
}

contract WhitelistedPayoutFuzzTest is DisputeProtectionStackV2Fixture {
    function testFuzz_WhitelistedWindowedSettlementCreatesNoRecord(uint64 window, uint256 stake) public {
        window = uint64(bound(window, 1, 180 days));
        stake = bound(stake, 0, 2 * INTENT_AMOUNT);
        if (stake != 0) _stake(vault, taker, stake);
        address[] memory takers = new address[](1);
        takers[0] = taker;
        vm.prank(depositor);
        whitelist.configureDeposit(address(escrow), depositId, METHOD, true, new bytes32[](0), takers);
        bytes32 id = _signalDefault();
        vm.recordLogs();
        vm.record();
        _settle(id, INTENT_AMOUNT, window);
        (, bytes32[] memory writes) = vm.accesses(address(protection));

        assertEq(writes.length, 0);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 i; i < logs.length; ++i) assertTrue(logs[i].emitter != address(protection));
        vm.clearMockedCalls();
        assertEq(protection.getProtection(id).depositor, address(0));
        assertEq(token.balanceOf(other), NET);
        assertEq(vault.freeStake(taker), stake);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.lockedStake(other), 0);
    }
}
