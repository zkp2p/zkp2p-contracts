// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "../../contracts/EscrowV2.sol";
import {IOrchestratorV2} from "../../contracts/interfaces/IOrchestratorV2.sol";
import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {RateManagerMock} from "../../contracts/mocks/RateManagerMock.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract OrchestratorV2Test is ProtocolV2TestBase {
    bytes32 internal constant RATE_MANAGER_ID = bytes32("manager-v1");

    RateManagerMock internal rateManagerMock;
    address internal managerFeeRecipient;

    function setUp() public {
        _setUpV2Core();
        managerFeeRecipient = makeAddr("managerFeeRecipient");
        rateManagerMock = new RateManagerMock();

        verifier.setShouldVerifyPayment(true);
        _createDepositWithRate(500e6, 1e18);

        rateManagerMock.setManager(RATE_MANAGER_ID, true);
        rateManagerMock.setFee(RATE_MANAGER_ID, managerFeeRecipient, 0.01e18);
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, 1.2e18);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function test_signalIntentUsesDelegatedEffectiveRateAndSnapshotsManagerFee() public {
        vm.recordLogs();
        bytes32 intentHash = _signalIntent(1.2e18);

        (bytes32 snapshottedIntentHash, address feeRecipient, uint256 fee) = _extractManagerFeeSnapshot(vm.getRecordedLogs());

        assertEq(snapshottedIntentHash, intentHash);
        assertEq(feeRecipient, managerFeeRecipient);
        assertEq(fee, 0.01e18);
    }

    function test_signalIntentRevertsWhenConversionRateIsBelowDelegatedManagerRate() public {
        IOrchestratorV2.SignalIntentParams memory params = _defaultSignalIntentParams(takerA);
        params.conversionRate = 1.1e18;

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.RateBelowMinimum.selector, 1.1e18, 1.2e18));
        vm.prank(takerA);
        orchestrator.signalIntent(params);
    }

    function test_signalIntentRevertsWhenDelegatedManagerFeeExceedsMaximum() public {
        rateManagerMock.setFee(RATE_MANAGER_ID, managerFeeRecipient, 0.06e18);
        IOrchestratorV2.SignalIntentParams memory params = _defaultSignalIntentParams(takerA);
        params.conversionRate = 1.2e18;

        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.FeeExceedsMaximum.selector, 0.06e18, 0.05e18));
        vm.prank(takerA);
        orchestrator.signalIntent(params);
    }

    function test_fulfillIntentDeductsManagerFeeAndTransfersNetAmount() public {
        bytes32 intentHash = _signalIntent(1.2e18);
        uint256 releaseAmount = 50e6;
        uint256 fiatAmount = (releaseAmount * 1.2e18) / 1e18;
        uint256 timestamp = block.timestamp;
        bytes memory paymentProof = abi.encode(fiatAmount, timestamp, keccak256("payee"), USD, intentHash);

        uint256 managerFeeBefore = usdc.balanceOf(managerFeeRecipient);
        uint256 takerBefore = usdc.balanceOf(takerA);

        IOrchestratorV2.FulfillIntentParams memory params = IOrchestratorV2.FulfillIntentParams({
            paymentProof: paymentProof,
            intentHash: intentHash,
            verificationData: "",
            postIntentHookData: ""
        });

        vm.prank(owner);
        orchestrator.fulfillIntent(params);

        uint256 expectedManagerFee = (releaseAmount * 0.01e18) / 1e18;
        uint256 expectedTakerNet = releaseAmount - expectedManagerFee;

        assertEq(usdc.balanceOf(managerFeeRecipient) - managerFeeBefore, expectedManagerFee);
        assertEq(usdc.balanceOf(takerA) - takerBefore, expectedTakerNet);
    }

    function _createDepositWithRate(uint256 amount, uint256 minConversionRate) internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(address(0), keccak256("payee"), ""),
            currencies: _singleDepositCurrencies(USD, minConversionRate),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _signalIntent(uint256 conversionRate) internal returns (bytes32 intentHash) {
        IOrchestratorV2.SignalIntentParams memory params = _defaultSignalIntentParams(takerA);
        params.conversionRate = conversionRate;

        vm.prank(takerA);
        orchestrator.signalIntent(params);

        bytes32[] memory accountIntents = orchestrator.getAccountIntents(takerA);
        intentHash = accountIntents[accountIntents.length - 1];
    }

    function _extractManagerFeeSnapshot(Vm.Log[] memory entries)
        internal
        view
        returns (bytes32 intentHash, address feeRecipient, uint256 fee)
    {
        bytes32 snapshotEventSig = keccak256("IntentManagerFeeSnapshotted(bytes32,address,uint256)");

        for (uint256 index = 0; index < entries.length; index++) {
            if (
                entries[index].emitter == address(orchestrator)
                    && entries[index].topics.length == 3
                    && entries[index].topics[0] == snapshotEventSig
            ) {
                intentHash = entries[index].topics[1];
                feeRecipient = address(uint160(uint256(entries[index].topics[2])));
                fee = abi.decode(entries[index].data, (uint256));
                return (intentHash, feeRecipient, fee);
            }
        }

        revert("IntentManagerFeeSnapshotted not found");
    }
}
