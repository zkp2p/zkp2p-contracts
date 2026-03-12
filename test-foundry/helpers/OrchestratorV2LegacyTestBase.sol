// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { Vm } from "forge-std/Vm.sol";

import { IEscrowV2 } from "../../contracts/interfaces/IEscrowV2.sol";
import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
import { IPreIntentHook } from "../../contracts/interfaces/IPreIntentHook.sol";
import { IReferralFee } from "../../contracts/interfaces/IReferralFee.sol";
import { PartialPullPostIntentHookV2Mock } from "../../contracts/mocks/PartialPullPostIntentHookV2Mock.sol";
import { PaymentVerifierMock } from "../../contracts/mocks/PaymentVerifierMock.sol";
import { PostIntentHookV2Mock } from "../../contracts/mocks/PostIntentHookV2Mock.sol";
import { PreIntentHookMock } from "../../contracts/mocks/PreIntentHookMock.sol";
import { PushPostIntentHookV2Mock } from "../../contracts/mocks/PushPostIntentHookV2Mock.sol";
import { ReentrantPostIntentHookV2 } from "../../contracts/mocks/ReentrantPostIntentHookV2.sol";
import { ReentrantPreIntentHookMock } from "../../contracts/mocks/ReentrantPreIntentHookMock.sol";
import { ReentrantSignalIntentCallerV2Mock } from "../../contracts/mocks/ReentrantSignalIntentCallerV2Mock.sol";
import { ProtocolV2TestBase } from "./ProtocolV2TestBase.sol";

