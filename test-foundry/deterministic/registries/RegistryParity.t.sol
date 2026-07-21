// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {EscrowRegistry} from "contracts/registries/EscrowRegistry.sol";
import {NullifierRegistry} from "contracts/registries/NullifierRegistry.sol";
import {NullifierRegistryV2} from "contracts/registries/NullifierRegistryV2.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {PaymentVerifierRegistry} from "contracts/registries/PaymentVerifierRegistry.sol";
import {PostIntentHookRegistry} from "contracts/registries/PostIntentHookRegistry.sol";
import {RelayerRegistry} from "contracts/registries/RelayerRegistry.sol";
import {INullifierRegistry} from "contracts/interfaces/INullifierRegistry.sol";
import {INullifierRegistryV2} from "contracts/interfaces/INullifierRegistryV2.sol";

abstract contract RegistryParityBase is Test {
    address internal owner;
    address internal caller;
    address internal first;
    address internal second;

    function setUp() public virtual {
        owner = address(this);
        caller = makeAddr("caller");
        first = makeAddr("first");
        second = makeAddr("second");
    }

    function _expectOwnableRevert(address unauthorized) internal {
        vm.prank(unauthorized);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
    }
}

contract EscrowRegistryParityTest is RegistryParityBase {
    event EscrowAdded(address indexed escrow);
    event EscrowRemoved(address indexed escrow);
    event AcceptAllEscrowsUpdated(bool acceptAll);

    EscrowRegistry internal registry;

    function setUp() public override {
        super.setUp();
        registry = new EscrowRegistry();
    }

    function test_ConstructorAndDefaultViewsMatchHardhat() public view {
        assertEq(registry.owner(), owner);
        assertFalse(registry.acceptAllEscrows());
        assertFalse(registry.isAcceptingAllEscrows());
        assertEq(registry.getWhitelistedEscrows().length, 0);
    }

    function test_AddEscrowUpdatesStateArrayViewsAndEmits() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit EscrowAdded(first);
        registry.addEscrow(first);

        assertTrue(registry.isWhitelistedEscrow(first));
        address[] memory expected = new address[](1);
        expected[0] = first;
        assertEq(registry.getWhitelistedEscrows(), expected);
    }

    function test_AddEscrowRejectsZeroDuplicateAndNonOwner() public {
        vm.expectRevert(bytes("Escrow cannot be zero address"));
        registry.addEscrow(address(0));

        registry.addEscrow(first);
        vm.expectRevert(bytes("Escrow already whitelisted"));
        registry.addEscrow(first);

        _expectOwnableRevert(caller);
        registry.addEscrow(second);
    }

    function test_RemoveEscrowUpdatesStateArrayAndEmits() public {
        registry.addEscrow(first);
        registry.addEscrow(second);

        vm.expectEmit(true, false, false, true, address(registry));
        emit EscrowRemoved(first);
        registry.removeEscrow(first);

        assertFalse(registry.isWhitelistedEscrow(first));
        address[] memory expected = new address[](1);
        expected[0] = second;
        assertEq(registry.getWhitelistedEscrows(), expected);
    }

    function test_RemoveEscrowRejectsMissingAndNonOwner() public {
        vm.expectRevert(bytes("Escrow not whitelisted"));
        registry.removeEscrow(first);

        registry.addEscrow(first);
        _expectOwnableRevert(caller);
        registry.removeEscrow(first);
    }

    function test_SetAcceptAllEscrowsTogglesBothViewsAndEmits() public {
        vm.expectEmit(false, false, false, true, address(registry));
        emit AcceptAllEscrowsUpdated(true);
        registry.setAcceptAllEscrows(true);
        assertTrue(registry.acceptAllEscrows());
        assertTrue(registry.isAcceptingAllEscrows());

        vm.expectEmit(false, false, false, true, address(registry));
        emit AcceptAllEscrowsUpdated(false);
        registry.setAcceptAllEscrows(false);
        assertFalse(registry.acceptAllEscrows());
        assertFalse(registry.isAcceptingAllEscrows());
    }

    function test_SetAcceptAllEscrowsRejectsNonOwner() public {
        _expectOwnableRevert(caller);
        registry.setAcceptAllEscrows(true);
    }
}

