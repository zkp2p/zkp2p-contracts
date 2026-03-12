// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {ProtocolViewer} from "../../contracts/ProtocolViewer.sol";
import {IEscrow} from "../../contracts/interfaces/IEscrow.sol";
import {IProtocolViewer} from "../../contracts/interfaces/IProtocolViewer.sol";
import {ProtocolV1TestBase} from "../helpers/ProtocolV1TestBase.sol";

contract ProtocolViewerTest is ProtocolV1TestBase {
    ProtocolViewer internal protocolViewer;
    address internal gatingService;

    function setUp() public {
        _setUpV1Core();
        gatingService = makeAddr("gatingService");
        protocolViewer = new ProtocolViewer(address(escrow), address(orchestrator));
    }

    function test_constructorSetsEscrowAndOrchestrator() public view {
        assertEq(address(protocolViewer.escrowContract()), address(escrow));
        assertEq(address(protocolViewer.orchestrator()), address(orchestrator));
    }

    function test_constructorRevertsWhenEscrowIsZeroAddress() public {
        vm.expectRevert("ProtocolViewer: invalid escrow");
        new ProtocolViewer(address(0), address(orchestrator));
    }

    function test_constructorRevertsWhenOrchestratorIsZeroAddress() public {
        vm.expectRevert("ProtocolViewer: invalid orchestrator");
        new ProtocolViewer(address(escrow), address(0));
    }

    function test_getDepositReturnsDepositDetailsAndPaymentMethodMetadata() public {
        uint256 depositId = _createDepositWithConfig(100e6, 10e6, 200e6, gatingService, keccak256("payeeDetails"), "0x", 1.08e18);

        IProtocolViewer.DepositView memory depositView = protocolViewer.getDeposit(depositId);

        assertEq(depositView.depositId, depositId);
        assertEq(address(depositView.deposit.token), address(usdc));
        assertEq(depositView.deposit.depositor, depositor);
        assertEq(depositView.deposit.intentAmountRange.min, 10e6);
        assertEq(depositView.deposit.intentAmountRange.max, 200e6);
        assertEq(depositView.deposit.remainingDeposits, 100e6);
        assertEq(depositView.deposit.outstandingIntentAmount, 0);
        assertTrue(depositView.deposit.acceptingIntents);
        assertEq(depositView.availableLiquidity, 100e6);
        assertEq(depositView.paymentMethods.length, 1);
        assertEq(depositView.paymentMethods[0].paymentMethod, VENMO);
        assertEq(depositView.paymentMethods[0].verificationData.intentGatingService, gatingService);
        assertEq(depositView.paymentMethods[0].currencies.length, 1);
        assertEq(depositView.paymentMethods[0].currencies[0].code, USD);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1.08e18);
    }

    function test_getDepositIncludesPrunableAmountsInAvailableLiquidity() public {
        uint256 depositId = _createDeposit(100e6, 10e6, 200e6);
        _signal(takerA, depositId, 50e6);

        vm.warp(block.timestamp + INTENT_EXPIRATION_PERIOD + 1);

        IProtocolViewer.DepositView memory depositView = protocolViewer.getDeposit(depositId);
        assertEq(depositView.availableLiquidity, 100e6);
    }

    function test_getDepositReturnsEmptyViewWhenDepositDoesNotExist() public view {
        IProtocolViewer.DepositView memory depositView = protocolViewer.getDeposit(999);

        assertEq(depositView.deposit.depositor, address(0));
        assertEq(depositView.paymentMethods.length, 0);
        assertEq(depositView.intentHashes.length, 0);
    }

    function test_getDepositFromIdsReturnsDepositViews() public {
        uint256 firstDepositId = _createDeposit(100e6, 10e6, 200e6);
        uint256 secondDepositId = _createDeposit(200e6, 10e6, 200e6);
        uint256[] memory depositIds = new uint256[](2);
        depositIds[0] = firstDepositId;
        depositIds[1] = secondDepositId;

        IProtocolViewer.DepositView[] memory deposits = protocolViewer.getDepositFromIds(depositIds);

        assertEq(deposits.length, 2);
        assertEq(deposits[0].depositId, firstDepositId);
        assertEq(deposits[1].depositId, secondDepositId);
    }

    function test_getDepositFromIdsReturnsEmptyViewForUnknownDeposit() public {
        uint256[] memory depositIds = new uint256[](1);
        depositIds[0] = 1234;

        IProtocolViewer.DepositView[] memory deposits = protocolViewer.getDepositFromIds(depositIds);
        assertEq(deposits[0].deposit.depositor, address(0));
    }

    function test_getIntentReturnsIntentView() public {
        uint256 depositId = _createDeposit(100e6, 10e6, 200e6);
        bytes32 intentHash = _signal(takerA, depositId, 50e6);

        IProtocolViewer.IntentView memory intentView = protocolViewer.getIntent(intentHash);

        assertEq(intentView.intentHash, intentHash);
        assertEq(intentView.intent.owner, takerA);
        assertEq(intentView.intent.depositId, depositId);
    }

    function test_getIntentsReturnsIntentViews() public {
        uint256 depositId = _createDeposit(100e6, 10e6, 200e6);
        bytes32 intentHash = _signal(takerA, depositId, 50e6);
        bytes32[] memory intentHashes = new bytes32[](1);
        intentHashes[0] = intentHash;

        IProtocolViewer.IntentView[] memory intents = protocolViewer.getIntents(intentHashes);

        assertEq(intents.length, 1);
        assertEq(intents[0].intentHash, intentHash);
        assertEq(intents[0].intent.owner, takerA);
    }

    function test_getAccountIntentsReturnsEmptyArrayForAccountWithoutIntents() public view {
        IProtocolViewer.IntentView[] memory intents = protocolViewer.getAccountIntents(depositor);
        assertEq(intents.length, 0);
    }

    function test_getAccountIntentsReturnsAllIntentsForAccount() public {
        uint256 depositId = _createDeposit(100e6, 10e6, 200e6);
        _signal(takerA, depositId, 50e6);
        _signal(takerA, depositId, 30e6);

        IProtocolViewer.IntentView[] memory intents = protocolViewer.getAccountIntents(takerA);

        assertEq(intents.length, 2);
        assertEq(intents[0].intent.owner, takerA);
        assertEq(intents[1].intent.owner, takerA);
    }

    function _createDepositWithConfig(
        uint256 amount,
        uint256 minAmount,
        uint256 maxAmount,
        address intentGatingService,
        bytes32 payeeDetails,
        bytes memory rawData,
        uint256 minConversionRate
    ) internal returns (uint256 depositId) {
        IEscrow.CreateDepositParams memory params = IEscrow.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: amount,
            intentAmountRange: IEscrow.Range({min: minAmount, max: maxAmount}),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(intentGatingService, payeeDetails, rawData),
            currencies: _singleDepositCurrencies(USD, minConversionRate),
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }
}