abstract contract OrchestratorV2LegacyTestBase is ProtocolV2TestBase {
    uint256 internal constant GATING_SERVICE_KEY = 0xA11CEBEEF;
    uint256 internal constant ALT_SIGNER_KEY = 0xB0BCA7E;
    uint256 internal constant INTENT_ORCHESTRATOR_SLOT = 15;

    bytes32 internal constant INTENT_SIGNALED_TOPIC =
        keccak256("IntentSignaled(bytes32,address,uint256,bytes32,address,address,uint256,bytes32,uint256,uint256)");

    PaymentVerifierMock internal paymentVerifierMock;
    PreIntentHookMock internal preIntentHookMock;
    PreIntentHookMock internal whitelistHookMock;
    PostIntentHookV2Mock internal postIntentHookMock;
    PartialPullPostIntentHookV2Mock internal partialPostIntentHookMock;
    PushPostIntentHookV2Mock internal pushPostIntentHookMock;
    ReentrantPostIntentHookV2 internal reentrantPostIntentHook;
    ReentrantPreIntentHookMock internal reentrantPreIntentHookMock;
    ReentrantSignalIntentCallerV2Mock internal reentrantSignalIntentCallerMock;

    address internal taker;
    address internal other;
    address internal referrer;
    address internal protocolFeeRecipient;
    address internal gatingService;
    address internal altSigner;
    bytes32 internal payeeDetails;
    uint256 internal defaultDepositId;

    function _setUpOrchestratorV2LegacyHarness() internal {
        _setUpV2Core();

        paymentVerifierMock = verifier;
        taker = takerA;
        other = takerB;
        referrer = makeAddr("referrer");
        protocolFeeRecipient = feeRecipient;
        gatingService = vm.addr(GATING_SERVICE_KEY);
        altSigner = vm.addr(ALT_SIGNER_KEY);
        payeeDetails = keccak256("payee");

        preIntentHookMock = new PreIntentHookMock();
        whitelistHookMock = new PreIntentHookMock();
        postIntentHookMock = new PostIntentHookV2Mock(address(usdc), address(orchestrator));
        partialPostIntentHookMock = new PartialPullPostIntentHookV2Mock(address(usdc), address(orchestrator));
        pushPostIntentHookMock = new PushPostIntentHookV2Mock(address(usdc), address(orchestrator));
        reentrantPostIntentHook = new ReentrantPostIntentHookV2(address(usdc), address(orchestrator));
        reentrantSignalIntentCallerMock = new ReentrantSignalIntentCallerV2Mock(address(orchestrator));
        reentrantPreIntentHookMock = new ReentrantPreIntentHookMock(address(reentrantSignalIntentCallerMock));

        vm.prank(owner);
        usdc.transfer(address(pushPostIntentHookMock), 10e6);

        defaultDepositId = _createDeposit(address(0));
    }

    function _createDeposit(address intentGatingService) internal returns (uint256 depositId) {
        IEscrowV2.CreateDepositParams memory params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(usdc)),
            amount: 500e6,
            intentAmountRange: IEscrowV2.Range({ min: 10e6, max: 200e6 }),
            paymentMethods: _singlePaymentMethods(VENMO),
            paymentMethodData: _singlePaymentMethodData(intentGatingService, payeeDetails, ""),
            currencies: _singleDepositCurrencies(USD, 1e18),
            delegate: delegate,
            intentGuardian: address(0),
            retainOnEmpty: false
        });

        vm.prank(depositor);
        escrow.createDeposit(params);
        depositId = escrow.depositCounter() - 1;
    }

    function _buildSignalIntentParams(address caller) internal view returns (IOrchestratorV2.SignalIntentParams memory params) {
        params = _defaultSignalIntentParams(caller);
        params.depositId = defaultDepositId;
        params.amount = 50e6;
        params.to = caller;
        params.conversionRate = 1e18;
    }

    function _signalIntent(address caller, IOrchestratorV2.SignalIntentParams memory params) internal returns (bytes32 intentHash) {
        vm.prank(caller);
        orchestrator.signalIntent(params);

        bytes32[] memory accountIntentHashes = orchestrator.getAccountIntents(caller);
        intentHash = accountIntentHashes[accountIntentHashes.length - 1];
    }

    function _buildFulfillParams(
        bytes32 intentHash,
        uint256 fiatAmount,
        bytes32 proofIntentHash
    ) internal view returns (IOrchestratorV2.FulfillIntentParams memory params) {
        params = IOrchestratorV2.FulfillIntentParams({
            paymentProof: abi.encode(fiatAmount, block.timestamp, payeeDetails, USD, proofIntentHash),
            intentHash: intentHash,
            verificationData: "",
            postIntentHookData: ""
        });
    }

    function _signGatingSignature(
        IOrchestratorV2.SignalIntentParams memory params,
        uint256 signerKey,
        address signedCaller
    ) internal view returns (bytes memory signature) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                params.escrow,
                params.depositId,
                params.amount,
                signedCaller,
                params.to,
                params.paymentMethod,
                params.fiatCurrency,
                params.conversionRate,
                _hashReferralFees(params.referralFees),
                params.signatureExpiration,
                CHAIN_ID
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _singleReferralFee(
        address recipient,
        uint256 fee
    ) internal pure returns (IReferralFee.ReferralFee[] memory referralFees) {
        referralFees = new IReferralFee.ReferralFee[](1);
        referralFees[0] = IReferralFee.ReferralFee({ recipient: recipient, fee: fee });
    }

    function _twoReferralFees(
        address recipientA,
        uint256 feeA,
        address recipientB,
        uint256 feeB
    ) internal pure returns (IReferralFee.ReferralFee[] memory referralFees) {
        referralFees = new IReferralFee.ReferralFee[](2);
        referralFees[0] = IReferralFee.ReferralFee({ recipient: recipientA, fee: feeA });
        referralFees[1] = IReferralFee.ReferralFee({ recipient: recipientB, fee: feeB });
    }

    function _sixReferralFees() internal view returns (IReferralFee.ReferralFee[] memory referralFees) {
        referralFees = new IReferralFee.ReferralFee[](6);
        referralFees[0] = IReferralFee.ReferralFee({ recipient: referrer, fee: 0.001e18 });
        referralFees[1] = IReferralFee.ReferralFee({ recipient: other, fee: 0.001e18 });
        referralFees[2] = IReferralFee.ReferralFee({ recipient: delegate, fee: 0.001e18 });
        referralFees[3] = IReferralFee.ReferralFee({ recipient: depositor, fee: 0.001e18 });
        referralFees[4] = IReferralFee.ReferralFee({ recipient: protocolFeeRecipient, fee: 0.001e18 });
        referralFees[5] = IReferralFee.ReferralFee({ recipient: owner, fee: 0.001e18 });
    }

    function _hashReferralFees(
        IReferralFee.ReferralFee[] memory referralFees
    ) internal pure returns (bytes32 referralFeesHash) {
        bytes32[] memory feeHashes = new bytes32[](referralFees.length);

        for (uint256 i = 0; i < referralFees.length; i++) {
            feeHashes[i] = keccak256(abi.encode(referralFees[i].recipient, referralFees[i].fee));
        }

        referralFeesHash = keccak256(abi.encode(feeHashes));
    }

    function _clearIntentOrchestrator(bytes32 intentHash) internal {
        bytes32 storageSlot = keccak256(abi.encode(intentHash, uint256(INTENT_ORCHESTRATOR_SLOT)));
        vm.store(address(escrow), storageSlot, bytes32(0));
    }

    function _extractIntentHashFromLogs(Vm.Log[] memory entries) internal view returns (bytes32 intentHash) {
        for (uint256 i = 0; i < entries.length; i++) {
            if (
                entries[i].emitter == address(orchestrator)
                    && entries[i].topics.length == 4
                    && entries[i].topics[0] == INTENT_SIGNALED_TOPIC
            ) {
                return entries[i].topics[1];
            }
        }

        revert("IntentSignaled not found");
    }
}
