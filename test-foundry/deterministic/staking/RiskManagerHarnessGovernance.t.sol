// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {RiskManagerHarnessFixture} from "../helpers/RiskManagerHarnessFixture.sol";
import {RiskManager} from "contracts/RiskManager.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";

contract RiskManagerHarnessGovernanceTest is RiskManagerHarnessFixture {
    event AttestationVerifierUpdated(address indexed previousVerifier, address indexed newVerifier);
    event AdmissionPausedUpdated(bool paused);

    function test_RiskManagerConstructorRejectsZeroAndEoaDependencies() public {
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            address(0),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            address(this),
            IOrchestratorV3(other),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(other),
            IAttestationVerifier(address(verifier)),
            INullifierRegistryV2(address(nullifierRegistry))
        );
    }

    function test_RiskManagerGovernanceUpdatesVerifierPauseAndVaultController() public {
        AttestationVerifierMock nextVerifier = new AttestationVerifierMock();
        vm.expectEmit(true, true, false, false, address(manager));
        emit AttestationVerifierUpdated(address(verifier), address(nextVerifier));
        manager.setAttestationVerifier(address(nextVerifier));
        vm.expectEmit(false, false, false, true, address(manager));
        emit AdmissionPausedUpdated(true);
        manager.setAdmissionPaused(true);
        manager.acceptVaultController();
        assertEq(vault.acceptControllerCalls(), 1);
    }

    function test_RiskManagerGovernanceRejectsNonOwnerAndInvalidVerifier() public {
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(other);
        manager.setAdmissionPaused(true);
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        manager.setAttestationVerifier(address(0));
        vm.expectRevert(IRiskManager.ZeroAddress.selector);
        manager.setAttestationVerifier(other);
    }

    function test_RiskManagerConfigAcceptsDeferredAndRejectsInvalidCombinations() public {
        manager.setPlatformRiskConfig(PAYPAL, _chargebackConfig(true));
        assertTrue(manager.getPlatformRiskConfig(PAYPAL).chargeback.deferredPayoutEnabled);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, bytes32(0)));
        manager.setPlatformRiskConfig(bytes32(0), _nonChargebackConfig());

        IRiskManager.PlatformRiskConfig memory partialReserve = _chargebackConfig(false);
        partialReserve.chargeback.reserveBps = 9_999;
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, PAYPAL));
        manager.setPlatformRiskConfig(PAYPAL, partialReserve);

        IRiskManager.PlatformRiskConfig memory invalidDeferred = _nonChargebackConfig();
        invalidDeferred.chargeback.deferredPayoutEnabled = true;
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.InvalidPlatformConfig.selector, ZELLE));
        manager.setPlatformRiskConfig(ZELLE, invalidDeferred);
    }

    function test_RiskManagerFormulaBranchesRoundUpAndHandleZero() public view {
        assertEq(manager.calculateChargebackReserve(101, 5_000), 51);
        assertEq(manager.calculateIntentExtensionCost(100, PERIOD, 0), 0);
        (uint256 penalty, uint64 chargeableTime) = manager.calculateIntentExtensionPenalty(100, 10, 10, PERIOD, 10);
        assertEq(penalty, 0);
        assertEq(chargeableTime, 0);
    }
}
