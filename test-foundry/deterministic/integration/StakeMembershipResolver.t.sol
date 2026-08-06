// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {StakeMembershipResolver} from "contracts/hooks/StakeMembershipResolver.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

/**
 * @notice POC coverage for resolver-only stake-backed groups on the unchanged V3 lifecycle stack:
 * StakeMembershipResolver supplies live stake-derived membership through AddressGroupRegistry, and
 * the deployed IntentLifecycleHookV1 + ChargebackPolicy lane keeps enforcing collateral. The suite
 * also pins the V1 routing trap as executable documentation: a stake-derived group added to a
 * covered deposit's whitelist admits members WITHOUT a lock, so covered deposits must not do that.
 */
contract StakeMembershipResolverIntegrationTest is OrchestratorV3Fixture {
    uint256 internal constant MIN_STAKE = 100e6; // above the fixture's 50e6 INTENT_AMOUNT
    uint64 internal constant RISK_WINDOW = 7 days;

    bytes32 internal STAKED;

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal policy;
    StakeVault internal stakeVault;
    ChargebackPolicy internal chargebackPolicy;
    StakeMembershipResolver internal resolver;
    IntentLifecycleHookV1 internal lifecycleHook;

    function setUp() public override {
        super.setUp();

        groupRegistry = new AddressGroupRegistry();
        STAKED = groupRegistry.createGroup("staked-takers");

        policy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        stakeVault = new StakeVault(address(this), token, address(0), 1 days);
        NullifierRegistry chargebackNullifierRegistry = new NullifierRegistry();
        chargebackPolicy = new ChargebackPolicy(
            address(this),
            stakeVault,
            new ChargebackVerifier(
                address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()
            ),
            chargebackNullifierRegistry
        );
        stakeVault.initializeController(address(chargebackPolicy));
        chargebackNullifierRegistry.addWritePermission(address(chargebackPolicy));

        resolver = new StakeMembershipResolver(stakeVault, groupRegistry);
        groupRegistry.setResolver(STAKED, address(resolver));
        resolver.setGroupMinStake(STAKED, MIN_STAKE);

        lifecycleHook = new IntentLifecycleHookV1(orchestratorRegistry, policy, chargebackPolicy);
        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        IOrchestratorV3(address(orchestrator)).setLifecycleHook(lifecycleHook);
        chargebackPolicy.setRiskWindow(METHOD, RISK_WINDOW);

        vm.prank(depositor);
        chargebackPolicy.setChargebackEnabled(address(escrow), depositId, true);
    }

    /* ============ Resolver Membership ============ */

    function test_ResolverMembershipTracksStakeLive() public {
        assertFalse(groupRegistry.isMember(STAKED, taker));

        _stake(taker, MIN_STAKE);
        assertTrue(groupRegistry.isMember(STAKED, taker));

        vm.prank(taker);
        stakeVault.withdrawStake(1);
        assertFalse(groupRegistry.isMember(STAKED, taker));
    }

    function test_ResolverMembershipFollowsTakerDelegation() public {
        _stake(depositor, MIN_STAKE); // depositor doubles as a stake owner backing a hot wallet

        vm.prank(depositor);
        stakeVault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        stakeVault.selectStakeOwner(depositor);

        assertTrue(groupRegistry.isMember(STAKED, taker));

        vm.prank(depositor);
        stakeVault.setTakerAuthorization(taker, false);
        assertFalse(groupRegistry.isMember(STAKED, taker));
    }

    function test_ResolverFailsClosedAndCuratorAuth() public {
        bytes32 unconfigured = groupRegistry.createGroup("unconfigured");
        groupRegistry.setResolver(unconfigured, address(resolver));
        _stake(taker, MIN_STAKE);
        assertFalse(groupRegistry.isMember(unconfigured, taker)); // zero threshold = fail closed

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(StakeMembershipResolver.UnauthorizedGroupCurator.selector, STAKED, other)
        );
        resolver.setGroupMinStake(STAKED, 1);

        vm.expectRevert(
            abi.encodeWithSelector(StakeMembershipResolver.GroupNotFound.selector, bytes32(uint256(0xdead)))
        );
        resolver.setGroupMinStake(bytes32(uint256(0xdead)), 1);
    }

    /* ============ Enforcement Stays With The Deployed Chargeback Lane ============ */

    function test_ChargebackLaneLocksStakerWithoutLifecycleChanges() public {
        _stake(taker, INTENT_AMOUNT); // whitelist stays disabled: pure stake lane

        bytes32 intentHash = _signalDefault();

        (address stakeOwner, uint256 lockAmount,) = stakeVault.locks(intentHash);
        assertEq(stakeOwner, taker);
        assertEq(lockAmount, INTENT_AMOUNT);
        assertEq(stakeVault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_ChargebackLaneRejectsInsufficientFreeStake() public {
        _stake(taker, INTENT_AMOUNT - 1);

        vm.expectRevert(
            abi.encodeWithSelector(
                IStakeVault.InsufficientFreeStake.selector, taker, INTENT_AMOUNT - 1, INTENT_AMOUNT
            )
        );
        _signalCall(taker, _defaultParams());
    }

    /* ============ Executable Documentation Of The V1 Routing Trap ============ */

    function test_Trap_StakeGroupOnCoveredDepositWhitelistBypassesLock() public {
        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groups(STAKED), new address[](0));
        _stake(taker, MIN_STAKE);

        bytes32 intentHash = _signalDefault();

        // Member admitted through the whitelist branch: NO collateral locked. This is why covered
        // deposits must not add the stake-derived group to their whitelist under V1 routing.
        (, uint256 lockAmount,) = stakeVault.locks(intentHash);
        assertEq(lockAmount, 0);
        assertEq(stakeVault.lockedStake(taker), 0);
    }

    /* ============ Helpers ============ */

    function _stake(address _staker, uint256 _amount) internal {
        token.transfer(_staker, _amount);
        vm.startPrank(_staker);
        token.approve(address(stakeVault), _amount);
        stakeVault.depositStake(_amount);
        vm.stopPrank();
    }

    function _groups(bytes32 _groupId) internal pure returns (bytes32[] memory groupIds) {
        groupIds = new bytes32[](1);
        groupIds[0] = _groupId;
    }
}
