// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {StakeVault} from "contracts/StakeVault.sol";
import {ChargebackPolicy} from "contracts/hooks/ChargebackPolicy.sol";
import {IntentLifecycleHookV1} from "contracts/hooks/IntentLifecycleHookV1.sol";
import {WhitelistPolicy} from "contracts/hooks/WhitelistPolicy.sol";
import {IChargebackPolicy} from "contracts/interfaces/IChargebackPolicy.sol";
import {IChargebackVerifier} from "contracts/interfaces/IChargebackVerifier.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";
import {AttestationVerifierMock} from "contracts/mocks/AttestationVerifierMock.sol";
import {AddressGroupRegistry} from "contracts/registries/AddressGroupRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {ChargebackVerifier} from "contracts/unifiedVerifier/ChargebackVerifier.sol";

import {OrchestratorV3Fixture} from "../helpers/OrchestratorV3Fixture.sol";

contract ChargebackLifecycleHookOrchestratorV3Test is OrchestratorV3Fixture {
    uint64 internal constant RISK_WINDOW = 30 days;
    uint256 internal constant STAKE_AMOUNT = 500e6;
    bytes32 internal constant WINDOWLESS_METHOD = keccak256("windowless");

    AddressGroupRegistry internal groupRegistry;
    WhitelistPolicy internal whitelistPolicy;
    StakeVault internal vault;
    NullifierRegistryV2 internal nullifierRegistry;
    NullifierRegistry internal chargebackNullifierRegistry;
    ChargebackPolicy internal chargebackPolicy;
    IntentLifecycleHookV1 internal lifecycleHook;

    function setUp() public override {
        super.setUp();
        groupRegistry = new AddressGroupRegistry();
        whitelistPolicy = new WhitelistPolicy(groupRegistry, escrowRegistry, orchestratorRegistry);
        vault = new StakeVault(address(this), token, address(0), 1 days);
        nullifierRegistry = new NullifierRegistryV2(new NullifierRegistry());
        chargebackNullifierRegistry = new NullifierRegistry();
        chargebackPolicy = new ChargebackPolicy(
            address(this),
            vault,
            new ChargebackVerifier(address(this), nullifierRegistry, new AttestationVerifierMock()),
            chargebackNullifierRegistry
        );
        vault.initializeController(address(chargebackPolicy));
        chargebackNullifierRegistry.addWritePermission(address(chargebackPolicy));
        lifecycleHook = new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, chargebackPolicy);
        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        chargebackPolicy.setRiskWindow(METHOD, RISK_WINDOW);
        orchestrator.setLifecycleHook(lifecycleHook);
        _stake(taker, STAKE_AMOUNT);
    }

    function test_WhitelistOnWhitelistedWithChargebackOnSkipsStake() public {
        _setWhitelist(true, true);
        _setChargeback(true);

        bytes32 intentHash = _signalDefault();

        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(taker), 0);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);
    }

    function test_WhitelistOnNonMemberWithChargebackOnRequiresStakeBeforeEscrowLock() public {
        _setWhitelist(true, false);
        _setChargeback(true);
        bytes32 intentHash = _signalDefault();
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.PENDING)
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

    function test_WhitelistOnNonMemberNonChargebackableMethodGetsDirectAccess() public {
        _addPaymentMethod(WINDOWLESS_METHOD);
        _setWhitelist(true, false);
        _setChargeback(true);
        IOrchestratorV3.SignalIntentParams memory params = _paramsFor(other);
        params.paymentMethod = WINDOWLESS_METHOD;

        bytes32 intentHash = _signal(other, params);

        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);
        assertEq(escrow.getDepositIntent(depositId, intentHash).intentHash, intentHash);

        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
    }

    function test_WhitelistOnNonMemberWithChargebackOffRejects() public {
        _setWhitelist(true, false);
        vm.expectRevert(
            abi.encodeWithSelector(
                IntentLifecycleHookV1.TakerNotWhitelisted.selector, address(escrow), depositId, taker
            )
        );
        _signalCall(taker, _defaultParams());
    }

    function test_WhitelistOffChargebackOnRequiresStakeForEveryTaker() public {
        _setChargeback(true);
        assertNotEq(_signalDefault(), bytes32(0));
        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(other, _paramsFor(other));
    }

    function test_WhitelistOffChargebackOnNonChargebackableMethodIsOpen() public {
        _addPaymentMethod(WINDOWLESS_METHOD);
        _setChargeback(true);
        IOrchestratorV3.SignalIntentParams memory params = _paramsFor(other);
        params.paymentMethod = WINDOWLESS_METHOD;

        bytes32 intentHash = _signal(other, params);

        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);

        vm.expectRevert(
            abi.encodeWithSelector(IStakeVault.InsufficientFreeStake.selector, other, uint256(0), INTENT_AMOUNT)
        );
        _signalCall(other, _paramsFor(other));
    }

    function test_WhitelistOffChargebackOffIsOpenAndCreatesNoChargebackIntent() public {
        bytes32 intentHash = _signal(other, _paramsFor(other));
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
        assertEq(vault.lockedStake(other), 0);
    }

    function test_CancelIntentAndExpiryPruneUnlockStake() public {
        _setChargeback(true);
        bytes32 cancelledIntent = _signalDefault();
        vm.prank(taker);
        orchestrator.cancelIntent(cancelledIntent);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(cancelledIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CANCELLED)
        );

        bytes32 expiredIntent = _signalDefault();
        IEscrowV2.Intent memory intent = escrow.getDepositIntent(depositId, expiredIntent);
        vm.warp(intent.expiryTime + 1);
        escrow.pruneExpiredIntents(depositId);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(expiredIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CANCELLED)
        );
    }

    function test_SubMinimumFulfillResizesCoverageThenMaturityReleasesStake() public {
        _setChargeback(true);
        bytes32 intentHash = _signalDefault();
        uint256 releaseAmount = 5e6;
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, releaseAmount, CONVERSION_RATE);

        IChargebackPolicy.ChargebackIntent memory chargebackIntent = chargebackPolicy.getChargebackIntent(intentHash);
        assertEq(chargebackIntent.releaseAmount, releaseAmount);
        assertEq(chargebackIntent.releaseEligibleAt, releaseEligibleAt);
        assertFalse(chargebackIntent.isManualRelease);
        (, uint256 lockedAmount, uint64 maturesAt) = vault.locks(intentHash);
        assertEq(lockedAmount, releaseAmount);
        assertEq(maturesAt, releaseEligibleAt);

        vm.warp(releaseEligibleAt);
        chargebackPolicy.releaseMaturedChargebackIntent(intentHash);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(vault.freeStake(taker), STAKE_AMOUNT);
    }

    function test_ManualReleaseSettlesCoverageAndMarksManual() public {
        _setChargeback(true);
        bytes32 intentHash = _signalDefault();
        uint256 releaseEligibleAt = vm.getBlockTimestamp() + RISK_WINDOW;
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        IChargebackPolicy.ChargebackIntent memory chargebackIntent = chargebackPolicy.getChargebackIntent(intentHash);
        assertTrue(chargebackIntent.isManualRelease);
        assertEq(chargebackIntent.releaseAmount, INTENT_AMOUNT);
        assertEq(chargebackIntent.releaseEligibleAt, releaseEligibleAt);
        assertEq(vault.lockedStake(taker), INTENT_AMOUNT);
    }

    function test_ChargebackAfterFulfillPaysDepositorClaim() public {
        _setChargeback(true);
        bytes32 intentHash = _signalDefault();
        verifier.setShouldVerifyPayment(true);
        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        bytes32 paymentId = keccak256("payment");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.addWritePermission(address(this));
        nullifierRegistry.addNullifier(paymentNullifier, intentHash);
        chargebackPolicy.submitChargeback(_attestation(intentHash, paymentId, keccak256("dispute")));

        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CHARGED_BACK)
        );
    }

    function test_PolicyAdmissionRevertBubblesRawAndRollsBackSignal() public {
        _setChargeback(true);
        chargebackPolicy.setAdmissionsPaused(true);
        uint256 counterBefore = orchestrator.intentCounter();
        bytes32 rejectedIntent = _intentHash(counterBefore);
        uint256 remainingBefore = escrow.getDeposit(depositId).remainingDeposits;

        vm.expectRevert(IChargebackPolicy.AdmissionsPaused.selector);
        _signalCall(taker, _defaultParams());

        assertEq(orchestrator.intentCounter(), counterBefore);
        assertEq(orchestrator.getIntent(rejectedIntent).owner, address(0));
        assertEq(escrow.getDepositIntent(depositId, rejectedIntent).intentHash, bytes32(0));
        assertEq(escrow.getDeposit(depositId).remainingDeposits, remainingBefore);
    }

    function test_CancellationWithoutChargebackIntentLeavesVaultUntouched() public {
        bytes32 intentHash = _signalDefault();
        uint256 totalBefore = vault.totalStaked();
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);
        assertEq(vault.totalStaked(), totalBefore);
        assertEq(vault.lockedStake(taker), 0);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(intentHash).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.NONE)
        );
    }

    function test_LifecycleHookRotationPreservesOldIntentsAndRoutesNewIntentsToNewHook() public {
        _setChargeback(true);
        bytes32 oldCancelledIntent = _signalDefault();
        bytes32 oldSettledIntent = _signalDefault();
        IntentLifecycleHookV1 newLifecycleHook =
            new IntentLifecycleHookV1(orchestratorRegistry, whitelistPolicy, chargebackPolicy);

        chargebackPolicy.setLifecycleHookAuthorization(address(newLifecycleHook), true);
        orchestrator.setLifecycleHook(newLifecycleHook);

        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), false);
        vm.expectRevert(
            abi.encodeWithSelector(IChargebackPolicy.UnauthorizedLifecycleHook.selector, address(lifecycleHook))
        );
        vm.prank(taker);
        orchestrator.cancelIntent(oldCancelledIntent);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(oldCancelledIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.PENDING)
        );

        chargebackPolicy.setLifecycleHookAuthorization(address(lifecycleHook), true);
        vm.prank(taker);
        orchestrator.cancelIntent(oldCancelledIntent);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(oldCancelledIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CANCELLED)
        );

        uint256 releaseAmount = 40e6;
        verifier.setShouldVerifyPayment(true);
        _fulfill(oldSettledIntent, releaseAmount, CONVERSION_RATE);
        IChargebackPolicy.ChargebackIntent memory oldSettledIntentState =
            chargebackPolicy.getChargebackIntent(oldSettledIntent);
        assertEq(uint256(oldSettledIntentState.status), uint256(IChargebackPolicy.ChargebackIntentStatus.SETTLED));
        assertEq(oldSettledIntentState.releaseAmount, releaseAmount);

        bytes32 newIntent = _signalDefault();
        assertEq(address(orchestrator.getIntentLifecycleHook(newIntent)), address(newLifecycleHook));
        vm.prank(taker);
        orchestrator.cancelIntent(newIntent);
        assertEq(
            uint256(chargebackPolicy.getChargebackIntent(newIntent).status),
            uint256(IChargebackPolicy.ChargebackIntentStatus.CANCELLED)
        );
        assertEq(vault.lockedStake(taker), releaseAmount);
    }

    function _setWhitelist(bool enabled, bool includeTaker) internal {
        address[] memory takers = new address[](includeTaker ? 1 : 0);
        if (includeTaker) takers[0] = taker;
        vm.prank(depositor);
        whitelistPolicy.configureDeposit(address(escrow), depositId, enabled, new bytes32[](0), takers);
    }

    function _setChargeback(bool enabled) internal {
        vm.prank(depositor);
        chargebackPolicy.setChargebackEnabled(address(escrow), depositId, enabled);
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
        returns (IChargebackVerifier.ChargebackAttestation memory attestation)
    {
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = hex"01";
        attestation = IChargebackVerifier.ChargebackAttestation({
            schemaId: keccak256("zkp2p.attestation.dispute.v1"),
            transformerId: keccak256("transformer"),
            input: abi.encode(intentHash),
            output: abi.encode(paymentId, disputeId),
            signatures: signatures
        });
    }
}