contract NullifierRegistryParityTest is RegistryParityBase {
    event NullifierAdded(bytes32 nullifier, address indexed writer);
    event WriterAdded(address writer);
    event WriterRemoved(address writer);

    NullifierRegistry internal registry;
    bytes32 internal constant NULLIFIER = keccak256("payment");

    function setUp() public override {
        super.setUp();
        registry = new NullifierRegistry();
    }

    function test_ConstructorSetsOwnerAndEmptyWriterSet() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.getWriters().length, 0);
    }

    function test_AddWritePermissionUpdatesEnumerableSetAndEmits() public {
        vm.expectEmit(false, false, false, true, address(registry));
        emit WriterAdded(first);
        registry.addWritePermission(first);
        assertTrue(registry.isWriter(first));
        address[] memory expected = new address[](1);
        expected[0] = first;
        assertEq(registry.getWriters(), expected);
    }

    function test_AddWritePermissionRejectsDuplicateAndNonOwner() public {
        registry.addWritePermission(first);
        vm.expectRevert(bytes("Address is already a writer"));
        registry.addWritePermission(first);

        _expectOwnableRevert(caller);
        registry.addWritePermission(second);
    }

    function test_AddNullifierUpdatesStateAndEmitsWriter() public {
        registry.addWritePermission(first);
        vm.prank(first);
        vm.expectEmit(false, true, false, true, address(registry));
        emit NullifierAdded(NULLIFIER, first);
        registry.addNullifier(NULLIFIER);
        assertTrue(registry.isNullified(NULLIFIER));
    }

    function test_AddNullifierRejectsReplayAndUnauthorizedCaller() public {
        registry.addWritePermission(first);
        vm.prank(first);
        registry.addNullifier(NULLIFIER);

        vm.prank(first);
        vm.expectRevert(bytes("Nullifier already exists"));
        registry.addNullifier(NULLIFIER);

        vm.prank(caller);
        vm.expectRevert(bytes("Only addresses with write permissions can call"));
        registry.addNullifier(keccak256("other"));
    }

    function test_RemoveWritePermissionUpdatesEnumerableSetAndEmits() public {
        registry.addWritePermission(first);
        registry.addWritePermission(second);
        vm.expectEmit(false, false, false, true, address(registry));
        emit WriterRemoved(first);
        registry.removeWritePermission(first);
        assertFalse(registry.isWriter(first));
        address[] memory expected = new address[](1);
        expected[0] = second;
        assertEq(registry.getWriters(), expected);
    }

    function test_RemoveWritePermissionRejectsMissingAndNonOwner() public {
        vm.expectRevert(bytes("Address is not a writer"));
        registry.removeWritePermission(first);

        registry.addWritePermission(first);
        _expectOwnableRevert(caller);
        registry.removeWritePermission(first);
    }
}

