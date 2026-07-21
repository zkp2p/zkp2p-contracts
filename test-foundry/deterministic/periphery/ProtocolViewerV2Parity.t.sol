// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {ProtocolViewerV2} from "contracts/ProtocolViewerV2.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {RateManagerMock} from "contracts/mocks/RateManagerMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IProtocolViewerV2} from "contracts/interfaces/IProtocolViewerV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";

contract ProtocolViewerV2ParityTest is Test {
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payee");
    bytes32 internal constant MANAGER_ID = bytes32("manager-1");

    address internal depositor;
    address internal taker;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    ProtocolViewerV2 internal viewer;
    RateManagerMock internal rateManager;

    function setUp() public {
        depositor = makeAddr("depositor");
        taker = makeAddr("taker");
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 100_000e6);

        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        EscrowRegistry escrowRegistry = new EscrowRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        escrow = new EscrowV2(
            address(this),
            1,
            address(orchestratorRegistry),
            address(paymentVerifierRegistry),
            address(this),
            0,
            20,
            1 days
        );
        orchestrator = new OrchestratorV2(
            address(this), 1, address(escrowRegistry), address(paymentVerifierRegistry), 0, address(this)
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        viewer = new ProtocolViewerV2();

        vm.startPrank(depositor);
        token.approve(address(escrow), 100_000e6);
        _createDeposit(500e6, 1e18);
        vm.stopPrank();
    }

    function _createDeposit(uint256 amount, uint256 rate) internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrowV2.DepositPaymentMethodData[] memory methodData = new IEscrowV2.DepositPaymentMethodData[](1);
        methodData[0] =
            IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: rate,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
        escrow.createDeposit(
            IEscrowV2.CreateDepositParams({
                token: IERC20(address(token)),
                amount: amount,
                intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _delegateRate(uint256 rate) internal {
        rateManager = new RateManagerMock();
        rateManager.setManager(MANAGER_ID, true);
        rateManager.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, rate);
        vm.prank(depositor);
        escrow.setRateManager(0, address(rateManager), MANAGER_ID);
    }

    function _signal(uint256 amount) internal returns (bytes32) {
        IReferralFee.ReferralFee[] memory referralFees = new IReferralFee.ReferralFee[](0);
        vm.prank(taker);
        orchestrator.signalIntent(
            IOrchestratorV2.SignalIntentParams({
                escrow: address(escrow),
                depositId: 0,
                amount: amount,
                to: taker,
                paymentMethod: METHOD,
                fiatCurrency: USD,
                conversionRate: 1e18,
                referralFees: referralFees,
                gatingServiceSignature: "",
                signatureExpiration: 0,
                postIntentHook: IPostIntentHookV2(address(0)),
                preIntentHookData: "",
                data: ""
            })
        );
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        return hashes[hashes.length - 1];
    }

    function _signalTwoIntents() internal returns (bytes32 firstHash, bytes32 secondHash) {
        firstHash = _signal(50e6);
        secondHash = _signal(30e6);
    }

    function test_GetDepositReturnsCompleteDepositPaymentMethodAndCurrencyData() public view {
        IProtocolViewerV2.DepositView memory depositView = viewer.getDeposit(address(escrow), 0);
        assertEq(depositView.depositId, 0);
        assertEq(depositView.deposit.depositor, depositor);
        assertEq(address(depositView.deposit.token), address(token));
        assertEq(depositView.deposit.remainingDeposits, 500e6);
        assertEq(depositView.availableLiquidity, 500e6);
        assertEq(depositView.paymentMethods[0].paymentMethod, METHOD);
        assertEq(depositView.paymentMethods[0].currencies[0].code, USD);
    }

    function test_GetDepositReturnsNativeRateWithoutManager() public view {
        assertEq(viewer.getDeposit(address(escrow), 0).paymentMethods[0].currencies[0].minConversionRate, 1e18);
    }

    function test_GetDepositReturnsDelegatedManagerRate() public {
        _delegateRate(1.5e18);
        assertEq(viewer.getDeposit(address(escrow), 0).paymentMethods[0].currencies[0].minConversionRate, 1.5e18);
    }

    function test_GetDepositFallsBackToNativeRateWhenManagerReverts() public {
        _delegateRate(1.5e18);
        rateManager.setShouldRevertOnGetRate(true);
        assertEq(viewer.getDeposit(address(escrow), 0).paymentMethods[0].currencies[0].minConversionRate, 1e18);
    }

    function test_GetDepositReturnsZeroWhenManagerDisablesPair() public {
        _delegateRate(1.5e18);
        rateManager.setRate(MANAGER_ID, address(escrow), 0, METHOD, USD, 0);
        assertEq(viewer.getDeposit(address(escrow), 0).paymentMethods[0].currencies[0].minConversionRate, 0);
    }

    function test_GetDepositRejectsZeroEscrow() public {
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidEscrow.selector, address(0)));
        viewer.getDeposit(address(0), 0);
    }

    function test_GetDepositFromIdsReturnsEveryRequestedDeposit() public {
        vm.prank(depositor);
        _createDeposit(250e6, 1.01e18);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        IProtocolViewerV2.DepositView[] memory deposits = viewer.getDepositFromIds(address(escrow), ids);
        assertEq(deposits.length, 2);
        assertEq(deposits[0].depositId, 0);
        assertEq(deposits[1].depositId, 1);
        assertEq(deposits[1].deposit.remainingDeposits, 250e6);
    }

    function test_GetDepositFromIdsRejectsZeroEscrowEvenWhenIdsEmpty() public {
        uint256[] memory ids = new uint256[](0);
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidEscrow.selector, address(0)));
        viewer.getDepositFromIds(address(0), ids);
    }

    function test_GetIntentReturnsIntentAndDepositResolvedFromIntentEscrow() public {
        (bytes32 intentHash,) = _signalTwoIntents();
        IProtocolViewerV2.IntentView memory intentView = viewer.getIntent(address(orchestrator), intentHash);
        assertEq(intentView.intentHash, intentHash);
        assertEq(intentView.intent.owner, taker);
        assertEq(intentView.intent.escrow, address(escrow));
        assertEq(intentView.deposit.depositId, 0);
        assertEq(intentView.deposit.deposit.depositor, depositor);
    }

    function test_GetAccountIntentsReturnsAllAccountIntents() public {
        _signalTwoIntents();
        IProtocolViewerV2.IntentView[] memory intents = viewer.getAccountIntents(address(orchestrator), taker);
        assertEq(intents.length, 2);
        assertEq(intents[0].intent.owner, taker);
        assertEq(intents[1].intent.owner, taker);
    }

    function test_GetIntentsReturnsViewsForProvidedHashesInOrder() public {
        _signalTwoIntents();
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        IProtocolViewerV2.IntentView[] memory intents = viewer.getIntents(address(orchestrator), hashes);
        assertEq(intents.length, 2);
        assertEq(intents[0].intentHash, hashes[0]);
        assertEq(intents[1].intentHash, hashes[1]);
        assertEq(intents[0].intent.owner, taker);
        assertEq(intents[1].intent.owner, taker);
    }

    function test_GetIntentRejectsZeroOrchestrator() public {
        bytes32 intentHash = _signal(50e6);
        vm.expectRevert(abi.encodeWithSelector(ProtocolViewerV2.InvalidOrchestrator.selector, address(0)));
        viewer.getIntent(address(0), intentHash);
    }
}
