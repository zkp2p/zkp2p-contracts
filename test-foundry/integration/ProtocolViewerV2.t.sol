// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolViewerV2} from "../../contracts/ProtocolViewerV2.sol";
import {IEscrowV2} from "../../contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "../../contracts/interfaces/IOrchestratorV2.sol";
import {IProtocolViewerV2} from "../../contracts/interfaces/IProtocolViewerV2.sol";
import {RateManagerMock} from "../../contracts/mocks/RateManagerMock.sol";
import {ProtocolV2TestBase} from "../helpers/ProtocolV2TestBase.sol";

contract ProtocolViewerV2Test is ProtocolV2TestBase {
    bytes32 internal constant RATE_MANAGER_ID = bytes32("manager-1");

    ProtocolViewerV2 internal protocolViewerV2;

    function setUp() public {
        _setUpV2Core();
        protocolViewerV2 = new ProtocolViewerV2();
        _createDepositWithRate(500e6, 1e18);
    }

    function test_getDepositReturnsDepositDataForEscrow() public view {
        IProtocolViewerV2.DepositView memory depositView = protocolViewerV2.getDeposit(address(escrow), 0);

        assertEq(depositView.depositId, 0);
        assertEq(depositView.deposit.depositor, depositor);
        assertEq(address(depositView.deposit.token), address(usdc));
        assertEq(depositView.deposit.remainingDeposits, 500e6);
        assertEq(depositView.availableLiquidity, 500e6);
        assertEq(depositView.paymentMethods.length, 1);
        assertEq(depositView.paymentMethods[0].paymentMethod, VENMO);
        assertEq(depositView.paymentMethods[0].currencies.length, 1);
        assertEq(depositView.paymentMethods[0].currencies[0].code, USD);
    }

    function test_getDepositReturnsNativeMinRateWhenNoRateManagerIsSet() public view {
        IProtocolViewerV2.DepositView memory depositView = protocolViewerV2.getDeposit(address(escrow), 0);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1e18);
    }

    function test_getDepositReturnsDelegatedRateWhenRateManagerIsSet() public {
        RateManagerMock rateManagerMock = _setDelegatedRate(1.5e18);

        IProtocolViewerV2.DepositView memory depositView = protocolViewerV2.getDeposit(address(escrow), 0);

        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1.5e18);
        assertTrue(rateManagerMock.isRateManager(RATE_MANAGER_ID));
    }

    function test_getDepositFallsBackToNativeRateWhenRateManagerReverts() public {
        RateManagerMock rateManagerMock = _setDelegatedRate(1.5e18);
        rateManagerMock.setShouldRevertOnGetRate(true);

        IProtocolViewerV2.DepositView memory depositView = protocolViewerV2.getDeposit(address(escrow), 0);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1e18);
    }

    function test_getDepositReturnsZeroWhenRateManagerReturnsZero() public {
        _setDelegatedRate(0);

        IProtocolViewerV2.DepositView memory depositView = protocolViewerV2.getDeposit(address(escrow), 0);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 0);
    }

    function test_getDepositRevertsWhenEscrowIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidEscrow.selector, address(0)));
        protocolViewerV2.getDeposit(address(0), 0);
    }

    function test_getDepositFromIdsReturnsAllRequestedDeposits() public {
        _createDepositWithRate(250e6, 1.01e18);
        uint256[] memory depositIds = new uint256[](2);
        depositIds[0] = 0;
        depositIds[1] = 1;

        IProtocolViewerV2.DepositView[] memory deposits = protocolViewerV2.getDepositFromIds(address(escrow), depositIds);

        assertEq(deposits.length, 2);
        assertEq(deposits[0].depositId, 0);
        assertEq(deposits[1].depositId, 1);
        assertEq(deposits[1].deposit.remainingDeposits, 250e6);
    }

    function test_getDepositFromIdsRevertsWhenEscrowIsZero() public {
        uint256[] memory depositIds = new uint256[](0);

        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidEscrow.selector, address(0)));
        protocolViewerV2.getDepositFromIds(address(0), depositIds);
    }

    function test_getIntentReturnsSingleIntentAndResolvesDepositFromIntentEscrow() public {
        bytes32 intentHash = _signalIntent(takerA, 50e6);

        IProtocolViewerV2.IntentView memory intentView = protocolViewerV2.getIntent(address(orchestrator), intentHash);

        assertEq(intentView.intentHash, intentHash);
        assertEq(intentView.intent.owner, takerA);
        assertEq(intentView.intent.escrow, address(escrow));
        assertEq(intentView.deposit.depositId, 0);
        assertEq(intentView.deposit.deposit.depositor, depositor);
    }

    function test_getAccountIntentsReturnsAllIntentsForAccount() public {
        vm.prank(owner);
        orchestrator.setAllowMultipleIntents(true);

        _signalIntent(takerA, 50e6);
        _signalIntent(takerA, 30e6);

        IProtocolViewerV2.IntentView[] memory intents = protocolViewerV2.getAccountIntents(address(orchestrator), takerA);

        assertEq(intents.length, 2);
        assertEq(intents[0].intent.owner, takerA);
        assertEq(intents[1].intent.owner, takerA);
    }

    function test_getIntentsReturnsViewsForProvidedHashes() public {
        vm.prank(owner);
        orchestrator.setAllowMultipleIntents(true);

        _signalIntent(takerA, 50e6);
        _signalIntent(takerA, 30e6);

        bytes32[] memory intentHashes = orchestrator.getAccountIntents(takerA);
        IProtocolViewerV2.IntentView[] memory intents = protocolViewerV2.getIntents(address(orchestrator), intentHashes);

        assertEq(intents.length, 2);
        assertEq(intents[0].intentHash, intentHashes[0]);
        assertEq(intents[1].intentHash, intentHashes[1]);
        assertEq(intents[0].intent.owner, takerA);
        assertEq(intents[1].intent.owner, takerA);
    }

    function test_getIntentRevertsWhenOrchestratorIsZero() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidOrchestrator.selector, address(0)));
        protocolViewerV2.getIntent(address(0), bytes32("intent"));
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

    function _setDelegatedRate(uint256 delegatedRate) internal returns (RateManagerMock rateManagerMock) {
        rateManagerMock = new RateManagerMock();
        rateManagerMock.setManager(RATE_MANAGER_ID, true);
        rateManagerMock.setRate(RATE_MANAGER_ID, address(escrow), 0, VENMO, USD, delegatedRate);

        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManagerMock), RATE_MANAGER_ID);
    }

    function _signalIntent(address taker, uint256 amount) internal returns (bytes32 intentHash) {
        IOrchestratorV2.SignalIntentParams memory params = _defaultSignalIntentParams(taker);
        params.amount = amount;

        vm.prank(taker);
        orchestrator.signalIntent(params);

        bytes32[] memory accountIntents = orchestrator.getAccountIntents(taker);
        intentHash = accountIntents[accountIntents.length - 1];
    }
}
