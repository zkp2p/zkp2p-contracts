// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IntentLifecycleHookV2} from "contracts/hooks/IntentLifecycleHookV2.sol";
import {StakeMembershipResolver} from "contracts/hooks/StakeMembershipResolver.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

/**
 * @notice POC coverage for the stake-backed group periphery: StakeMembershipResolver (live,
 * stake-derived group membership) composed with IntentLifecycleHookV2's collateralized-membership
 * routing (whitelist identity AND chargeback stake lock on the same deposit).
 */
contract StakeGroupCollateralizedMembershipTest is OrchestratorV3Fixture {
    uint256 internal constant MIN_STAKE = 100e6; // above the fixture's 50e6 INTENT_AMOUNT
    uint64 internal constant RISK_WINDOW = 7 days;

    bytes32 internal STAKED;

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal policy;
    StakeVault internal stakeVault;
    ChargebackPolicy internal chargebackPolicy;
    StakeMembershipResolver internal resolver;
    IntentLifecycleHookV2 internal lifecycleHook;

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

        lifecycleHook = new IntentLifecycleHookV2(orchestratorRegistry, policy, chargebackPolicy);
        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        IOrchestratorV3(address(orchestrator)).setLifecycleHook(lifecycleHook);
        chargebackPolicy.setRiskWindow(METHOD, RISK_WINDOW);

        vm.prank(depositor);
        chargebackPolicy.setChargebackEnabled(address(escrow), depositId, true);
        vm.prank(depositor);
        policy.configureDeposit(address(escrow), depositId, true, _groups(STAKED), new address[](0));
    }

    function test_ResolverMembershipTracksStakeLive() public {
        assertFalse(groupRegistry.isMember(STAKED, taker));

        _stake(taker, MIN_STAKE);
        assertTrue(groupRegistry.isMember(STAKED, taker));

        vm.prank(taker);
        stakeVault.withdrawStake(1);
        assertFalse(groupRegistry.isMember(STAKED, taker));
    }

    function test_CollateralizedMembership_MemberIsAdmittedAndLocked() public {
        vm.prank(depositor);
        lifecycleHook.setCollateralizedMembership(address(escrow), depositId, true);
        _stake(taker, MIN_STAKE);

        bytes32 intentHash = _signalDefault();

        (address stakeOwner, uint256 lockAmount,) = stakeVault.locks(intentHash);
        assertEq(stakeOwner, taker);
        assertEq(lockAmount, INTENT_AMOUNT);
        assertEq(stakeVault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_CollateralizedMembership_UnderThresholdReverts() public {
        vm.prank(depositor);
        lifecycleHook.setCollateralizedMembership(address(escrow), depositId, true);
        _stake(taker, INTENT_AMOUNT); // covers the intent but sits below the membership threshold

        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV2.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());

        assertEq(stakeVault.lockedStake(taker), 0);
    }

    function test_DefaultRoutingKeepsV1MembershipBypass() public {
        _stake(taker, MIN_STAKE); // member via resolver, but the deposit did not opt into the new mode

        bytes32 intentHash = _signalDefault();

        (, uint256 lockAmount,) = stakeVault.locks(intentHash);
        assertEq(lockAmount, 0); // V1 semantics preserved: whitelist admission bypasses the stake lock
        assertEq(stakeVault.lockedStake(taker), 0);
    }

    function test_SetCollateralizedMembershipAuth() public {
        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV2.UnauthorizedCallerOrDelegate.selector, other, depositor, delegate
            )
        );
        lifecycleHook.setCollateralizedMembership(address(escrow), depositId, true);

        vm.prank(delegate);
        lifecycleHook.setCollateralizedMembership(address(escrow), depositId, true);
        assertTrue(lifecycleHook.isCollateralizedMembershipRequired(address(escrow), depositId));
    }

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