contract NullifierRegistryV2ParityTest is RegistryParityBase {
    event NullifierAdded(bytes32 indexed nullifier, bytes32 indexed intentHash, address indexed writer);
    event WriterAdded(address indexed writer);
    event WriterRemoved(address indexed writer);

    NullifierRegistry internal legacyRegistry;
    NullifierRegistryV2 internal registry;

    function setUp() public override {
        super.setUp();
        legacyRegistry = new NullifierRegistry();
        registry = new NullifierRegistryV2(INullifierRegistry(address(legacyRegistry)));
    }

    function test_ConstructorRequiresDeployedLegacyRegistry() public {
        vm.expectRevert(INullifierRegistryV2.ZeroAddress.selector);
        new NullifierRegistryV2(INullifierRegistry(address(0)));
        vm.expectRevert(INullifierRegistryV2.ZeroAddress.selector);
        new NullifierRegistryV2(INullifierRegistry(first));
    }

    function test_LegacyNullifierRemainsAuthoritativeWithoutInventedBinding() public {
        bytes32 nullifier = keccak256("legacy-payment");
        legacyRegistry.addWritePermission(owner);
        legacyRegistry.addNullifier(nullifier);

        assertEq(address(registry.legacyNullifierRegistry()), address(legacyRegistry));
        assertTrue(registry.isNullified(nullifier));
        assertEq(registry.intentHashByNullifier(nullifier), bytes32(0));
        assertEq(registry.nullifierByIntentHash(keccak256("intent")), bytes32(0));
    }

    function test_NewBindingIsAtomicBidirectionalImmutableAndEmits() public {
        bytes32 nullifier = keccak256("new-payment");
        bytes32 intentHash = keccak256("new-intent");
        registry.addWritePermission(first);

        vm.prank(first);
        vm.expectEmit(true, true, true, true, address(registry));
        emit NullifierAdded(nullifier, intentHash, first);
        registry.addNullifier(nullifier, intentHash);

        assertTrue(registry.isNullified(nullifier));
        assertEq(registry.intentHashByNullifier(nullifier), intentHash);
        assertEq(registry.nullifierByIntentHash(intentHash), nullifier);

        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.NullifierAlreadyExists.selector, nullifier));
        registry.addNullifier(nullifier, keccak256("other-intent"));

        bytes32 otherNullifier = keccak256("other-payment");
        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.IntentAlreadyBound.selector, intentHash, nullifier));
        registry.addNullifier(otherNullifier, intentHash);
    }

    function test_RejectsLegacyReplayZeroValuesAndUnauthorizedWrites() public {
        bytes32 legacyNullifier = keccak256("legacy-replay");
        legacyRegistry.addWritePermission(owner);
        legacyRegistry.addNullifier(legacyNullifier);
        registry.addWritePermission(first);

        vm.prank(second);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.UnauthorizedWriter.selector, second));
        registry.addNullifier(keccak256("x"), keccak256("y"));

        vm.prank(first);
        vm.expectRevert(INullifierRegistryV2.ZeroNullifier.selector);
        registry.addNullifier(bytes32(0), keccak256("y"));

        vm.prank(first);
        vm.expectRevert(INullifierRegistryV2.ZeroIntentHash.selector);
        registry.addNullifier(keccak256("x"), bytes32(0));

        vm.prank(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.NullifierAlreadyExists.selector, legacyNullifier));
        registry.addNullifier(legacyNullifier, keccak256("y"));
    }

    function test_WriterSetIsOwnerGovernedExplicitEnumerableAndEmits() public {
        _expectOwnableRevert(second);
        registry.addWritePermission(first);

        vm.expectRevert(INullifierRegistryV2.ZeroAddress.selector);
        registry.addWritePermission(address(0));

        vm.expectEmit(true, false, false, true, address(registry));
        emit WriterAdded(first);
        registry.addWritePermission(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.WriterAlreadyAuthorized.selector, first));
        registry.addWritePermission(first);

        registry.addWritePermission(owner);
        address[] memory expected = new address[](2);
        expected[0] = first;
        expected[1] = owner;
        assertEq(registry.getWriters(), expected);

        _expectOwnableRevert(second);
        registry.removeWritePermission(first);
        vm.expectRevert(abi.encodeWithSelector(INullifierRegistryV2.WriterNotAuthorized.selector, second));
        registry.removeWritePermission(second);

        vm.expectEmit(true, false, false, true, address(registry));
        emit WriterRemoved(first);
        registry.removeWritePermission(first);
        expected = new address[](1);
        expected[0] = owner;
        assertEq(registry.getWriters(), expected);
        assertFalse(registry.isWriter(first));
    }
}

