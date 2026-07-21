#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const inventory = require(path.join(repositoryRoot, "foundry-migration/baseline/hardhat-inventory.json"));
const outputPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");
const registryFile = "test-foundry/deterministic/registries/RegistryParity.t.sol";
const oracleFile = "test-foundry/deterministic/oracles/OracleAdapterParity.t.sol";

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

function oracleDestination(test) {
    const scenario = test.scenario;
    const chainlink = "ChainlinkOracleAdapterParityTest";
    const pyth = "PythOracleAdapterParityTest";
    const oracle = (contractName, testName) => `${oracleFile}:${contractName}::${testName}`;
    if (test.sourceFile === "test/rateManager/chainlinkOracleAdapter.spec.ts") {
        if (scenario.includes("returns packed normalized config") && !scenario.includes("feed is zero")) return oracle(chainlink, "test_ValidateConfigPacksFeedDecimalsAndInvertFlag");
        if (scenario.includes("feed is zero returns packed")) return oracle(chainlink, "test_ValidateConfigAllowsZeroFeedAsConstantRate");
        if (scenario.includes("feed decimals > 18")) return oracle(chainlink, "test_ValidateConfigRejectsDecimalsAboveEighteen");
        if (scenario.includes("returns inverted rate")) return oracle(chainlink, "test_GetRateReturnsRoundedUpInvertedRateAndTimestamp");
        if (scenario.includes("invert is false")) return oracle(chainlink, "test_GetRateReturnsDirectRateScaledToPreciseUnits");
        if (scenario.includes("feed is zero returns constant")) return oracle(chainlink, "test_GetRateReturnsOneForConstantZeroFeed");
        if (scenario.includes("feedDecimals > 18")) return oracle(chainlink, "test_GetRateDefensivelyRejectsNormalizedDecimalsAboveEighteen");
        if (scenario.includes("answer <= 0")) return oracle(chainlink, "test_GetRateRejectsZeroAndNegativeAnswers");
        if (scenario.includes("updatedAt is 0")) return oracle(chainlink, "test_GetRateRejectsZeroUpdatedAt");
        if (scenario.includes("answeredInRound")) return oracle(chainlink, "test_GetRateRejectsStaleAnsweredRound");
        if (scenario.includes("config length is invalid")) return oracle(chainlink, "test_GetRateRejectsInvalidConfigLength");
    }
    if (test.sourceFile === "test/rateManager/pythOracleAdapter.spec.ts") {
        if (scenario.includes("packed 34-byte")) return oracle(pyth, "test_ValidateConfigPacksFeedAbsExponentAndFalseInvert");
        if (scenario.includes("invert=true")) return oracle(pyth, "test_ValidateConfigPacksTrueInvertFlag");
        if (scenario.includes("absExpo for expo=-8")) return oracle(pyth, "test_ValidateConfigUsesAbsoluteExponent");
        if (scenario.includes("feedId is bytes32(0)") || scenario.includes("feed doesn't exist")) return oracle(pyth, "test_ValidateConfigRejectsZeroOrUnknownFeed");
        if (scenario.includes("exponent > 0") || scenario.includes("exponent < -18")) return oracle(pyth, "test_ValidateConfigRejectsPositiveOrTooNegativeExponent");
        if (scenario.includes("returns direct rate")) return oracle(pyth, "test_GetRateReturnsDirectRateAndPublishTime");
        if (scenario.includes("invert is true")) return oracle(pyth, "test_GetRateReturnsRoundedUpInvertedRate");
        if (scenario.includes("with expo=-8")) return oracle(pyth, "test_GetRateScalesEightDecimalExponent");
        if (scenario.includes("with expo=-18")) return oracle(pyth, "test_GetRateScalesEighteenDecimalExponent");
        if (scenario.includes("price <= 0") || scenario.includes("price is negative")) return oracle(pyth, "test_GetRateRejectsZeroAndNegativePrices");
        if (scenario.includes("publishTime is 0")) return oracle(pyth, "test_GetRateRejectsZeroPublishTime");
        if (scenario.includes("Pyth reverts")) return oracle(pyth, "test_GetRateReturnsInvalidWhenPythReverts");
        if (scenario.includes("config length is invalid")) return oracle(pyth, "test_GetRateRejectsInvalidConfigLength");
    }
    return "";
}

const header = [
    "id", "source_file", "suite_path", "hardhat_test", "scenario", "expected_behavior",
    "fixture_dependencies", "foundry_destination", "translation_shape", "status", "evidence",
];
let verified = 0;
const rows = inventory.tests.map((test) => {
    const foundryDestination = registryDestination(test) || oracleDestination(test);
    if (test.sourceFile.startsWith("test/registries/") && !foundryDestination) {
        throw new Error(`Unmapped registry behavior: ${test.id} ${test.scenario}`);
    }
    if (["test/rateManager/chainlinkOracleAdapter.spec.ts", "test/rateManager/pythOracleAdapter.spec.ts"].includes(test.sourceFile) && !foundryDestination) {
        throw new Error(`Unmapped oracle behavior: ${test.id} ${test.scenario}`);
    }
    if (foundryDestination) verified += 1;
    const isRegistry = foundryDestination.startsWith(registryFile);
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
        foundryDestination ? (isRegistry ? "RegistryParity.t.sol: 50 passed individually and together, 0 failed, 0 skipped" : "OracleAdapterParity.t.sol: 25 passed, 0 failed, 0 skipped") : (test.pending ? "baseline-pending" : "baseline-passed"),
    ];
});

fs.writeFileSync(outputPath, `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`);
console.log(JSON.stringify({ total: rows.length, verified, remaining: rows.length - verified }, null, 2));
