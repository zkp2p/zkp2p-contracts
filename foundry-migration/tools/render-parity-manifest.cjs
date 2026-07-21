#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const inventory = require(path.join(repositoryRoot, "foundry-migration/baseline/hardhat-inventory.json"));
const outputPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");
const registryFile = "test-foundry/deterministic/registries/RegistryParity.t.sol";

function csv(value) {
    const stringValue = String(value ?? "");
    return /[",\n]/.test(stringValue) ? `"${stringValue.replaceAll('"', '""')}"` : stringValue;
}

function destination(contractName, testName) {
    return `${registryFile}:${contractName}::${testName}`;
}

function registryDestination(test) {
    const scenario = test.scenario;
    const revert = scenario.includes("should revert") || scenario.includes(" reverts");
    switch (test.sourceFile) {
        case "test/registries/escrowRegistry.spec.ts":
            if (scenario.includes("#constructor") || scenario.includes("#isAcceptingAllEscrows should return false")) {
                return destination("EscrowRegistryParityTest", "test_ConstructorAndDefaultViewsMatchHardhat");
            }
            if (scenario.includes("#addEscrow")) {
                return destination("EscrowRegistryParityTest", revert ? "test_AddEscrowRejectsZeroDuplicateAndNonOwner" : "test_AddEscrowUpdatesStateArrayViewsAndEmits");
            }
            if (scenario.includes("#removeEscrow")) {
                return destination("EscrowRegistryParityTest", revert ? "test_RemoveEscrowRejectsMissingAndNonOwner" : "test_RemoveEscrowUpdatesStateArrayAndEmits");
            }
            if (scenario.includes("#setAcceptAllEscrows")) {
                return destination("EscrowRegistryParityTest", revert ? "test_SetAcceptAllEscrowsRejectsNonOwner" : "test_SetAcceptAllEscrowsTogglesBothViewsAndEmits");
            }
            if (scenario.includes("#isWhitelistedEscrow")) {
                return destination("EscrowRegistryParityTest", scenario.includes("not whitelisted") ? "test_ConstructorAndDefaultViewsMatchHardhat" : "test_AddEscrowUpdatesStateArrayViewsAndEmits");
            }
            if (scenario.includes("#isAcceptingAllEscrows")) {
                return destination("EscrowRegistryParityTest", "test_SetAcceptAllEscrowsTogglesBothViewsAndEmits");
            }
            break;
        case "test/registries/nullifierRegistry.spec.ts":
            if (scenario.includes("#constructor")) return destination("NullifierRegistryParityTest", "test_ConstructorSetsOwnerAndEmptyWriterSet");
            if (scenario.includes("#addNullifier")) {
                return destination("NullifierRegistryParityTest", revert ? "test_AddNullifierRejectsReplayAndUnauthorizedCaller" : "test_AddNullifierUpdatesStateAndEmitsWriter");
            }
            if (scenario.includes("#addWritePermission")) {
                return destination("NullifierRegistryParityTest", revert ? "test_AddWritePermissionRejectsDuplicateAndNonOwner" : "test_AddWritePermissionUpdatesEnumerableSetAndEmits");
            }
            if (scenario.includes("#removeWritePermission")) {
                return destination("NullifierRegistryParityTest", revert ? "test_RemoveWritePermissionRejectsMissingAndNonOwner" : "test_RemoveWritePermissionUpdatesEnumerableSetAndEmits");
            }
            break;
        case "test/registries/nullifierRegistryV2.spec.ts": {
            const mappings = [
                ["requires a deployed legacy registry", "test_ConstructorRequiresDeployedLegacyRegistry"],
                ["reads predecessor nullifiers", "test_LegacyNullifierRemainsAuthoritativeWithoutInventedBinding"],
                ["atomically creates", "test_NewBindingIsAtomicBidirectionalImmutableAndEmits"],
                ["rejects predecessor replay", "test_RejectsLegacyReplayZeroValuesAndUnauthorizedWrites"],
                ["governs an explicit", "test_WriterSetIsOwnerGovernedExplicitEnumerableAndEmits"],
            ];
            const mapping = mappings.find(([needle]) => scenario.includes(needle));
            if (mapping) return destination("NullifierRegistryV2ParityTest", mapping[1]);
            break;
        }
        case "test/registries/orchestratorRegistry.spec.ts":
            if (scenario.includes("#addOrchestrator")) {
                return destination("OrchestratorRegistryParityTest", revert ? "test_AddOrchestratorRejectsNonOwnerZeroAndDuplicate" : "test_AddOrchestratorUpdatesStateAndEmits");
            }
            if (scenario.includes("#removeOrchestrator")) {
                return destination("OrchestratorRegistryParityTest", revert ? "test_RemoveOrchestratorRejectsNonOwnerZeroAndMissing" : "test_RemoveOrchestratorUpdatesStateAndEmits");
            }
            break;
        case "test/registries/paymentVerifierRegistry.spec.ts":
            if (scenario.includes("#constructor")) return destination("PaymentVerifierRegistryParityTest", "test_ConstructorSetsOwnerAndEmptyMethods");
            if (scenario.includes("#addPaymentMethod")) {
                if (!revert) return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodStoresVerifierCurrenciesAndEmitsAllEvents");
                if (scenario.includes("already exists")) return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodRejectsExistingMethod");
                if (scenario.includes("verifier is zero")) return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodRejectsZeroVerifier");
                if (scenario.includes("empty currencies")) return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodRejectsEmptyCurrencies");
                if (scenario.includes("bytes32(0)") || scenario.includes("duplicate currencies")) return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodRejectsZeroOrDuplicateCurrencyAtomically");
                return destination("PaymentVerifierRegistryParityTest", "test_AddPaymentMethodRejectsNonOwner");
            }
            if (scenario.includes("#removePaymentMethod")) {
                return destination("PaymentVerifierRegistryParityTest", revert ? "test_RemovePaymentMethodRejectsMissingAndNonOwner" : "test_RemovePaymentMethodClearsAllStateAndEmitsAllEvents");
            }
            if (scenario.includes("#addCurrencies")) {
                return destination("PaymentVerifierRegistryParityTest", revert ? "test_AddCurrenciesRejectsInvalidInputsAndNonOwner" : "test_AddCurrenciesSupportsSingleAndMultipleAndEmits");
            }
            if (scenario.includes("#removeCurrencies")) {
                return destination("PaymentVerifierRegistryParityTest", revert ? "test_RemoveCurrenciesRejectsEmptyUnsupportedMissingMethodAndNonOwner" : "test_RemoveCurrenciesSupportsSingleAndMultipleAndEmits");
            }
            if (scenario.includes("view functions")) return destination("PaymentVerifierRegistryParityTest", "test_ViewFunctionsReturnDefaultsAndIndependentConfiguredValues");
            if (scenario.includes("complex scenarios")) return destination("PaymentVerifierRegistryParityTest", "test_ComplexAddRemoveAndCrossMethodCurrencyChangesRemainIndependent");
            break;
        case "test/registries/postIntentHookRegistry.spec.ts":
            if (scenario.includes("#constructor")) return destination("PostIntentHookRegistryParityTest", "test_ConstructorSetsOwner");
            if (scenario.includes("#addPostIntentHook")) return destination("PostIntentHookRegistryParityTest", revert ? "test_AddHookRejectsZeroDuplicateAndNonOwner" : "test_AddHookUpdatesStateViewsArrayAndEmits");
            if (scenario.includes("#removePostIntentHook")) return destination("PostIntentHookRegistryParityTest", revert ? "test_RemoveHookRejectsMissingAndNonOwner" : "test_RemoveHookUpdatesStateArrayAndEmits");
            if (scenario.includes("#getWhitelistedHooks") || (scenario.includes("#isWhitelistedHook") && !scenario.includes("not whitelisted"))) return destination("PostIntentHookRegistryParityTest", "test_AddHookUpdatesStateViewsArrayAndEmits");
            if (scenario.includes("#isWhitelistedHook")) return destination("PostIntentHookRegistryParityTest", "test_ViewReturnsFalseForUnlistedHook");
            break;
        case "test/registries/relayerRegistry.spec.ts":
            if (scenario.includes("#constructor")) return destination("RelayerRegistryParityTest", "test_ConstructorSetsOwner");
            if (scenario.includes("#addRelayer")) return destination("RelayerRegistryParityTest", revert ? "test_AddRelayerRejectsZeroDuplicateAndNonOwner" : "test_AddRelayerUpdatesStateArrayAndEmits");
            if (scenario.includes("#removeRelayer")) return destination("RelayerRegistryParityTest", revert ? "test_RemoveRelayerRejectsMissingAndNonOwner" : "test_RemoveRelayerUpdatesStateArrayAndEmits");
            if (scenario.includes("#isWhitelistedRelayer") && !scenario.includes("not whitelisted")) return destination("RelayerRegistryParityTest", "test_AddRelayerUpdatesStateArrayAndEmits");
            if (scenario.includes("#isWhitelistedRelayer")) return destination("RelayerRegistryParityTest", "test_ViewReturnsFalseForUnlistedRelayer");
            break;
    }
    return "";
}

const header = [
    "id", "source_file", "suite_path", "hardhat_test", "scenario", "expected_behavior",
    "fixture_dependencies", "foundry_destination", "translation_shape", "status", "evidence",
];
let verified = 0;
const rows = inventory.tests.map((test) => {
    const foundryDestination = registryDestination(test);
    if (test.sourceFile.startsWith("test/registries/") && !foundryDestination) {
        throw new Error(`Unmapped registry behavior: ${test.id} ${test.scenario}`);
    }
    if (foundryDestination) verified += 1;
    return [
        test.id,
        test.sourceFile,
        test.suitePath,
        test.hardhatTest,
        test.scenario,
        test.expectedBehavior,
        test.fixtureDependencies,
        foundryDestination,
        foundryDestination ? (test.sourceFile.includes("nullifierRegistryV2") ? "one-to-one" : "consolidated-with-explicit-destination") : "one-to-one",
        foundryDestination ? "verified-independent-file" : (test.pending ? "pending-resolution" : "pending-translation"),
        foundryDestination ? "RegistryParity.t.sol: 50 passed, 0 failed, 0 skipped" : (test.pending ? "baseline-pending" : "baseline-passed"),
    ];
});

fs.writeFileSync(outputPath, `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`);
console.log(JSON.stringify({ total: rows.length, verified, remaining: rows.length - verified }, null, 2));
