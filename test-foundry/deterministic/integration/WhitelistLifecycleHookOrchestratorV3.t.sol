// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistLifecycleHook} from "contracts/hooks/WhitelistLifecycleHook.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IChargebackPolicy} from "contracts/interfaces/IChargebackPolicy.sol";
import {IIntentLifecycleHook} from "contracts/interfaces/IIntentLifecycleHook.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
import {IWhitelistPolicy} from "contracts/interfaces/IWhitelistPolicy.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract WhitelistLifecycleHookOrchestratorV3Test is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;

    WhitelistPolicy internal whitelistPolicy;
    WhitelistLifecycleHook internal whitelistHook;

    function setUp() public override {
        super.setUp();
        whitelistPolicy = new WhitelistPolicy(new AddressGroupRegistry(), escrowRegistry, orchestratorRegistry);
        whitelistHook = new WhitelistLifecycleHook(orchestratorRegistry, whitelistPolicy);
        orchestrator.setLifecycleHook(whitelistHook);
    }

    function test_ConstructorRejectsZeroAndNonContractDependencies() public {
        vm.expectRevert(WhitelistLifecycleHook.ZeroAddress.selector);
        new WhitelistLifecycleHook(IOrchestratorRegistry(address(0)), whitelistPolicy);

        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.InvalidDependency.selector, other));
        new WhitelistLifecycleHook(IOrchestratorRegistry(other), whitelistPolicy);

        vm.expectRevert(WhitelistLifecycleHook.ZeroAddress.selector);
        new WhitelistLifecycleHook(orchestratorRegistry, IWhitelistPolicy(address(0)));

        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.InvalidDependency.selector, other));
        new WhitelistLifecycleHook(orchestratorRegistry, IWhitelistPolicy(other));
    }

    function test_DisabledWhitelistPassesThroughAndSnapshotsHook() public {
        bytes32 intentHash = _signalDefault();

        assertEq(address(orchestrator.getIntentLifecycleHook(intentHash)), address(whitelistHook));
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function test_EnabledWhitelistRejectsNonMemberAndAcceptsMember() public {
        vm.prank(depositor);
        whitelistPolicy.setEnabled(address(escrow), depositId, true);

        vm.expectRevert(
            abi.encodeWithSelector(
                WhitelistLifecycleHook.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());

        address[] memory takers = new address[](1);
        takers[0] = taker;
        vm.prank(depositor);
        whitelistPolicy.addWhitelistedAddresses(address(escrow), depositId, takers);

        assertNotEq(_signalDefault(), bytes32(0));
    }

    function test_RegisteredOrchestratorWithUnknownIntentFailsClosed() public {
        bytes32 unknownIntent = keccak256("unknown-intent");
        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.IntentNotFound.selector, unknownIntent));
        vm.prank(address(orchestrator));
        whitelistHook.onIntentSignaled(unknownIntent);
    }

    function test_UnauthorizedLifecycleCallbacksRevert() public {
        bytes32 intentHash = keccak256("intent");
        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        whitelistHook.onIntentSignaled(intentHash);

        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        whitelistHook.onIntentCancelled(intentHash);

        IIntentLifecycleHook.SettlementContext memory context = IIntentLifecycleHook.SettlementContext({
            intentHash: intentHash,
            token: address(token),
            recipient: taker,
            releaseAmount: 0,
            netAmount: 0,
            isManualRelease: false
        });
        vm.expectRevert(abi.encodeWithSelector(WhitelistLifecycleHook.UnauthorizedOrchestrator.selector, other));
        vm.prank(other);
        whitelistHook.settleIntent(context);
    }

    function test_AuthorizedTerminalCallbacksAreNoOps() public {
        bytes32 cancelledIntent = _signalDefault();
        bytes32 settledIntent = _signalDefault();

        vm.prank(taker);
        orchestrator.cancelIntent(cancelledIntent);
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(settledIntent);

        assertEq(escrow.getDepositIntent(depositId, cancelledIntent).intentHash, bytes32(0));
        assertEq(escrow.getDepositIntent(depositId, settledIntent).intentHash, bytes32(0));
    }

    function test_RotationTerminatesSnapshottedWhitelistIntentsAndRoutesFreshIntentToCombinedHook() public {
        (StakeVault vault, ChargebackPolicy chargebackPolicy, IntentLifecycleHookV1 combinedHook) =
            _deployChargebackStack();

        vm.prank(depositor);
        chargebackPolicy.setChargebackEnabled(address(escrow), depositId, true);

        bytes32 oldCancelledIntent = _signalDefault();
        bytes32 oldSettledIntent = _signalDefault();
        assertEq(address(orchestrator.getIntentLifecycleHook(oldCancelledIntent)), address(whitelistHook));
        assertEq(address(orchestrator.getIntentLifecycleHook(oldSettledIntent)), address(whitelistHook));

        orchestrator.setLifecycleHook(combinedHook);
        bytes32 freshIntent = _signalDefault();
        assertEq(address(orchestrator.getIntentLifecycleHook(freshIntent)), address(combinedHook));
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(freshIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.PENDING)
        );

        vm.prank(taker);
        orchestrator.cancelIntent(oldCancelledIntent);
        verifier.setShouldVerifyPayment(true);
        _fulfill(oldSettledIntent, 40e6, CONVERSION_RATE);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(oldCancelledIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(oldSettledIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );

        vm.prank(taker);
        orchestrator.cancelIntent(freshIntent);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(freshIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CANCELLED)
        );
        assertEq(vault.lockedStake(taker), 0);
    }

    function _deployChargebackStack()
        internal
        returns (StakeVault vault, ChargebackPolicy chargebackPolicy, IntentLifecycleHookV1 combinedHook)
    {
        vault = new StakeVault(address(this), token, address(0), 1 days);
        NullifierRegistry chargebackNullifierRegistry = new NullifierRegistry();
        chargebackPolicy = new ChargebackPolicy(
            address(this),
            vault,
            new ChargebackVerifier(
                address(this), new NullifierRegistryV2(new NullifierRegistry()), new AttestationVerifierMock()
            ),
            chargebackNullifierRegistry
        );
        vault.initializeController(address(chargebackPolicy));
        chargebackNullifierRegistry.addWritePermission(address(chargebackPolicy));
        combinedHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, chargebackPolicy);
        chargebackPolicy.setLifecycleHookAuthorization(address(combinedHook), true);
        chargebackPolicy.setRiskWindow(METHOD, RISK_WINDOW);

        token.transfer(taker, STAKE_AMOUNT);
        vm.startPrank(taker);
        token.approve(address(vault), STAKE_AMOUNT);
        vault.depositStake(STAKE_AMOUNT);
        vm.stopPrank();
    }
}