contract OrchestratorRegistryParityTest is RegistryParityBase {
    event OrchestratorAdded(address indexed orchestrator);
    event OrchestratorRemoved(address indexed orchestrator);

    OrchestratorRegistry internal registry;

    function setUp() public override {
        super.setUp();
        registry = new OrchestratorRegistry();
    }

    function test_AddOrchestratorUpdatesStateAndEmits() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit OrchestratorAdded(first);
        registry.addOrchestrator(first);
        assertTrue(registry.isOrchestrator(first));
    }

    function test_AddOrchestratorRejectsNonOwnerZeroAndDuplicate() public {
        _expectOwnableRevert(caller);
        registry.addOrchestrator(first);
        vm.expectRevert(OrchestratorRegistry.ZeroAddress.selector);
        registry.addOrchestrator(address(0));
        registry.addOrchestrator(first);
        vm.expectRevert(abi.encodeWithSelector(OrchestratorRegistry.OrchestratorAlreadyAdded.selector, first));
        registry.addOrchestrator(first);
    }

    function test_RemoveOrchestratorUpdatesStateAndEmits() public {
        registry.addOrchestrator(first);
        vm.expectEmit(true, false, false, true, address(registry));
        emit OrchestratorRemoved(first);
        registry.removeOrchestrator(first);
        assertFalse(registry.isOrchestrator(first));
    }

    function test_RemoveOrchestratorRejectsNonOwnerZeroAndMissing() public {
        registry.addOrchestrator(first);
        _expectOwnableRevert(caller);
        registry.removeOrchestrator(first);
        vm.expectRevert(OrchestratorRegistry.ZeroAddress.selector);
        registry.removeOrchestrator(address(0));
        registry.removeOrchestrator(first);
        vm.expectRevert(abi.encodeWithSelector(OrchestratorRegistry.OrchestratorNotFound.selector, first));
        registry.removeOrchestrator(first);
    }
}

