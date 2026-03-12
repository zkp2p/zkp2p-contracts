// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Vm } from "forge-std/Vm.sol";

import { IOrchestratorV2 } from "../../contracts/interfaces/IOrchestratorV2.sol";
import { IPreIntentHook } from "../../contracts/interfaces/IPreIntentHook.sol";
import { IReferralFee } from "../../contracts/interfaces/IReferralFee.sol";
import { PreIntentHookMock } from "../../contracts/mocks/PreIntentHookMock.sol";
import { ReentrantPreIntentHookMock } from "../../contracts/mocks/ReentrantPreIntentHookMock.sol";
import { ReentrantSignalIntentCallerV2Mock } from "../../contracts/mocks/ReentrantSignalIntentCallerV2Mock.sol";
import { SignatureGatingPreIntentHook } from "../../contracts/hooks/SignatureGatingPreIntentHook.sol";
import { ProtocolV2TestBase } from "../helpers/ProtocolV2TestBase.sol";

contract PreIntentHookTest is ProtocolV2TestBase {
    uint256 internal constant DELEGATE_KEY = 0xD11E6A7E;
    uint256 internal constant UNAUTHORIZED_KEY = 0xBAADF00D;

    event DepositPreIntentHookSet(address indexed escrow, uint256 indexed depositId, address indexed hook, address setter);
    event DepositSignerSet(address indexed escrow, uint256 indexed depositId, address indexed signer, address setter);
    event IntentSignaled(
        bytes32 indexed intentHash,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        address owner,
        address to,
        uint256 amount,
        bytes32 fiatCurrency,
        uint256 conversionRate,
        uint256 timestamp
    );

    PreIntentHookMock internal preIntentHookMock;
    ReentrantPreIntentHookMock internal reentrantPreIntentHookMock;
    ReentrantSignalIntentCallerV2Mock internal reentrantSignalIntentCallerMock;
    SignatureGatingPreIntentHook internal signatureGatingPreIntentHook;

    function setUp() public {
        _setUpV2Core();

        delegate = vm.addr(DELEGATE_KEY);
        unauthorizedCaller = vm.addr(UNAUTHORIZED_KEY);

        preIntentHookMock = new PreIntentHookMock();
        reentrantSignalIntentCallerMock = new ReentrantSignalIntentCallerV2Mock(address(orchestrator));
        reentrantPreIntentHookMock = new ReentrantPreIntentHookMock(address(reentrantSignalIntentCallerMock));
        signatureGatingPreIntentHook = new SignatureGatingPreIntentHook(address(orchestratorRegistry), CHAIN_ID);

        _createDeposit();
    }

    function test_setDepositPreIntentHookAllowsDepositorToSetHook() public {
        vm.expectEmit(true, true, true, true);
        emit DepositPreIntentHookSet(address(escrow), 0, address(preIntentHookMock), depositor);

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(preIntentHookMock));
    }

    function test_setDepositPreIntentHookAllowsDelegateToSetHook() public {
        vm.expectEmit(true, true, true, true);
        emit DepositPreIntentHookSet(address(escrow), 0, address(preIntentHookMock), delegate);

        vm.prank(delegate);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(preIntentHookMock));
    }

    function test_setDepositPreIntentHookRevertsForUnauthorizedCaller() public {
        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));
    }

    function test_setDepositPreIntentHookRemovesHookWhenZeroAddressIsProvided() public {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));

        vm.expectEmit(true, true, true, true);
        emit DepositPreIntentHookSet(address(escrow), 0, address(0), depositor);

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(0)));

        assertEq(address(orchestrator.getDepositPreIntentHook(address(escrow), 0)), address(0));
    }

    function test_setDepositPreIntentHookRevertsForEoaHook() public {
        vm.prank(depositor);
        vm.expectRevert(abi.encodeWithSelector(IOrchestratorV2.InvalidPreIntentHook.selector, unauthorizedCaller));
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(unauthorizedCaller));
    }

    function test_setDepositPreIntentHookRevertsWhenDepositDoesNotExist() public {
        vm.prank(depositor);
        vm.expectRevert(
            abi.encodeWithSelector(
                IOrchestratorV2.UnauthorizedCallerOrDelegate.selector,
                depositor,
                address(0),
                address(0)
            )
        );
        orchestrator.setDepositPreIntentHook(address(escrow), 1, IPreIntentHook(address(preIntentHookMock)));
    }

    function test_setDepositPreIntentHookRevertsWhenEscrowIsZeroAddress() public {
        vm.prank(depositor);
        vm.expectRevert(IOrchestratorV2.ZeroAddress.selector);
        orchestrator.setDepositPreIntentHook(address(0), 0, IPreIntentHook(address(preIntentHookMock)));
    }

    function test_signalIntentPassesPreIntentHookDataAndDoesNotPersistIt() public {
        bytes memory preIntentHookData = abi.encode(uint256(7));
        bytes memory signalData = abi.encode(uint256(42));

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));

        vm.prank(takerA);
        orchestrator.signalIntent(_signalIntentParams(takerA, takerA, uint256(1.02e18), signalData, preIntentHookData));

        bytes32 intentHash = _singleIntentHash(takerA);
        IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);

        assertEq(preIntentHookMock.callCount(), 1);
        assertEq(preIntentHookMock.lastTaker(), takerA);
        assertEq(preIntentHookMock.lastEscrow(), address(escrow));
        assertEq(preIntentHookMock.lastDepositId(), 0);
        assertEq(preIntentHookMock.lastPreIntentHookData(), preIntentHookData);
        assertEq(intent.data, signalData);
        assertNotEq(keccak256(intent.data), keccak256(preIntentHookData));
    }

    function test_signalIntentRevertsWhenPreIntentHookRejects() public {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));
        preIntentHookMock.setShouldRevert(true);

        vm.prank(takerA);
        vm.expectRevert(bytes("PreIntentHookMock: rejected"));
        orchestrator.signalIntent(_signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode(uint256(42)), abi.encode(uint256(7))));

        assertEq(orchestrator.getAccountIntents(takerA).length, 0);
    }

    function test_signalIntentWorksWhenNoPreIntentHookIsSet() public {
        vm.recordLogs();
        vm.prank(takerA);
        orchestrator.signalIntent(_signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode(uint256(42)), abi.encode(uint256(7))));

        _assertIntentSignaledLogged(vm.getRecordedLogs());
        assertEq(orchestrator.getAccountIntents(takerA).length, 1);
        assertEq(preIntentHookMock.callCount(), 0);
    }

    function test_signalIntentSkipsPreHookExecutionAfterRemoval() public {
        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(preIntentHookMock)));

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(0)));

        vm.prank(takerA);
        orchestrator.signalIntent(_signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode(uint256(42)), abi.encode(uint256(7))));

        assertEq(preIntentHookMock.callCount(), 0);
        assertEq(orchestrator.getAccountIntents(takerA).length, 1);
    }

    function test_signalIntentPreventsHookDrivenReentrantBypassOfOneActiveIntentRule() public {
        bytes memory preIntentHookData = abi.encode(uint256(7));
        bytes memory signalData = abi.encode(uint256(42));

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(reentrantPreIntentHookMock)));

        IOrchestratorV2.SignalIntentParams memory reentryParams =
            _signalIntentParams(address(reentrantSignalIntentCallerMock), address(reentrantSignalIntentCallerMock), uint256(1.02e18), signalData, preIntentHookData);
        reentrantSignalIntentCallerMock.setReentryParams(reentryParams);

        vm.recordLogs();
        reentrantSignalIntentCallerMock.signalIntent(reentryParams);

        _assertIntentSignaledLogged(vm.getRecordedLogs());
        assertEq(reentrantPreIntentHookMock.reentryAttemptCount(), 1);
        assertFalse(reentrantPreIntentHookMock.lastReentrySucceeded());
        assertEq(orchestrator.getAccountIntents(address(reentrantSignalIntentCallerMock)).length, 1);
    }

    function test_signatureGatingConstructorRevertsForZeroRegistry() public {
        vm.expectRevert(SignatureGatingPreIntentHook.ZeroAddress.selector);
        new SignatureGatingPreIntentHook(address(0), CHAIN_ID);
    }

    function test_setDepositSignerAllowsDepositorToSetSigner() public {
        vm.expectEmit(true, true, true, true);
        emit DepositSignerSet(address(escrow), 0, delegate, depositor);

        vm.prank(depositor);
        signatureGatingPreIntentHook.setDepositSigner(address(escrow), 0, delegate);

        assertEq(signatureGatingPreIntentHook.getDepositSigner(address(escrow), 0), delegate);
    }

    function test_setDepositSignerAllowsDelegateToSetSigner() public {
        vm.expectEmit(true, true, true, true);
        emit DepositSignerSet(address(escrow), 0, owner, delegate);

        vm.prank(delegate);
        signatureGatingPreIntentHook.setDepositSigner(address(escrow), 0, owner);

        assertEq(signatureGatingPreIntentHook.getDepositSigner(address(escrow), 0), owner);
    }

    function test_setDepositSignerRevertsForUnauthorizedCaller() public {
        vm.prank(unauthorizedCaller);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureGatingPreIntentHook.UnauthorizedCallerOrDelegate.selector,
                unauthorizedCaller,
                depositor,
                delegate
            )
        );
        signatureGatingPreIntentHook.setDepositSigner(address(escrow), 0, delegate);
    }

    function test_setDepositSignerRevertsWhenEscrowIsZeroAddress() public {
        vm.prank(depositor);
        vm.expectRevert(SignatureGatingPreIntentHook.ZeroAddress.selector);
        signatureGatingPreIntentHook.setDepositSigner(address(0), 0, delegate);
    }

    function test_signalIntentAcceptsValidSignatureData() public {
        _configureSignatureHook(delegate);

        uint256 signatureExpiration = block.timestamp + 3600;
        bytes memory signature = _signHookPayload(DELEGATE_KEY, takerA, takerA, uint256(1.02e18), signatureExpiration);
        bytes memory preIntentHookData = abi.encode(signature, signatureExpiration);

        vm.recordLogs();
        vm.prank(takerA);
        orchestrator.signalIntent(
            _signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode("post-intent-signal-data"), preIntentHookData)
        );

        _assertIntentSignaledLogged(vm.getRecordedLogs());
    }

    function test_signalIntentRevertsForInvalidSignatureSigner() public {
        _configureSignatureHook(delegate);

        uint256 signatureExpiration = block.timestamp + 3600;
        bytes memory signature = _signHookPayload(UNAUTHORIZED_KEY, takerA, takerA, uint256(1.02e18), signatureExpiration);
        bytes memory preIntentHookData = abi.encode(signature, signatureExpiration);

        vm.prank(takerA);
        vm.expectRevert(SignatureGatingPreIntentHook.InvalidSignature.selector);
        orchestrator.signalIntent(
            _signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode("post-intent-signal-data"), preIntentHookData)
        );
    }

    function test_validateSignalIntentDirectCallRevertsForUnauthorizedCaller() public {
        IPreIntentHook.PreIntentContext memory context = IPreIntentHook.PreIntentContext({
            taker: takerA,
            escrow: address(escrow),
            depositId: 0,
            amount: 50e6,
            to: takerA,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: uint256(1.02e18),
            referralFees: _emptyReferralFees(),
            preIntentHookData: ""
        });

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(SignatureGatingPreIntentHook.UnauthorizedOrchestratorCaller.selector, takerA)
        );
        signatureGatingPreIntentHook.validateSignalIntent(context);
    }

    function test_signalIntentRevertsWhenSignerIsNotConfigured() public {
        SignatureGatingPreIntentHook freshHook =
            new SignatureGatingPreIntentHook(address(orchestratorRegistry), CHAIN_ID);

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(freshHook)));

        uint256 signatureExpiration = block.timestamp + 3600;
        bytes memory signature = _signHookPayload(DELEGATE_KEY, takerA, takerA, uint256(1.02e18), signatureExpiration);
        bytes memory preIntentHookData = abi.encode(signature, signatureExpiration);

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(SignatureGatingPreIntentHook.SignerNotSet.selector, address(escrow), uint256(0))
        );
        orchestrator.signalIntent(
            _signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode("post-intent-signal-data"), preIntentHookData)
        );
    }

    function test_signalIntentRevertsWhenCallerDiffersFromSignedTaker() public {
        _configureSignatureHook(delegate);

        uint256 signatureExpiration = block.timestamp + 3600;
        bytes memory signature = _signHookPayload(DELEGATE_KEY, takerA, takerA, uint256(1.02e18), signatureExpiration);
        bytes memory preIntentHookData = abi.encode(signature, signatureExpiration);

        vm.prank(unauthorizedCaller);
        vm.expectRevert(SignatureGatingPreIntentHook.InvalidSignature.selector);
        orchestrator.signalIntent(
            _signalIntentParams(unauthorizedCaller, takerA, uint256(1.02e18), abi.encode("post-intent-signal-data"), preIntentHookData)
        );
    }

    function test_signalIntentRevertsWhenSignatureIsExpired() public {
        _configureSignatureHook(delegate);

        uint256 signatureExpiration = block.timestamp - 1;
        bytes memory signature = _signHookPayload(DELEGATE_KEY, takerA, takerA, uint256(1.02e18), signatureExpiration);
        bytes memory preIntentHookData = abi.encode(signature, signatureExpiration);

        vm.prank(takerA);
        vm.expectRevert(
            abi.encodeWithSelector(
                SignatureGatingPreIntentHook.SignatureExpired.selector,
                signatureExpiration,
                block.timestamp
            )
        );
        orchestrator.signalIntent(
            _signalIntentParams(takerA, takerA, uint256(1.02e18), abi.encode("post-intent-signal-data"), preIntentHookData)
        );
    }

    function _configureSignatureHook(address signer) internal {
        vm.prank(depositor);
        signatureGatingPreIntentHook.setDepositSigner(address(escrow), 0, signer);

        vm.prank(depositor);
        orchestrator.setDepositPreIntentHook(address(escrow), 0, IPreIntentHook(address(signatureGatingPreIntentHook)));
    }

    function _signalIntentParams(
        address caller,
        address to,
        uint256 conversionRate,
        bytes memory data,
        bytes memory preIntentHookData
    ) internal view returns (IOrchestratorV2.SignalIntentParams memory params) {
        params = _defaultSignalIntentParams(caller);
        params.to = to;
        params.conversionRate = conversionRate;
        params.data = data;
        params.preIntentHookData = preIntentHookData;
    }

    function _singleIntentHash(address account) internal view returns (bytes32 intentHash) {
        bytes32[] memory intentHashes = orchestrator.getAccountIntents(account);
        assertEq(intentHashes.length, 1);
        intentHash = intentHashes[0];
    }

    function _signHookPayload(
        uint256 signerKey,
        address signedCaller,
        address to,
        uint256 conversionRate,
        uint256 signatureExpiration
    ) internal view returns (bytes memory signature) {
        bytes32 messageHash = keccak256(
            abi.encodePacked(
                address(orchestrator),
                address(escrow),
                uint256(0),
                uint256(50e6),
                signedCaller,
                to,
                VENMO,
                USD,
                conversionRate,
                _emptyReferralFeesHash(),
                signatureExpiration,
                CHAIN_ID
            )
        );

        bytes32 digest = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerKey, digest);
        signature = abi.encodePacked(r, s, v);
    }

    function _assertIntentSignaledLogged(Vm.Log[] memory entries) internal {
        bytes32 signalEventSig =
            keccak256("IntentSignaled(bytes32,address,uint256,bytes32,address,address,uint256,bytes32,uint256,uint256)");

        for (uint256 index = 0; index < entries.length; index++) {
            if (
                entries[index].emitter == address(orchestrator)
                    && entries[index].topics.length > 0
                    && entries[index].topics[0] == signalEventSig
            ) {
                return;
            }
        }

        fail("IntentSignaled not found");
    }

    function _emptyReferralFeesHash() internal pure returns (bytes32) {
        bytes32[] memory feeHashes = new bytes32[](0);
        return keccak256(abi.encode(feeHashes));
    }
}
