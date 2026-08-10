// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {DisputeProtectionPolicy} from "contracts/hooks/DisputeProtectionPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IDisputeProtectionPolicy} from "contracts/interfaces/IDisputeProtectionPolicy.sol";
import {IDisputeVerifier} from "contracts/interfaces/IDisputeVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {DisputeVerifier} from "contracts/unifiedVerifier/DisputeVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract DisputeLifecycleHookOrchestratorV3Test is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    bytes32 internal constant WINDOWLESS_METHOD = keccak256("windowless");

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal whitelistPolicy;
    StakeVault internal vault;
    NullifierRegistryV2 internal nullifierRegistry;
    NullifierRegistry internal disputeNullifierRegistry;
    DisputeProtectionPolicy internal disputeProtectionPolicy;
    IntentLifecycleHookV1 internal lifecycleHook;

    function setUp() public override {
        super.setUp();
        groupRegistry = new AddressGroupRegistry();
        whitelistPolicy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        vault = new StakeVault(address(this), token, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        disputeNullifierRegistry = new NullifierRegistry();
        disputeProtectionPolicy = new DisputeProtectionPolicy(
            address(this),
            vault,
            new DisputeVerifier(address(this), nullifierRegistry, new AttestationVerifierMock()),
            disputeNullifierRegistry
        );
        vault.initializeController(address(disputeProtectionPolicy));
        disputeNullifierRegistry.addWritePermission(address(disputeProtectionPolicy));
        lifecycleHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, disputeProtectionPolicy);
        disputeProtectionPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        disputeProtectionPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        orchestrator.setLifecycleHook(lifecycleHook);
        _stake(taker, STAKE_AMOUNT);
    }

    function test_WhitelistOnWhitelistedWithDisputeProtectionOnSkipsStake() public {
        _setWhitelist(true, true);
        _setDisputeProtection(true);

        bytes32 intentHash = _signalDefault();

        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), 0);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function test_WhitelistOnNonMemberWithDisputeProtectionOnRequiresStakeBeforeEscrowLock() public {
        _setWhitelist(true, false);
        _setDisputeProtection(true);
        bytes32 intentHash = _signalDefault();
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );

        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 rejectedIntent = _intentHash(counterBefore);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(other, _paramsFor(other));
        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(escrow.getDepositIntent(depositId, rejectedIntent).intentHash, bytes32(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore);
    }

    function test_WhitelistOnNonMemberNonDisputableMethodGetsDirectAccess() public {
        _addPaymentMethod(WINDOWLESS_METHOD);
        _setWhitelist(true, false);
        _setDisputeProtection(true);
        IOrchestratorV3.SignalIntentParams memory params = _paramsFor(other);
        params.paymentMethod = WINDOWLESS_METHOD;

        bytes32 intentHash = _signal(other, params);

        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);

        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
    }

    function test_WhitelistOnNonMemberWithDisputeProtectionOffRejects() public {
        _setWhitelist(true, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV1.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());
    }

    function test_WhitelistOffDisputeProtectionOnRequiresStakeForEveryTaker() public {
        _setDisputeProtection(true);
        assertNotEq(_signalDefault(), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(other, _paramsFor(other));
    }

    function test_WhitelistOffDisputeProtectionOnNonDisputableMethodIsOpen() public {
        _addPaymentMethod(WINDOWLESS_METHOD);
        _setDisputeProtection(true);
        IOrchestratorV3.SignalIntentParams memory params = _paramsFor(other);
        params.paymentMethod = WINDOWLESS_METHOD;

        bytes32 intentHash = _signal(other, params);

        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(other, _paramsFor(other));
    }

    function test_WhitelistOffDisputeProtectionOffIsOpenAndCreatesNoDisputeProtectionIntent() public {
        bytes32 intentHash = _signal(other, _paramsFor(other));
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancelIntentAndExpiryPruneUnlockStake() public {
        _setDisputeProtection(true);
        bytes32 cancelledIntent = _signalDefault();
        vm.prank(taker);
        orchestrator.cancelIntent(cancelledIntent);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(cancelledIntent).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
        );

        bytes32 expiredIntent = _signalDefault();
        IEscrowV2.Intent memory intent = escrow.getDepositIntent(depositId, expiredIntent);
        vm.warp(intent.expiryTime + 1);
        escrow.pruneExpiredIntents(depositId);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(expiredIntent).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
        );
    }

    function test_SubMinimumFulfillResizesCoverageThenMaturityReleasesStake() public {
        _setDisputeProtection(true);
        bytes32 intentHash = _signalDefault();
        uint256 releaseAmount = 5e6;
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, releaseAmount, CONVERSION_RATE);

        IDisputeProtectionPolicy.DisputeProtectionIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getDisputeProtectionIntent(intentHash);
        assertEq(disputeProtectionIntent.releaseAmount, releaseAmount);
        assertEq(disputeProtectionIntent.releaseEligibleAt, releaseEligibleAt);
        (, uint256 lockedAmount, uint64 maturesAt) = vault.locks(intentHash);
        assertEq(lockedAmount, releaseAmount);
        assertEq(maturesAt, releaseEligibleAt);

        vm.warp(releaseEligibleAt);
        disputeProtectionPolicy.releaseMaturedDisputeProtectionIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT);
    }

    function test_ManualReleaseRetainsStakeButRejectsDisputeWithoutPaymentBinding() public {
        _setDisputeProtection(true);
        bytes32 intentHash = _signalDefault();
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        IDisputeProtectionPolicy.DisputeProtectionIntent memory disputeProtectionIntent =
            disputeProtectionPolicy.getDisputeProtectionIntent(intentHash);
        assertEq(disputeProtectionIntent.releaseAmount, INTENT_AMOUNT);
        assertEq(disputeProtectionIntent.releaseEligibleAt, releaseEligibleAt);
        assertEq(
            uint256(disputeProtectionIntent.status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT - INTENT_AMOUNT);

        bytes32 paymentId = keccak256("unbound-payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeVerifier.InvalidPaymentBinding.selector, intentHash, paymentNullifier)
        );
        disputeProtectionPolicy.submitDispute(_attestation(intentHash, paymentId, keccak256("dispute")));
    }

    function test_DisputeAfterFulfillPaysDepositorClaim() public {
        _setDisputeProtection(true);
        bytes32 intentHash = _signalDefault();
        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, intentHash);
        disputeProtectionPolicy.submitDispute(_attestation(intentHash, paymentId, keccak256("dispute")));

        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.DISPUTED)
        );
    }

    function test_PolicyAdmissionRevertBubblesRawAndRollsBackSignal() public {
        _setDisputeProtection(true);
        disputeProtectionPolicy.setAdmissionsPaused(true);
        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 rejectedIntent = _intentHash(counterBefore);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        vm.expectRevert(IDisputeProtectionPolicy.AdmissionsPaused.selector);
        _signalCall(taker, _defaultParams());

        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(orchestrator.getIntent(rejectedIntent).owner, address(0));
        assertEq(escrow.getDepositIntent(depositId, rejectedIntent).intentHash, bytes32(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore);
    }

    function test_CancellationWithoutDisputeProtectionIntentLeavesVaultUntouched() public {
        bytes32 intentHash = _signalDefault();
        uint256 totalBefore = vault.totalStaked();
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.totalStaked(), totalBefore);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(intentHash).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.NONE)
        );
    }

    function test_LifecycleHookRotationPreservesOldIntentsAndRoutesNewIntentsToNewHook() public {
        _setDisputeProtection(true);
        bytes32 oldCancelledIntent = _signalDefault();
        bytes32 oldSettledIntent = _signalDefault();
        IntentLifecycleHookV1 newLifecycleHook =
            new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, disputeProtectionPolicy);

        disputeProtectionPolicy.setLifecycleHookAuthorization(address(newLifecycleHook), true);
        orchestrator.setLifecycleHook(newLifecycleHook);

        disputeProtectionPolicy.setLifecycleHookAuthorization(address(lifecycleHook), false);
        vm.expectRevert(
            abi.encodeWithSelector(IDisputeProtectionPolicy.UnauthorizedLifecycleHook.selector, address(lifecycleHook))
        );
        vm.prank(taker);
        orchestrator.cancelIntent(oldCancelledIntent);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(oldCancelledIntent).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.PENDING)
        );

        disputeProtectionPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        vm.prank(taker);
        orchestrator.cancelIntent(oldCancelledIntent);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(oldCancelledIntent).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
        );

        uint256 releaseAmount = 40e6;
        verifier.setShouldVerifyPayment(true);
        _fulfill(oldSettledIntent, releaseAmount, CONVERSION_RATE);
        IDisputeProtectionPolicy.DisputeProtectionIntent memory oldSettledIntentState =
            disputeProtectionPolicy.getDisputeProtectionIntent(oldSettledIntent);
        assertEq(
            uint256(oldSettledIntentState.status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.SETTLED)
        );
        assertEq(oldSettledIntentState.releaseAmount, releaseAmount);

        bytes32 newIntent = _signalDefault();
        assertEq(address(orchestrator.getIntentLifecycleHook(newIntent)), address(newLifecycleHook));
        vm.prank(taker);
        orchestrator.cancelIntent(newIntent);
        assertEq(
            uint256(disputeProtectionPolicy.getDisputeProtectionIntent(newIntent).status),
            uint256(IDisputeProtectionPolicy.DisputeProtectionIntentStatus.CANCELLED)
        );
        assertEq(vault.lockedStake(taker), releaseAmount);
    }

    function _setWhitelist(bool enabled, bool includeTaker) internal {
        address[] memory takers = new address[](includeTaker ? 1 : 0);
        if (includeTaker) takers[0] = taker;
        vm.prank(depositor);
        whitelistPolicy.configureDeposit(address(escrow), depositId, enabled, new bytes32[](0), takers);
    }

    function _setDisputeProtection(bool enabled) internal {
        vm.prank(depositor);
        disputeProtectionPolicy.setDisputeProtectionEnabled(address(escrow), depositId, enabled);
    }

    function _addPaymentMethod(bytes32 _paymentMethod) internal {
        bytes32[] memory supportedCurrencies = new bytes32[](1);
        supportedCurrencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(_paymentMethod, address(verifier), supportedCurrencies);

        bytes32[] memory paymentMethods = new bytes32[](1);
        paymentMethods[0] = _paymentMethod;
        IEscrowV2.DepositPaymentMethodData[] memory paymentMethodData = new IEscrowV2.DepositPaymentMethodData[](1);
        paymentMethodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] =
            IEscrowV2.Currency({code: USD, minConversionRate: CONVERSION_RATE, oracleRateConfig: _emptyOracle()});

        vm.prank(depositor);
        escrow.addPaymentMethods(depositId, paymentMethods, paymentMethodData, currencies);
    }

    function _stake(address stakeOwner, uint256 amount) internal {
        token.transfer(stakeOwner, amount);
        vm.startPrank(stakeOwner);
        token.approve(address(vault), amount);
        vault.depositStake(amount);
        vm.stopPrank();
    }

    function _paramsFor(address recipient) internal view returns (IOrchestratorV3.SignalIntentParams memory params) {
        params = _defaultParams();
        params.to = recipient;
    }

    function _attestation(bytes32 intentHash, bytes32 paymentId, bytes32 disputeId)
        internal
        pure
        returns (IDisputeVerifier.DisputeAttestation memory attestation)
    {
        IDisputeVerifier.DisputeDetails memory details = IDisputeVerifier.DisputeDetails({
            paymentMethod: METHOD,
            originalPaymentId: paymentId,
            disputeId: disputeId,
            paymentAmount: 100,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        attestation = IDisputeVerifier.DisputeAttestation({
            intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
        });
    }
}