contract PaymentVerifierRegistryParityTest is RegistryParityBase {
    event PaymentMethodAdded(bytes32 indexed paymentMethod);
    event PaymentMethodRemoved(bytes32 indexed paymentMethod);
    event CurrencyAdded(bytes32 indexed paymentMethod, bytes32 indexed currencyCode);
    event CurrencyRemoved(bytes32 indexed paymentMethod, bytes32 indexed currencyCode);

    PaymentVerifierRegistry internal registry;
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant PAYPAL = keccak256("paypal");
    bytes32 internal constant WISE = keccak256("wise");
    bytes32 internal constant USD = keccak256("USD");
    bytes32 internal constant EUR = keccak256("EUR");
    bytes32 internal constant GBP = keccak256("GBP");

    function setUp() public override {
        super.setUp();
        registry = new PaymentVerifierRegistry();
    }

    function _one(bytes32 value) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](1);
        values[0] = value;
    }

    function _two(bytes32 firstValue, bytes32 secondValue) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](2);
        values[0] = firstValue;
        values[1] = secondValue;
    }

    function _three(bytes32 a, bytes32 b, bytes32 c) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](3);
        values[0] = a;
        values[1] = b;
        values[2] = c;
    }

    function _addVenmo() internal {
        registry.addPaymentMethod(VENMO, first, _two(USD, EUR));
    }

    function test_ConstructorSetsOwnerAndEmptyMethods() public view {
        assertEq(registry.owner(), owner);
        assertEq(registry.getPaymentMethods().length, 0);
    }

    function test_AddPaymentMethodStoresVerifierCurrenciesAndEmitsAllEvents() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyAdded(VENMO, USD);
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyAdded(VENMO, EUR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit PaymentMethodAdded(VENMO);
        _addVenmo();

        assertTrue(registry.isPaymentMethod(VENMO));
        assertEq(registry.getVerifier(VENMO), first);
        assertEq(registry.getPaymentMethods(), _one(VENMO));
        assertEq(registry.getCurrencies(VENMO), _two(USD, EUR));
        assertTrue(registry.isCurrency(VENMO, USD));
        assertTrue(registry.isCurrency(VENMO, EUR));
    }

    function test_AddPaymentMethodRejectsExistingMethod() public {
        _addVenmo();
        vm.expectRevert(bytes("Payment method already exists"));
        registry.addPaymentMethod(VENMO, second, _one(GBP));
    }

    function test_AddPaymentMethodRejectsZeroVerifier() public {
        vm.expectRevert(bytes("Invalid verifier"));
        registry.addPaymentMethod(VENMO, address(0), _one(USD));
    }

    function test_AddPaymentMethodRejectsEmptyCurrencies() public {
        vm.expectRevert(bytes("Invalid currencies length"));
        registry.addPaymentMethod(VENMO, first, new bytes32[](0));
    }

    function test_AddPaymentMethodRejectsZeroOrDuplicateCurrencyAtomically() public {
        vm.expectRevert(bytes("Invalid currency code"));
        registry.addPaymentMethod(VENMO, first, _two(USD, bytes32(0)));
        assertFalse(registry.isPaymentMethod(VENMO));

        vm.expectRevert(bytes("Currency already exists"));
        registry.addPaymentMethod(VENMO, first, _two(USD, USD));
        assertFalse(registry.isPaymentMethod(VENMO));
    }

    function test_AddPaymentMethodRejectsNonOwner() public {
        _expectOwnableRevert(caller);
        registry.addPaymentMethod(VENMO, first, _one(USD));
    }

    function test_RemovePaymentMethodClearsAllStateAndEmitsAllEvents() public {
        _addVenmo();
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyRemoved(VENMO, USD);
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyRemoved(VENMO, EUR);
        vm.expectEmit(true, false, false, true, address(registry));
        emit PaymentMethodRemoved(VENMO);
        registry.removePaymentMethod(VENMO);

        assertFalse(registry.isPaymentMethod(VENMO));
        assertEq(registry.getVerifier(VENMO), address(0));
        assertEq(registry.getCurrencies(VENMO).length, 0);
        assertEq(registry.getPaymentMethods().length, 0);
        assertFalse(registry.isCurrency(VENMO, USD));
        assertFalse(registry.isCurrency(VENMO, EUR));
    }

    function test_RemovePaymentMethodRejectsMissingAndNonOwner() public {
        vm.expectRevert(bytes("Payment method does not exist"));
        registry.removePaymentMethod(VENMO);
        _addVenmo();
        _expectOwnableRevert(caller);
        registry.removePaymentMethod(VENMO);
    }

    function test_AddCurrenciesSupportsSingleAndMultipleAndEmits() public {
        registry.addPaymentMethod(VENMO, first, _one(USD));
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyAdded(VENMO, EUR);
        registry.addCurrencies(VENMO, _one(EUR));
        assertEq(registry.getCurrencies(VENMO), _two(USD, EUR));

        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyAdded(VENMO, GBP);
        bytes32 jpy = keccak256("JPY");
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyAdded(VENMO, jpy);
        registry.addCurrencies(VENMO, _two(GBP, jpy));
        assertEq(registry.getCurrencies(VENMO), _threePlusOne(USD, EUR, GBP, jpy));
    }

    function _threePlusOne(bytes32 a, bytes32 b, bytes32 c, bytes32 d) internal pure returns (bytes32[] memory values) {
        values = new bytes32[](4);
        values[0] = a;
        values[1] = b;
        values[2] = c;
        values[3] = d;
    }

    function test_AddCurrenciesRejectsInvalidInputsAndNonOwner() public {
        vm.expectRevert(bytes("Payment method does not exist"));
        registry.addCurrencies(VENMO, _one(USD));
        _addVenmo();
        vm.expectRevert(bytes("Invalid currencies length"));
        registry.addCurrencies(VENMO, new bytes32[](0));
        vm.expectRevert(bytes("Invalid currency code"));
        registry.addCurrencies(VENMO, _one(bytes32(0)));
        vm.expectRevert(bytes("Currency already exists"));
        registry.addCurrencies(VENMO, _one(USD));
        _expectOwnableRevert(caller);
        registry.addCurrencies(VENMO, _one(GBP));
    }

    function test_RemoveCurrenciesSupportsSingleAndMultipleAndEmits() public {
        registry.addPaymentMethod(VENMO, first, _three(USD, EUR, GBP));
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyRemoved(VENMO, EUR);
        registry.removeCurrencies(VENMO, _one(EUR));
        assertEq(registry.getCurrencies(VENMO), _two(USD, GBP));

        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyRemoved(VENMO, USD);
        vm.expectEmit(true, true, false, true, address(registry));
        emit CurrencyRemoved(VENMO, GBP);
        registry.removeCurrencies(VENMO, _two(USD, GBP));
        assertEq(registry.getCurrencies(VENMO).length, 0);
    }

    function test_RemoveCurrenciesRejectsEmptyUnsupportedMissingMethodAndNonOwner() public {
        vm.expectRevert(bytes("Invalid currencies length"));
        registry.removeCurrencies(VENMO, new bytes32[](0));
        vm.expectRevert(bytes("Currency does not exist"));
        registry.removeCurrencies(VENMO, _one(USD));

        _addVenmo();
        vm.expectRevert(bytes("Currency does not exist"));
        registry.removeCurrencies(VENMO, _one(GBP));
        _expectOwnableRevert(caller);
        registry.removeCurrencies(VENMO, _one(USD));
    }

    function test_ViewFunctionsReturnDefaultsAndIndependentConfiguredValues() public {
        assertFalse(registry.isPaymentMethod(VENMO));
        assertEq(registry.getVerifier(VENMO), address(0));
        assertFalse(registry.isCurrency(VENMO, USD));
        assertEq(registry.getCurrencies(VENMO).length, 0);

        registry.addPaymentMethod(VENMO, first, _two(USD, EUR));
        registry.addPaymentMethod(PAYPAL, second, _one(USD));
        registry.addPaymentMethod(WISE, caller, _two(EUR, GBP));
        assertEq(registry.getPaymentMethods(), _three(VENMO, PAYPAL, WISE));
        assertEq(registry.getVerifier(VENMO), first);
        assertEq(registry.getVerifier(PAYPAL), second);
        assertEq(registry.getVerifier(WISE), caller);
        assertEq(registry.getCurrencies(VENMO), _two(USD, EUR));
        assertEq(registry.getCurrencies(PAYPAL), _one(USD));
        assertEq(registry.getCurrencies(WISE), _two(EUR, GBP));
        assertFalse(registry.isCurrency(PAYPAL, EUR));
    }

    function test_ComplexAddRemoveAndCrossMethodCurrencyChangesRemainIndependent() public {
        registry.addPaymentMethod(VENMO, first, _two(USD, EUR));
        registry.addPaymentMethod(PAYPAL, second, _one(USD));
        registry.addPaymentMethod(WISE, caller, _two(EUR, GBP));
        registry.removePaymentMethod(PAYPAL);
        assertEq(registry.getPaymentMethods(), _two(VENMO, WISE));
        assertTrue(registry.isPaymentMethod(VENMO));
        assertFalse(registry.isPaymentMethod(PAYPAL));
        assertTrue(registry.isPaymentMethod(WISE));

        registry.removeCurrencies(VENMO, _one(EUR));
        registry.addCurrencies(WISE, _one(USD));
        assertEq(registry.getCurrencies(VENMO), _one(USD));
        assertEq(registry.getCurrencies(WISE), _three(EUR, GBP, USD));
        assertFalse(registry.isCurrency(VENMO, EUR));
        assertTrue(registry.isCurrency(WISE, EUR));
        assertTrue(registry.isCurrency(WISE, USD));
    }
}

