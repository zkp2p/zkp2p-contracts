// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IStakeReferralLifecycleHook} from "contracts/interfaces/IStakeReferralLifecycleHook.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";
import {OrchestratorV3Fixture} from "./OrchestratorV3Fixture.sol";

abstract contract StakeReferralFixture is OrchestratorV3Fixture {
    uint256 internal constant L1_FEE = 4e15;
    uint256 internal constant STAKE = 500e6;
    address internal backer;
    address internal peer;
    StakeVault internal vault;
    DisputeProtectionPolicy internal protection;
    IntentLifecycleHookV1 internal hook;
    WhitelistPolicy internal whitelist;
    NullifierRegistryV2 internal nullifiers;

    function setUp() public override {
        super.setUp();
        backer = makeAddr("backer");
        peer = makeAddr("peer");
        vault = new StakeVault(address(this), token, address(0), 1 days);
        whitelist = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        nullifiers = new NullifierRegistryV2(new NullifierRegistry());
        NullifierRegistry disputeNullifiers = new NullifierRegistry();
        protection = new DisputeProtectionPolicy(
            address(this),
            vault,
            new DisputeVerifier(address(this), nullifiers, new AttestationVerifierMock()),
            disputeNullifiers
        );
        vault.initializeController(address(protection));
        disputeNullifiers.addWritePermission(address(protection));
        hook = new IntentLifecycleHookV1(orchestratorRegistry, whitelist, protection);
        protection.setLifecycleHookAuthorization(address(hook), true);
        protection.setRiskWindow(METHOD, 14 days);
        orchestrator.setLifecycleHook(hook);
        orchestrator.setStakeReferralConfig(IStakeReferralLifecycleHook(address(hook)), peer, L1_FEE);
        _stake(backer);
        vm.prank(backer);
        vault.setTakerAuthorization(taker, true);
        vm.prank(taker);
        vault.selectStakeOwner(backer);
        verifier.setShouldVerifyPayment(true);
    }

    function _stake(address owner) internal {
        token.transfer(owner, STAKE);
        vm.startPrank(owner);
        token.approve(address(vault), STAKE);
        vault.depositStake(STAKE);
        vm.stopPrank();
    }

    function _feesParams(uint256 peerFee, address makerL1)
        internal
        view
        returns (IOrchestratorV3.SignalIntentParams memory params)
    {
        params = _defaultParams();
        params.referralFees = new IReferralFee.ReferralFee[](3);
        params.referralFees[0] = IReferralFee.ReferralFee(peer, peerFee);
        params.referralFees[1] = IReferralFee.ReferralFee(makerL1, L1_FEE);
        params.referralFees[2] = IReferralFee.ReferralFee(other, 1e15);
    }
}
