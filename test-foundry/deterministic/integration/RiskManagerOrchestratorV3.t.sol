// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {RiskManager} from "../../../contracts/RiskManager.sol";
import {StakeVault} from "../../../contracts/StakeVault.sol";
import {IEscrowV2} from "../../../contracts/interfaces/IEscrowV2.sol";
import {IIntentRiskHook} from "../../../contracts/interfaces/IIntentRiskHook.sol";
import {INullifierRegistryV2} from "../../../contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorV2} from "../../../contracts/interfaces/IOrchestratorV2.sol";
import {IOrchestratorV3} from "../../../contracts/interfaces/IOrchestratorV3.sol";
import {IPostIntentHookV2} from "../../../contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "../../../contracts/interfaces/IReferralFee.sol";
import {IRiskManager} from "../../../contracts/interfaces/IRiskManager.sol";
import {BoundedCall} from "../../../contracts/lib/BoundedCall.sol";
import {IntentRiskHookMock} from "../../../contracts/mocks/IntentRiskHookMock.sol";
import {RiskAttestationVerifierMock, RiskNullifierRegistryMock} from "../helpers/RiskManagerFixture.sol";
import {OrchestratorV2LegacyFixture} from "../helpers/OrchestratorV2LegacyFixture.sol";

contract RiskManagerOrchestratorV3IntegrationTest is OrchestratorV2LegacyFixture {
    event RiskHookUpdated(address indexed previousHook, address indexed newHook);

    uint64 internal constant RISK_WINDOW = 30 days;
    uint32 internal constant EXTENSION_SLOPE = 10;
    uint256 internal constant SAFE_STAKE = 500e6;

    address internal safe;
    address internal deferredTaker;

    StakeVault internal vault;
    RiskManager internal manager;
    RiskAttestationVerifierMock internal attestationVerifier;
    RiskNullifierRegistryMock internal nullifierRegistry;
    uint256 internal riskDepositId;

    function setUp() public override {
        super.setUp();
        _replaceOrchestratorWithStandaloneV3();

        safe = makeAddr("safe");
        deferredTaker = makeAddr("deferredTaker");
        attestationVerifier = new RiskAttestationVerifierMock();
        nullifierRegistry = new RiskNullifierRegistryMock();
        vault = new StakeVault(address(this), IERC20(address(token)), address(0), 1 days);
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            vault,
            attestationVerifier,
            INullifierRegistryV2(address(nullifierRegistry))
        );
        vault.initializeController(address(manager));

        manager.setPlatformRiskConfig(
            METHOD,
            IRiskManager.PlatformRiskConfig({
                enabled: true,
                chargeback: IRiskManager.ChargebackConfig({
                    chargebackable: true, deferredPayoutEnabled: true, riskWindow: RISK_WINDOW
                }),
                extensionPenaltyBpsPerHour: EXTENSION_SLOPE
            })
        );
        orchestrator.setProtocolFee(1e16);

        vm.startPrank(depositor);
        riskDepositId = _createRiskDeposit(address(manager));
        vm.stopPrank();
        IOrchestratorV3(address(orchestrator)).setRiskHook(manager);

        token.transfer(safe, SAFE_STAKE);
        vm.startPrank(safe);
        token.approve(address(vault), SAFE_STAKE);
        vault.depositStake(SAFE_STAKE);
        vault.setTakerAuthorization(taker, true);
        vm.stopPrank();
        vm.prank(taker);
        vault.selectStakeOwner(safe);
    }

    function test_RealSignalExtensionAndCancellationResolveBothLocks() public {
        bytes32 intentHash = _signalRiskIntent(taker, taker);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);

        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.STAKE_BACKED));
        assertEq(position.coverageAmount, INTENT_AMOUNT);
        assertEq(vault.lockedStake(safe), INTENT_AMOUNT);

        vm.prank(taker);
        manager.extendIntent(intentHash, 2 hours);
        bytes32 extensionId = manager.extensionLockId(intentHash);
        (address extensionOwner, uint256 extensionAmount, uint64 extensionMaturity) = vault.locks(extensionId);
        assertEq(extensionOwner, safe);
        assertEq(extensionAmount, 100_000);
        assertEq(extensionMaturity, type(uint64).max);

        IEscrowV2.Intent memory escrowIntent = escrow.getDepositIntent(riskDepositId, intentHash);
        assertEq(escrowIntent.expiryTime, escrowIntent.timestamp + 3 hours);

        vm.warp(block.timestamp + 2 hours);
        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);

        position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.claimable(depositor), 50_000);
        assertEq(vault.stakeBalance(safe), SAFE_STAKE - 50_000);
        assertEq(escrow.getDepositIntent(riskDepositId, intentHash).intentHash, bytes32(0));
    }

    function test_RealStakeBackedManualReleasePaysImmediatelyThenMaturesCoverage() public {
        bytes32 intentHash = _signalRiskIntent(taker, taker);
        uint256 payoutBefore = token.balanceOf(taker);
        uint256 protocolBefore = token.balanceOf(protocolFeeRecipient);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(position.coverageAmount, INTENT_AMOUNT);
        assertEq(token.balanceOf(taker) - payoutBefore, 49.5e6);
        assertEq(token.balanceOf(protocolFeeRecipient) - protocolBefore, 0.5e6);
        assertEq(vault.lockedStake(safe), INTENT_AMOUNT);

        vm.warp(position.coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.RELEASED));
        assertEq(vault.lockedStake(safe), 0);
        assertEq(vault.stakeBalance(safe), SAFE_STAKE);
    }

    function test_RealDeferredManualReleaseFundsVaultThenSplitsFeesAtMaturity() public {
        bytes32 intentHash = _signalRiskIntent(deferredTaker, deferredTaker);
        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.mode), uint256(IRiskManager.RiskMode.DEFERRED_PAYOUT));
        assertEq(vault.lockedStake(deferredTaker), 0);

        uint256 payoutBefore = token.balanceOf(deferredTaker);
        uint256 protocolBefore = token.balanceOf(protocolFeeRecipient);
        uint256 vaultBefore = token.balanceOf(address(vault));
        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(intentHash);

        position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(token.balanceOf(deferredTaker), payoutBefore);
        assertEq(token.balanceOf(protocolFeeRecipient), protocolBefore);
        assertEq(token.balanceOf(address(vault)) - vaultBefore, INTENT_AMOUNT);
        assertEq(vault.stakeBalance(deferredTaker), INTENT_AMOUNT);
        assertEq(vault.lockedStake(deferredTaker), INTENT_AMOUNT);

        IIntentRiskHook.FeeAllocation[] memory allocations = manager.getDeferredFeeAllocations(intentHash);
        assertEq(allocations.length, 1);
        assertEq(allocations[0].recipient, protocolFeeRecipient);
        assertEq(allocations[0].amount, 0.5e6);

        vm.warp(position.coverageDeadline);
        manager.releaseMaturedPosition(intentHash);

        assertEq(vault.claimable(protocolFeeRecipient), 0.5e6);
        assertEq(vault.stakeBalance(deferredTaker), 49.5e6);
        assertEq(vault.lockedStake(deferredTaker), 0);

        vm.prank(deferredTaker);
        vault.withdrawStake(49.5e6);
        vm.prank(protocolFeeRecipient);
        vault.claim();
        assertEq(token.balanceOf(deferredTaker) - payoutBefore, 49.5e6);
        assertEq(token.balanceOf(protocolFeeRecipient) - protocolBefore, 0.5e6);
    }

    function test_RealDeferredPostIntentHookAdmissionRevertsTheCompleteSignal() public {
        IOrchestratorV2.SignalIntentParams memory params = _params(
            riskDepositId,
            deferredTaker,
            INTENT_AMOUNT,
            CONVERSION_RATE,
            new IReferralFee.ReferralFee[](0),
            postIntentHook,
            abi.encode(deferredTaker)
        );
        bytes32 intentHash = _intentHash(orchestrator.intentCounter());

        vm.expectPartialRevert(BoundedCall.RiskHookAdmissionFailed.selector);
        _signalCall(deferredTaker, params);

        assertEq(IOrchestratorV3(address(orchestrator)).getRiskIntent(intentHash).owner, address(0));
        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.NONE));
        assertEq(escrow.getDepositIntent(riskDepositId, intentHash).intentHash, bytes32(0));
        assertEq(vault.stakeBalance(deferredTaker), 0);
    }

    function test_RealProofFulfillmentPreservesPaymentBindingForChargeback() public {
        bytes32 intentHash = _signalRiskIntent(taker, taker);
        verifier.setShouldVerifyPayment(true);
        uint256 payoutBefore = token.balanceOf(taker);
        uint256 protocolBefore = token.balanceOf(protocolFeeRecipient);

        _fulfill(intentHash, INTENT_AMOUNT, CONVERSION_RATE);

        IRiskManager.RiskPosition memory position = manager.getRiskPosition(intentHash);
        assertEq(uint256(position.status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertFalse(position.isManualRelease);
        assertEq(token.balanceOf(taker) - payoutBefore, 49.5e6);
        assertEq(token.balanceOf(protocolFeeRecipient) - protocolBefore, 0.5e6);

        bytes32 paymentId = keccak256("real-payment-id");
        bytes32 paymentNullifier = keccak256(abi.encodePacked(METHOD, paymentId));
        nullifierRegistry.setPaymentBinding(paymentNullifier, intentHash);
        IRiskManager.ChargebackDetails memory details = IRiskManager.ChargebackDetails({
            paymentMethod: METHOD,
            originalPaymentId: paymentId,
            disputeId: keccak256("real-dispute-id"),
            paymentAmount: 50_00,
            paymentCurrency: USD
        });
        bytes memory data = abi.encode(details);
        manager.submitChargeback(
            IRiskManager.ChargebackAttestation({
                intentHash: intentHash, dataHash: keccak256(data), signatures: new bytes[](0), data: data
            })
        );

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.SLASHED));
        assertEq(vault.claimable(depositor), INTENT_AMOUNT);
        assertEq(vault.lockedStake(safe), 0);
    }

    function test_RiskHookGovernanceAndViewsExposeConfiguredSnapshots() public {
        IOrchestratorV3 riskOrchestrator = IOrchestratorV3(address(orchestrator));
        assertEq(address(riskOrchestrator.riskHook()), address(manager));

        bytes32 intentHash = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(intentHash)), address(manager));

        riskOrchestrator.setRiskCallbackGasLimit(1_000_000);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.RiskCallbackGasLimitTooLow.selector, 749_999, 750_000));
        riskOrchestrator.setRiskCallbackGasLimit(749_999);

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV3.InvalidRiskHook.selector, other));
        riskOrchestrator.setRiskHook(IIntentRiskHook(other));

        vm.prank(other);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        riskOrchestrator.setRiskHook(manager);

        bytes32 missingCancellation = keccak256("missing-cancellation");
        vm.expectRevert(
            abi.encodeWithSelector(IOrchestratorV3.IntentCancellationNotRecorded.selector, missingCancellation)
        );
        riskOrchestrator.acknowledgeIntentCancellation(missingCancellation);
    }

    function test_SetRiskHookFromZeroEnablesCallbacksOnlyForNewIntents() public {
        IOrchestratorV3 riskOrchestrator = IOrchestratorV3(address(orchestrator));

        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit RiskHookUpdated(address(manager), address(0));
        riskOrchestrator.setRiskHook(IIntentRiskHook(address(0)));

        bytes32 first = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(first)), address(0));
        assertEq(uint256(manager.getRiskPosition(first).status), uint256(IRiskManager.PositionStatus.NONE));
        assertEq(vault.lockedStake(safe), 0);

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(first);

        vm.expectEmit(true, true, false, true, address(orchestrator));
        emit RiskHookUpdated(address(0), address(manager));
        riskOrchestrator.setRiskHook(manager);

        bytes32 second = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(second)), address(manager));
        assertEq(uint256(manager.getRiskPosition(second).status), uint256(IRiskManager.PositionStatus.PENDING));
    }

    function test_SetRiskHookToZeroKeepsInFlightIntentOnSnapshot() public {
        bytes32 inFlight = _signalRiskIntent(taker, taker);
        assertEq(vault.lockedStake(safe), INTENT_AMOUNT);

        IOrchestratorV3 riskOrchestrator = IOrchestratorV3(address(orchestrator));
        riskOrchestrator.setRiskHook(IIntentRiskHook(address(0)));

        bytes32 fresh = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(fresh)), address(0));
        assertEq(uint256(manager.getRiskPosition(fresh).status), uint256(IRiskManager.PositionStatus.NONE));

        vm.prank(taker);
        orchestrator.cancelIntent(inFlight);

        assertEq(uint256(manager.getRiskPosition(inFlight).status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(vault.lockedStake(safe), 0);
    }

    function test_SetRiskHookChangeSettlesInFlightIntentThroughSnapshot() public {
        IOrchestratorV3 riskOrchestrator = IOrchestratorV3(address(orchestrator));
        bytes32 inFlight = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(inFlight)), address(manager));

        IntentRiskHookMock replacementHook = new IntentRiskHookMock();
        riskOrchestrator.setRiskHook(IIntentRiskHook(address(replacementHook)));

        vm.prank(depositor);
        orchestrator.releaseFundsToPayer(inFlight);

        assertEq(uint256(manager.getRiskPosition(inFlight).status), uint256(IRiskManager.PositionStatus.SETTLED));
        assertEq(replacementHook.settlementCalls(), 0);
        assertEq(replacementHook.createdCalls(), 0);

        bytes32 fresh = _signalRiskIntent(taker, taker);
        assertEq(address(riskOrchestrator.getIntentRiskHook(fresh)), address(replacementHook));
        assertEq(replacementHook.createdCalls(), 1);
        assertEq(uint256(manager.getRiskPosition(fresh).status), uint256(IRiskManager.PositionStatus.NONE));
    }

    function test_RealFailedCancellationCanReconcileAfterControllerRecovery() public {
        bytes32 intentHash = _signalRiskIntent(taker, taker);
        address temporaryController = makeAddr("temporaryController");

        vault.proposeController(temporaryController);
        uint64 cancelledAt = uint64(block.timestamp + vault.controllerChangeDelay());
        vm.warp(cancelledAt);
        vm.prank(temporaryController);
        vault.acceptController();

        vm.prank(taker);
        orchestrator.cancelIntent(intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.PENDING));
        assertEq(IOrchestratorV3(address(orchestrator)).getIntentCancellation(intentHash), cancelledAt);
        assertEq(vault.lockedStake(safe), INTENT_AMOUNT);

        vm.prank(taker);
        vm.expectRevert(abi.encodeWithSelector(IRiskManager.IntentStateMismatch.selector, intentHash));
        manager.extendIntent(intentHash, 1 hours);

        vm.prank(other);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV3.UnauthorizedCancellationAcknowledger.selector, other, address(manager)
            )
        );
        IOrchestratorV3(address(orchestrator)).acknowledgeIntentCancellation(intentHash);

        vault.proposeController(address(manager));
        vm.warp(uint256(cancelledAt) + vault.controllerChangeDelay());
        manager.acceptVaultController();
        manager.reconcileCancellation(intentHash);

        assertEq(uint256(manager.getRiskPosition(intentHash).status), uint256(IRiskManager.PositionStatus.CANCELLED));
        assertEq(IOrchestratorV3(address(orchestrator)).getIntentCancellation(intentHash), 0);
        assertEq(vault.lockedStake(safe), 0);
    }

    function _signalRiskIntent(address _caller, address _recipient) internal returns (bytes32 intentHash) {
        IOrchestratorV2.SignalIntentParams memory params = _params(
            riskDepositId,
            _recipient,
            INTENT_AMOUNT,
            CONVERSION_RATE,
            new IReferralFee.ReferralFee[](0),
            IPostIntentHookV2(address(0)),
            ""
        );
        intentHash = _signal(_caller, params);
    }

    function _createRiskDeposit(address _guardian) internal returns (uint256 id) {
        id = escrow.depositCounter();
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] =
            IEscrowV2.Currency({code: USD, minConversionRate: CONVERSION_RATE, oracleRateConfig: _emptyOracle()});
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: 500e6,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: delegate,
                intentGuardian: _guardian,
                retainOnEmpty: false
            })
        );
    }
}