contract PostIntentHookRegistryParityTest is RegistryParityBase {
    event PostIntentHookAdded(address indexed hook);
    event PostIntentHookRemoved(address indexed hook);

    PostIntentHookRegistry internal registry;

    function setUp() public override {
        super.setUp();
        registry = new PostIntentHookRegistry();
    }

    function test_ConstructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_AddHookUpdatesStateViewsArrayAndEmits() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit PostIntentHookAdded(first);
        registry.addPostIntentHook(first);
        assertTrue(registry.whitelistedHooks(first));
        assertTrue(registry.isWhitelistedHook(first));
        address[] memory expected = new address[](1);
        expected[0] = first;
        assertEq(registry.getWhitelistedHooks(), expected);
    }

    function test_AddHookRejectsZeroDuplicateAndNonOwner() public {
        vm.expectRevert(bytes("Hook cannot be zero address"));
        registry.addPostIntentHook(address(0));
        registry.addPostIntentHook(first);
        vm.expectRevert(bytes("Hook already whitelisted"));
        registry.addPostIntentHook(first);
        _expectOwnableRevert(caller);
        registry.addPostIntentHook(second);
    }

    function test_RemoveHookUpdatesStateArrayAndEmits() public {
        registry.addPostIntentHook(first);
        registry.addPostIntentHook(second);
        vm.expectEmit(true, false, false, true, address(registry));
        emit PostIntentHookRemoved(first);
        registry.removePostIntentHook(first);
        assertFalse(registry.whitelistedHooks(first));
        assertFalse(registry.isWhitelistedHook(first));
        address[] memory expected = new address[](1);
        expected[0] = second;
        assertEq(registry.getWhitelistedHooks(), expected);
    }

    function test_RemoveHookRejectsMissingAndNonOwner() public {
        vm.expectRevert(bytes("Hook not whitelisted"));
        registry.removePostIntentHook(first);
        registry.addPostIntentHook(first);
        _expectOwnableRevert(caller);
        registry.removePostIntentHook(first);
    }

    function test_ViewReturnsFalseForUnlistedHook() public view {
        assertFalse(registry.isWhitelistedHook(first));
    }
}

