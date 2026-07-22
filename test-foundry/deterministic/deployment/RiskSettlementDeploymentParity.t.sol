// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EscrowV2} from "contracts/EscrowV2.sol";
import {OrchestratorV3} from "contracts/OrchestratorV3.sol";
import {RiskManager} from "contracts/RiskManager.sol";
import {StakeVault} from "contracts/StakeVault.sol";
import {UnifiedPaymentVerifierV3} from "contracts/unifiedVerifier/UnifiedPaymentVerifierV3.sol";
import {MultiAttestationVerifier} from "contracts/unifiedVerifier/MultiAttestationVerifier.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {BoundedCall} from "contracts/lib/BoundedCall.sol";
import {PostIntentHookExecutor} from "contracts/lib/PostIntentHookExecutor.sol";
import {RiskSettlementExecutor} from "contracts/lib/RiskSettlementExecutor.sol";
import {FeeSettlementLib} from "contracts/lib/FeeSettlementLib.sol";
import {IEscrowV2} from "contracts/interfaces/IEscrowV2.sol";
import {IAttestationVerifier} from "contracts/interfaces/IAttestationVerifier.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";
import {IOrchestratorRegistry} from "contracts/interfaces/IOrchestratorRegistry.sol";
import {IOrchestratorV3} from "contracts/interfaces/IOrchestratorV3.sol";
import {IRiskManager} from "contracts/interfaces/IRiskManager.sol";
import {IStakeVault} from "contracts/interfaces/IStakeVault.sol";

