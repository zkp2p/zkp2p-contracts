// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {Escrow} from "contracts/Escrow.sol";
import {Orchestrator} from "contracts/Orchestrator.sol";
import {ProtocolViewer} from "contracts/ProtocolViewer.sol";
import {PaymentVerifierMock} from "contracts/mocks/PaymentVerifierMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {IEscrow} from "contracts/interfaces/IEscrow.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {IProtocolViewer} from "contracts/interfaces/IProtocolViewer.sol";

contract ProtocolViewerTest is Test {
    uint256 internal constant GATING_KEY = 0xA11CE;
    uint256 internal constant CHAIN_ID = 1;
    bytes32 internal constant METHOD = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("payeeDetails");

    address internal depositor;
    address internal taker;
    address internal gatingService;
    USDCMock internal token;
    Escrow internal escrow;
    Orchestrator internal orchestrator;
    ProtocolViewer internal viewer;

    function setUp() public {
        depositor = makeAddr("offRamper");
        taker = makeAddr("onRamper");
        gatingService = vm.addr(GATING_KEY);
        token = new USDCMock(1_000_000_000e6, "USDC", "USDC");
        token.transfer(depositor, 10_000e6);

        PaymentVerifierRegistry paymentVerifierRegistry = new PaymentVerifierRegistry();
        PostIntentHookRegistry postIntentHookRegistry = new PostIntentHookRegistry();
        EscrowRegistry escrowRegistry = new EscrowRegistry();
        RelayerRegistry relayerRegistry = new RelayerRegistry();
        PaymentVerifierMock verifier = new PaymentVerifierMock();
        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        paymentVerifierRegistry.addPaymentMethod(METHOD, address(verifier), currencies);

        escrow = new Escrow(address(this), CHAIN_ID, address(paymentVerifierRegistry), address(0), 0, 10, 1 days);
        escrowRegistry.addEscrow(address(escrow));
        orchestrator = new Orchestrator(
            address(this),
            CHAIN_ID,
            address(escrowRegistry),
            address(paymentVerifierRegistry),
            address(postIntentHookRegistry),
            address(relayerRegistry),
            0,
            address(this)
        );
        escrow.setOrchestrator(address(orchestrator));
        verifier.setVerificationContext(address(orchestrator), address(escrow));
        viewer = new ProtocolViewer(address(escrow), address(orchestrator));

        vm.startPrank(depositor);
        token.approve(address(escrow), 10_000e6);
        _createDeposit(100e6, 1.08e18);
        vm.stopPrank();
    }

    function _createDeposit(uint256 amount, uint256 rate) internal {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = METHOD;
        IEscrow.DepositPaymentMethodData[] memory methodData = new IEscrow.DepositPaymentMethodData[](1);
        methodData[0] = IEscrow.DepositPaymentMethodData({
            intentGatingService: gatingService, payeeDetails: PAYEE, data: abi.encode(makeAddr("witness"))
        });
        IEscrow.Currency[][] memory currencies = new IEscrow.Currency[][](1);
        currencies[0] = new IEscrow.Currency[](1);
        currencies[0][0] = IEscrow.Currency({code: USD, minConversionRate: rate});
        escrow.createDeposit(
            IEscrow.CreateDepositParams({
                token: IERC20(address(token)),
                amount: amount,
                intentAmountRange: IEscrow.Range({min: 10e6, max: 200e6}),
                paymentMethods: methods,
                paymentMethodData: methodData,
                currencies: currencies,
                delegate: address(0),
                intentGuardian: address(0),
                retainOnEmpty: false
            })
        );
    }

    function _gatingSignature(uint256 amount, uint256 expiration) internal view returns (bytes memory) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                address(escrow),
                uint256(0),
                amount,
                taker,
                METHOD,
                USD,
                uint256(1.08e18),
                expiration,
                CHAIN_ID
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(GATING_KEY, digest);
        return abi.encodePacked(r, s, v);
    }

    function _signal(uint256 amount) internal returns (bytes32) {
        uint256 expiration = block.timestamp + 1 days;
        bytes memory gatingSignature = _gatingSignature(amount, expiration);
        vm.prank(taker);
        orchestrator.signalIntent(
            IOrchestrator.SignalIntentParams({
                escrow: address(escrow),
                depositId: 0,
                amount: amount,
                to: taker,
                paymentMethod: METHOD,
                fiatCurrency: USD,
                conversionRate: 1.08e18,
                referrer: address(0),
                referrerFee: 0,
                gatingServiceSignature: gatingSignature,
                signatureExpiration: expiration,
                postIntentHook: IPostIntentHook(address(0)),
                data: ""
            })
        );
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        return hashes[hashes.length - 1];
    }

    function test_ConstructorSetsInitialEscrowAndOrchestrator() public {
        ProtocolViewer deployed = new ProtocolViewer(address(escrow), address(orchestrator));
        assertEq(address(deployed.escrowContract()), address(escrow));
        assertEq(address(deployed.orchestrator()), address(orchestrator));
    }

    function test_ConstructorRejectsZeroEscrow() public {
        vm.expectRevert(bytes("ProtocolViewer: invalid escrow"));
        new ProtocolViewer(address(0), address(orchestrator));
    }

    function test_ConstructorRejectsZeroOrchestrator() public {
        vm.expectRevert(bytes("ProtocolViewer: invalid orchestrator"));
        new ProtocolViewer(address(escrow), address(0));
    }

    function test_GetDepositReturnsCompleteDepositDetails() public view {
        IProtocolViewer.DepositView memory depositView = viewer.getDeposit(0);
        assertEq(depositView.depositId, 0);
        assertEq(address(depositView.deposit.token), address(token));
        assertEq(depositView.deposit.depositor, depositor);
        assertEq(depositView.deposit.intentAmountRange.min, 10e6);
        assertEq(depositView.deposit.intentAmountRange.max, 200e6);
        assertEq(depositView.deposit.remainingDeposits, 100e6);
        assertEq(depositView.deposit.outstandingIntentAmount, 0);
        assertTrue(depositView.deposit.acceptingIntents);
    }

    function test_GetDepositReturnsCompletePaymentMethodDetails() public view {
        IProtocolViewer.DepositView memory depositView = viewer.getDeposit(0);
        assertEq(depositView.paymentMethods.length, 1);
        assertEq(depositView.paymentMethods[0].paymentMethod, METHOD);
        assertEq(depositView.paymentMethods[0].verificationData.intentGatingService, gatingService);
        assertEq(depositView.paymentMethods[0].currencies.length, 1);
        assertEq(depositView.paymentMethods[0].currencies[0].code, USD);
        assertEq(depositView.paymentMethods[0].currencies[0].minConversionRate, 1.08e18);
    }

    function test_GetDepositReturnsAvailableLiquidity() public view {
        assertEq(viewer.getDeposit(0).availableLiquidity, 100e6);
    }

    function test_GetDepositIncludesExpiredIntentAmountInAvailableLiquidity() public {
        _signal(50e6);
        vm.warp(block.timestamp + 1 days + 1);
        IProtocolViewer.DepositView memory depositView = viewer.getDeposit(0);
        assertEq(depositView.deposit.remainingDeposits, 50e6);
        assertEq(depositView.deposit.outstandingIntentAmount, 50e6);
        assertEq(depositView.availableLiquidity, 100e6);
    }

    function test_GetDepositReturnsEmptyViewForMissingDeposit() public view {
        IProtocolViewer.DepositView memory depositView = viewer.getDeposit(1);
        assertEq(depositView.deposit.depositor, address(0));
        assertEq(depositView.paymentMethods.length, 0);
    }

    function test_GetDepositFromIdsReturnsRequestedDepositsInOrder() public {
        vm.prank(depositor);
        _createDeposit(200e6, 1.08e18);
        uint256[] memory ids = new uint256[](2);
        ids[0] = 0;
        ids[1] = 1;
        IProtocolViewer.DepositView[] memory deposits = viewer.getDepositFromIds(ids);
        assertEq(deposits.length, 2);
        assertEq(deposits[0].depositId, 0);
        assertEq(deposits[1].depositId, 1);
    }

    function test_GetDepositFromIdsReturnsEmptyViewForMissingId() public view {
        uint256[] memory ids = new uint256[](1);
        ids[0] = 2;
        IProtocolViewer.DepositView[] memory deposits = viewer.getDepositFromIds(ids);
        assertEq(deposits[0].deposit.depositor, address(0));
    }

    function test_GetIntentReturnsCorrectIntent() public {
        bytes32 intentHash = _signal(50e6);
        IProtocolViewer.IntentView memory intentView = viewer.getIntent(intentHash);
        assertEq(intentView.intentHash, intentHash);
        assertEq(intentView.intent.owner, taker);
        assertEq(intentView.intent.depositId, 0);
    }

    function test_GetIntentsReturnsCorrectIntentList() public {
        bytes32 intentHash = _signal(50e6);
        bytes32[] memory hashes = new bytes32[](1);
        hashes[0] = intentHash;
        IProtocolViewer.IntentView[] memory intents = viewer.getIntents(hashes);
        assertEq(intents.length, 1);
        assertEq(intents[0].intentHash, intentHash);
        assertEq(intents[0].intent.owner, taker);
    }

    function test_GetAccountIntentsReturnsCorrectAccountIntents() public {
        _signal(50e6);
        IProtocolViewer.IntentView[] memory intents = viewer.getAccountIntents(taker);
        assertEq(intents.length, 1);
        assertEq(intents[0].intent.owner, taker);
    }

    function test_GetAccountIntentsReturnsEmptyForAccountWithoutIntents() public view {
        assertEq(viewer.getAccountIntents(depositor).length, 0);
    }

    function test_GetAccountIntentsReturnsAllMultipleIntents() public {
        orchestrator.setAllowMultipleIntents(true);
        _signal(50e6);
        _signal(30e6);
        IProtocolViewer.IntentView[] memory intents = viewer.getAccountIntents(taker);
        assertEq(intents.length, 2);
        assertEq(intents[0].intent.owner, taker);
        assertEq(intents[1].intent.owner, taker);
    }
}