contract RelayerRegistryParityTest is RegistryParityBase {
    event RelayerAdded(address indexed relayer);
    event RelayerRemoved(address indexed relayer);

    RelayerRegistry internal registry;

    function setUp() public override {
        super.setUp();
        registry = new RelayerRegistry();
    }

    function test_ConstructorSetsOwner() public view {
        assertEq(registry.owner(), owner);
    }

    function test_AddRelayerUpdatesStateArrayAndEmits() public {
        vm.expectEmit(true, false, false, true, address(registry));
        emit RelayerAdded(first);
        registry.addRelayer(first);
        assertTrue(registry.isWhitelistedRelayer(first));
        address[] memory expected = new address[](1);
        expected[0] = first;
        assertEq(registry.getWhitelistedRelayers(), expected);
    }

    function test_AddRelayerRejectsZeroDuplicateAndNonOwner() public {
        vm.expectRevert(bytes("Relayer cannot be zero address"));
        registry.addRelayer(address(0));
        registry.addRelayer(first);
        vm.expectRevert(bytes("Relayer already whitelisted"));
        registry.addRelayer(first);
        _expectOwnableRevert(caller);
        registry.addRelayer(second);
    }

    function test_RemoveRelayerUpdatesStateArrayAndEmits() public {
        registry.addRelayer(first);
        registry.addRelayer(second);
        vm.expectEmit(true, false, false, true, address(registry));
        emit RelayerRemoved(first);
        registry.removeRelayer(first);
        assertFalse(registry.isWhitelistedRelayer(first));
        address[] memory expected = new address[](1);
        expected[0] = second;
        assertEq(registry.getWhitelistedRelayers(), expected);
    }

    function test_RemoveRelayerRejectsMissingAndNonOwner() public {
        vm.expectRevert(bytes("Relayer not whitelisted"));
        registry.removeRelayer(first);
        registry.addRelayer(first);
        _expectOwnableRevert(caller);
        registry.removeRelayer(first);
    }

    function test_ViewReturnsFalseForUnlistedRelayer() public view {
        assertFalse(registry.isWhitelistedRelayer(first));
    }
}