contract RiskSettlementDeploymentParityTest is Test {
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant ZELLE = keccak256("zelle");
    bytes32 internal constant USD = keccak256("USD");
    uint256 internal constant CALLBACK_GAS_LIMIT = 2_000_000;
    uint64 internal constant BASE_EXIT_DELAY = 30 days;

    address internal multisig;
    address[] internal paymentWitnesses;
    address[] internal riskWitnesses;
    USDCMock internal token;
    EscrowRegistry internal escrowRegistry;
    OrchestratorRegistry internal orchestratorRegistry;
    PaymentVerifierRegistry internal paymentRegistry;
    NullifierRegistry internal legacyNullifier;
    NullifierRegistryV2 internal nullifierV2;
    MultiAttestationVerifier internal paymentAttestationVerifier;
    MultiAttestationVerifier internal riskAttestationVerifier;
    UnifiedPaymentVerifierV3 internal paymentVerifierV3;
    EscrowV2 internal escrow;
    OrchestratorV3 internal orchestrator;
    StakeVault internal vault;
    RiskManager internal manager;

    function setUp() public {
        multisig = makeAddr("multisig");
        paymentWitnesses.push(makeAddr("paymentWitnessOne"));
        paymentWitnesses.push(makeAddr("paymentWitnessTwo"));
        riskWitnesses.push(makeAddr("riskWitnessOne"));
        riskWitnesses.push(makeAddr("riskWitnessTwo"));

        token = new USDCMock(1_000_000e6, "USD Coin", "USDC");
        escrowRegistry = new EscrowRegistry();
        orchestratorRegistry = new OrchestratorRegistry();
        paymentRegistry = new PaymentVerifierRegistry();
        legacyNullifier = new NullifierRegistry();
        nullifierV2 = new NullifierRegistryV2(INullifierRegistry(address(legacyNullifier)));
        paymentAttestationVerifier = new MultiAttestationVerifier(paymentWitnesses, 1);
        riskAttestationVerifier = new MultiAttestationVerifier(riskWitnesses, 2);
        paymentVerifierV3 = new UnifiedPaymentVerifierV3(
            IOrchestratorRegistry(address(orchestratorRegistry)),
            INullifierRegistryV2(address(nullifierV2)),
            IAttestationVerifier(address(paymentAttestationVerifier))
        );
        escrow = new EscrowV2(
            address(this),
            block.chainid,
            address(orchestratorRegistry),
            address(paymentRegistry),
            address(this),
            0,
            100,
            1 hours
        );
        orchestrator = new OrchestratorV3(
            address(this),
            block.chainid,
            address(escrowRegistry),
            address(paymentRegistry),
            0,
            address(this),
            CALLBACK_GAS_LIMIT
        );
        vault = new StakeVault(address(this), IERC20(address(token)), address(0), BASE_EXIT_DELAY, 2 days);
        manager = new RiskManager(
            address(this),
            IOrchestratorV3(address(orchestrator)),
            IStakeVault(address(vault)),
            IAttestationVerifier(address(riskAttestationVerifier)),
            INullifierRegistryV2(address(nullifierV2))
        );
        vault.initializeController(address(manager));

        bytes32[] memory currencies = new bytes32[](1);
        currencies[0] = USD;
        _routeMethod(PAYPAL, currencies);
        _routeMethod(VENMO, currencies);
        _routeMethod(ZELLE, currencies);
        nullifierV2.addWritePermission(address(paymentVerifierV3));
        orchestratorRegistry.addOrchestrator(address(orchestrator));
        escrowRegistry.addEscrow(address(escrow));

        manager.setPlatformRiskConfig(PAYPAL, _config(true, true, 10_000, 30 days, 10));
        manager.setPlatformRiskConfig(VENMO, _config(true, true, 10_000, 30 days, 10));
        manager.setPlatformRiskConfig(ZELLE, _config(false, false, 0, 0, 10));

        orchestrator.transferOwnership(multisig);
        vault.transferOwnership(multisig);
        manager.transferOwnership(multisig);
        nullifierV2.transferOwnership(multisig);
        paymentVerifierV3.transferOwnership(multisig);
        riskAttestationVerifier.transferOwnership(multisig);
    }

    function _routeMethod(bytes32 method, bytes32[] memory currencies) internal {
        paymentVerifierV3.addPaymentMethod(method);
        paymentRegistry.addPaymentMethod(method, address(paymentVerifierV3), currencies);
    }

    function _config(
        bool chargebackable,
        bool deferredPayoutEnabled,
        uint16 reserveBps,
        uint64 riskWindow,
        uint32 slope
    ) internal pure returns (IRiskManager.PlatformRiskConfig memory) {
        return IRiskManager.PlatformRiskConfig({
            enabled: true,
            chargeback: IRiskManager.ChargebackConfig({
                chargebackable: chargebackable,
                deferredPayoutEnabled: deferredPayoutEnabled,
                reserveBps: reserveBps,
                riskWindow: riskWindow
            }),
            intentExtension: IRiskManager.IntentExtensionConfig({extensionPenaltyBpsPerHour: slope})
        });
    }

    function test_DeploysCompleteLinkedBoundaryWithoutDeferredHook() public view {
        assertGt(address(orchestrator).code.length, 0);
        assertGt(address(vault).code.length, 0);
        assertGt(address(manager).code.length, 0);
        assertGt(type(BoundedCall).runtimeCode.length, 0);
        assertGt(type(PostIntentHookExecutor).runtimeCode.length, 0);
        assertGt(type(RiskSettlementExecutor).runtimeCode.length, 0);
        assertGt(type(FeeSettlementLib).runtimeCode.length, 0);
        (bool getter,) = address(manager).staticcall(abi.encodeWithSignature("deferredPayoutHook()"));
        (bool setter,) =
            address(manager).staticcall(abi.encodeWithSignature("setDeferredPayoutHook(address)", address(this)));
        assertFalse(getter);
        assertFalse(setter);
    }

    function test_RetiredDeferredHookIsExcludedFromSourceAndTypeExports() public {
        assertEq(_sourceCheck("retired"), 1);
    }

    function test_WiresCanonicalVaultAndImmutableManagerDependencies() public view {
        assertEq(vault.controller(), address(manager));
        assertEq(address(manager.orchestrator()), address(orchestrator));
        assertEq(address(manager.stakeVault()), address(vault));
        assertEq(address(manager.nullifierRegistry()), address(nullifierV2));
    }

    function test_TransfersEveryOwnedComponentToMultisig() public view {
        assertEq(orchestrator.owner(), multisig);
        assertEq(vault.owner(), multisig);
        assertEq(manager.owner(), multisig);
        assertEq(nullifierV2.owner(), multisig);
        assertEq(paymentVerifierV3.owner(), multisig);
        assertEq(riskAttestationVerifier.owner(), multisig);
    }

    function test_UsesIndependentGovernanceRatifiedRiskWitnessDomain() public view {
        assertEq(address(manager.attestationVerifier()), address(riskAttestationVerifier));
        assertEq(riskAttestationVerifier.requiredSignatures(), 2);
        assertEq(riskAttestationVerifier.witnessCount(), riskWitnesses.length);
        for (uint256 i; i < riskWitnesses.length; ++i) {
            assertTrue(riskAttestationVerifier.isWitness(riskWitnesses[i]));
            assertFalse(paymentAttestationVerifier.isWitness(riskWitnesses[i]));
        }
    }

    function test_PerformsOneWayPaymentNullifierCutover() public view {
        assertEq(address(nullifierV2.legacyNullifierRegistry()), address(legacyNullifier));
        assertTrue(nullifierV2.isWriter(address(paymentVerifierV3)));
        assertEq(legacyNullifier.getWriters().length, 0);
        bytes32[] memory methods = paymentRegistry.getPaymentMethods();
        assertGt(methods.length, 0);
        assertEq(paymentVerifierV3.getPaymentMethods(), methods);
        for (uint256 i; i < methods.length; ++i) {
            assertEq(paymentRegistry.getVerifier(methods[i]), address(paymentVerifierV3));
        }
    }

    function test_RegistersRiskManagedOrchestratorWithoutRetiredPrivileges() public view {
        assertTrue(orchestratorRegistry.isOrchestrator(address(orchestrator)));
        assertEq(orchestrator.riskCallbackGasLimit(), CALLBACK_GAS_LIMIT);
        (bool relayer,) = address(orchestrator).staticcall(abi.encodeWithSignature("relayerRegistry()"));
        (bool multiple,) = address(orchestrator).staticcall(abi.encodeWithSignature("allowMultipleIntents()"));
        assertFalse(relayer);
        assertFalse(multiple);
    }

    function test_SetsVaultExitDelayAndEscrowIntentExpiration() public view {
        assertEq(vault.baseExitDelay(), BASE_EXIT_DELAY);
        assertEq(escrow.intentExpirationPeriod(), 1 hours);
    }

    function test_ConfiguresPayPalForStakeBackedOrDeferredSettlement() public view {
        _assertReversible(PAYPAL);
    }

    function test_ConfiguresVenmoForStakeBackedOrDeferredSettlement() public view {
        _assertReversible(VENMO);
    }

    function _assertReversible(bytes32 method) internal view {
        IRiskManager.PlatformRiskConfig memory config = manager.getPlatformRiskConfig(method);
        assertTrue(config.enabled);
        assertTrue(config.chargeback.chargebackable);
        assertTrue(config.chargeback.deferredPayoutEnabled);
        assertEq(config.chargeback.reserveBps, 10_000);
        assertEq(config.chargeback.riskWindow, 30 days);
        assertEq(config.intentExtension.extensionPenaltyBpsPerHour, 10);
    }

    function test_ConfiguresPaidExtensionForNonChargebackableZelle() public view {
        IRiskManager.PlatformRiskConfig memory config = manager.getPlatformRiskConfig(ZELLE);
        assertTrue(config.enabled);
        assertFalse(config.chargeback.chargebackable);
        assertFalse(config.chargeback.deferredPayoutEnabled);
        assertEq(config.chargeback.reserveBps, 0);
        assertEq(config.intentExtension.extensionPenaltyBpsPerHour, 10);
    }

    function test_RequiresExplicitGovernanceRatifiedProductionPolicy() public {
        assertEq(_sourceCheck("policy"), 1);
    }

    function _sourceCheck(string memory scenario) internal returns (uint8) {
        string[] memory command = new string[](3);
        command[0] = "node";
        command[1] = "scripts/test-risk-deployment.cjs";
        command[2] = scenario;
        bytes memory result = vm.ffi(command);
        assertEq(result.length, 1);
        return uint8(result[0]);
    }
}
