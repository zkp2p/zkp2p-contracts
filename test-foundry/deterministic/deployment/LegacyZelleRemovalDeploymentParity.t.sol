// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV2} from "contracts/OrchestratorV2.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {SimpleAttestationVerifier} from "contracts/unifiedVerifier/SimpleAttestationVerifier.sol";
import {UnifiedPaymentVerifier} from "contracts/unifiedVerifier/UnifiedPaymentVerifier.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";

contract LegacyZelleRemovalDeploymentParityTest is Test {
    uint256 internal constant WITNESS_KEY = 0xA11CE;
    bytes32 internal constant GENERIC = keccak256("zelle");
    bytes32 internal constant CITI = keccak256("zelle-citi");
    bytes32 internal constant CHASE = keccak256("zelle-chase");
    bytes32 internal constant BOFA = keccak256("zelle-bofa");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant PAYEE = keccak256("zelle-payee");

    address internal maker;
    address internal taker;
    USDCMock internal token;
    EscrowV2 internal escrow;
    OrchestratorV2 internal orchestrator;
    PaymentVerifierRegistry internal registry;
    UnifiedPaymentVerifier internal legacyVerifier;
    UnifiedPaymentVerifier internal v2Verifier;
    UnifiedPaymentVerifierV3 internal v3Verifier;
    uint256[] internal legacyDepositIds;

    function setUp() public {
        maker = makeAddr("maker");
        taker = makeAddr("taker");
        token = new USDCMock(1_000_000e6, "USDC", "USDC");
        EscrowRegistry escrowRegistry = new EscrowRegistry();
        OrchestratorRegistry orchestratorRegistry = new OrchestratorRegistry();
        registry = new PaymentVerifierRegistry();
        NullifierRegistry legacyNullifier = new NullifierRegistry();
        NullifierRegistryV2 nullifierV2 = new NullifierRegistryV2(INullifierRegistry(address(legacyNullifier)));
        SimpleAttestationVerifier attestationVerifier = new SimpleAttestationVerifier(vm.addr(WITNESS_KEY));

        escrow = new EscrowV2(
            address(this),
            block.chainid,
            address(orchestratorRegistry),
            address(registry),
            address(this),
            0,
            20,
            1 hours
        );
        orchestrator = new OrchestratorV2(
            address(this),
            block.chainid,
            address(escrowRegistry),
            address(registry),
            address(new RelayerRegistry()),
            0,
            address(this)
        );
        orchestrator.setAllowMultipleIntents(true);
        legacyVerifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(legacyNullifier)),
            IAttestationVerifier(address(attestationVerifier))
        );
        v2Verifier = new UnifiedPaymentVerifier(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistry(address(legacyNullifier)),
            IAttestationVerifier(address(attestationVerifier))
        );
        v3Verifier = new UnifiedPaymentVerifierV3(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistryV2(address(nullifierV2)),
            IAttestationVerifier(address(attestationVerifier))
        );
        escrowRegistry.addEscrow(address(escrow));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        legacyNullifier.addWritePermission(address(v2Verifier));

        bytes32[] memory currencies = _usd();
        registry.addPaymentMethod(GENERIC, address(v2Verifier), currencies);
        v2Verifier.addPaymentMethod(GENERIC);
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            registry.addPaymentMethod(method, address(v2Verifier), currencies);
            legacyVerifier.addPaymentMethod(method);
            v2Verifier.addPaymentMethod(method);
        }

        token.transfer(maker, 2_000e6);
        vm.startPrank(maker);
        token.approve(address(escrow), 2_000e6);
        for (uint256 i; i < 3; ++i) {
            legacyDepositIds.push(_createDeposit(_legacyMethod(i), 300e6));
        }
        vm.stopPrank();
    }

    function _usd() internal pure returns (bytes32[] memory currencies) {
        currencies = new bytes32[](1);
        currencies[0] = USD;
    }

    function _legacyMethod(uint256 index) internal pure returns (bytes32) {
        if (index == 0) return CITI;
        if (index == 1) return CHASE;
        return BOFA;
    }

    function _createDeposit(bytes32 method, uint256 amount) internal returns (uint256 id) {
        id = escrow.depositCounter();
        escrow.createDeposit(_depositParams(method, amount));
    }

    function _depositParams(bytes32 method, uint256 amount)
        internal
        view
        returns (IEscrowV2.CreateDepositParams memory params)
    {
        bytes32[] memory methods = new bytes32[](1);
        methods[0] = method;
        IEscrowV2.DepositPaymentMethodData[] memory data = new IEscrowV2.DepositPaymentMethodData[](1);
        data[0] = IEscrowV2.DepositPaymentMethodData({intentGatingService: address(0), payeeDetails: PAYEE, data: ""});
        IEscrowV2.Currency[][] memory currencies = new IEscrowV2.Currency[][](1);
        currencies[0] = new IEscrowV2.Currency[](1);
        currencies[0][0] = IEscrowV2.Currency({
            code: USD,
            minConversionRate: 1e18,
            oracleRateConfig: IEscrowV2.OracleRateConfig({
                adapter: address(0), adapterConfig: "", spreadBps: 0, maxStaleness: 0
            })
        });
        params = IEscrowV2.CreateDepositParams({
            token: IERC20(address(token)),
            amount: amount,
            intentAmountRange: IEscrowV2.Range({min: 10e6, max: 200e6}),
            paymentMethods: methods,
            paymentMethodData: data,
            currencies: currencies,
            delegate: address(0),
            intentGuardian: address(0),
            retainOnEmpty: false
        });
    }

    function _migrate() internal returns (uint256 calls) {
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            if (registry.isPaymentMethod(method)) {
                registry.removePaymentMethod(method);
                ++calls;
            }
        }
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            if (_contains(legacyVerifier.getPaymentMethods(), method)) {
                legacyVerifier.removePaymentMethod(method);
                ++calls;
            }
        }
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            if (_contains(v2Verifier.getPaymentMethods(), method)) {
                v2Verifier.removePaymentMethod(method);
                ++calls;
            }
        }
    }

    function _submitSignal(uint256 depositId, bytes32 method) internal {
        IReferralFee.ReferralFee[] memory fees = new IReferralFee.ReferralFee[](0);
        vm.prank(taker);
        orchestrator.signalIntent(
            IOrchestratorV2.SignalIntentParams({
                escrow: address(escrow),
                depositId: depositId,
                amount: 50e6,
                to: taker,
                paymentMethod: method,
                fiatCurrency: USD,
                conversionRate: 1e18,
                referralFees: fees,
                gatingServiceSignature: "",
                signatureExpiration: 0,
                postIntentHook: IPostIntentHookV2(address(0)),
                preIntentHookData: "",
                data: ""
            })
        );
    }

    function _signal(uint256 depositId, bytes32 method) internal returns (bytes32 intentHash) {
        _submitSignal(depositId, method);
        bytes32[] memory hashes = orchestrator.getAccountIntents(taker);
        return hashes[hashes.length - 1];
    }

    function _proof(bytes32 intentHash) internal view returns (bytes memory) {
        IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);
        UnifiedPaymentVerifier.PaymentDetails memory payment = UnifiedPaymentVerifier.PaymentDetails({
            method: GENERIC,
            payeeId: PAYEE,
            amount: intent.amount,
            currency: USD,
            timestamp: block.timestamp * 1000,
            paymentId: keccak256("generic-zelle-payment")
        });
        UnifiedPaymentVerifier.IntentSnapshot memory snapshot = UnifiedPaymentVerifier.IntentSnapshot({
            intentHash: intentHash,
            amount: intent.amount,
            paymentMethod: GENERIC,
            fiatCurrency: USD,
            payeeDetails: PAYEE,
            conversionRate: intent.conversionRate,
            signalTimestamp: intent.timestamp,
            timestampBuffer: 0
        });
        bytes memory data = abi.encode(payment, snapshot);
        bytes32 dataHash = keccak256(data);
        bytes32 structHash = keccak256(
            abi.encode(
                keccak256("PaymentAttestation(bytes32 intentHash,uint256 releaseAmount,bytes32 dataHash)"),
                intentHash,
                intent.amount,
                dataHash
            )
        );
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", v2Verifier.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(WITNESS_KEY, digest);
        bytes[] memory signatures = new bytes[](1);
        signatures[0] = abi.encodePacked(r, s, v);
        return abi.encode(
            UnifiedPaymentVerifier.PaymentAttestation({
                intentHash: intentHash,
                releaseAmount: intent.amount,
                dataHash: dataHash,
                signatures: signatures,
                data: data,
                metadata: ""
            })
        );
    }

    function test_RemovesLegacyRegistrationsPreservesWithdrawalAndGenericZelle() public {
        vm.recordLogs();
        assertEq(_migrate(), 9);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 removedTopic = keccak256("PaymentMethodRemoved(bytes32)");
        uint256 removalIndex;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length == 2 && logs[i].topics[0] == removedTopic) {
                address expectedEmitter = removalIndex < 3
                    ? address(registry)
                    : removalIndex < 6 ? address(legacyVerifier) : address(v2Verifier);
                assertEq(logs[i].emitter, expectedEmitter);
                ++removalIndex;
            }
        }
        assertEq(removalIndex, 9);
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            assertFalse(registry.isPaymentMethod(method));
            assertFalse(_contains(legacyVerifier.getPaymentMethods(), method));
            assertFalse(_contains(v2Verifier.getPaymentMethods(), method));
            assertEq(escrow.getDeposit(legacyDepositIds[i]).remainingDeposits, 300e6);
            vm.expectPartialRevert(IEscrowV2.PaymentMethodNotWhitelisted.selector);
            vm.prank(maker);
            escrow.createDeposit(_depositParams(method, 100e6));
            vm.expectPartialRevert(IOrchestratorV2.PaymentMethodDoesNotExist.selector);
            _submitSignal(legacyDepositIds[i], method);
        }

        uint256 beforeBalance = token.balanceOf(maker);
        vm.startPrank(maker);
        for (uint256 i; i < 3; ++i) {
            escrow.withdrawDeposit(legacyDepositIds[i]);
        }
        uint256 genericDeposit = _createDeposit(GENERIC, 300e6);
        vm.stopPrank();
        assertEq(token.balanceOf(maker) - beforeBalance, 600e6);

        bytes32 intentHash = _signal(genericDeposit, GENERIC);
        uint256 takerBefore = token.balanceOf(taker);
        orchestrator.fulfillIntent(
            IOrchestratorV2.FulfillIntentParams({
                paymentProof: _proof(intentHash), intentHash: intentHash, verificationData: "", postIntentHookData: ""
            })
        );
        assertEq(token.balanceOf(taker) - takerBefore, 50e6);
        assertEq(_migrate(), 0);
    }

    function test_QueuesExactRegistryFirstSafeOwnedRemovalBatch() public {
        assertEq(_ffiCheck("safe"), 1);
    }

    function test_DeployedStateKeepsGenericActiveAndLegacyUnsupported() public {
        _migrate();
        registry.removePaymentMethod(GENERIC);
        registry.addPaymentMethod(GENERIC, address(v3Verifier), _usd());
        v3Verifier.addPaymentMethod(GENERIC);
        for (uint256 i; i < 3; ++i) {
            bytes32 method = _legacyMethod(i);
            assertFalse(registry.isPaymentMethod(method));
            assertEq(registry.getVerifier(method), address(0));
            assertFalse(_contains(legacyVerifier.getPaymentMethods(), method));
            assertFalse(_contains(v2Verifier.getPaymentMethods(), method));
        }
        assertTrue(registry.isPaymentMethod(GENERIC));
        assertEq(registry.getVerifier(GENERIC), address(v3Verifier));
        assertTrue(_contains(v2Verifier.getPaymentMethods(), GENERIC));
    }

    function _contains(bytes32[] memory values, bytes32 expected) internal pure returns (bool) {
        for (uint256 i; i < values.length; ++i) {
            if (values[i] == expected) return true;
        }
        return false;
    }

    function _ffiCheck(string memory scenario) internal returns (uint8) {
        string[] memory command = new string[](3);
        command[0] = "node";
        command[1] = "scripts/test-zelle-removal.cjs";
        command[2] = scenario;
        bytes memory result = vm.ffi(command);
        assertEq(result.length, 1);
        return uint8(result[0]);
    }
}
