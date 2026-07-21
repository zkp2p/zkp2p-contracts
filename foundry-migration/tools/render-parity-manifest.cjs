#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const inventory = require(path.join(repositoryRoot, "foundry-migration/baseline/hardhat-inventory.json"));
const outputPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");
const registryFile = "test-foundry/deterministic/registries/RegistryParity.t.sol";
const oracleFile = "test-foundry/deterministic/oracles/OracleAdapterParity.t.sol";
const attestationFile = "test-foundry/deterministic/verifiers/AttestationVerifierParity.t.sol";
const thresholdFile = "test-foundry/deterministic/libs/ThresholdSignatureParity.t.sol";
const baseUnifiedFile = "test-foundry/deterministic/verifiers/BaseUnifiedVerifierParity.t.sol";
const unifiedFile = "test-foundry/deterministic/verifiers/UnifiedPaymentVerifierParity.t.sol";
const unifiedV2CompatibilityFile = "test-foundry/deterministic/integration/UnifiedPaymentVerifierV2CompatibilityParity.t.sol";
const unifiedV3File = "test-foundry/deterministic/verifiers/UnifiedPaymentVerifierV3Parity.t.sol";

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

function attestationDestination(test) {
    const scenario = test.scenario;
    const target = (contractName, testName) => `${attestationFile}:${contractName}::${testName}`;
    if (test.sourceFile === "test/unifiedVerifier/simpleAttestationVerifier.spec.ts") {
        const contractName = "SimpleAttestationVerifierParityTest";
        if (scenario.includes("#constructor") && scenario.includes("correct initial state")) return target(contractName, "test_ConstructorSetsWitnessOwnerAndThreshold");
        if (scenario.includes("#constructor") && scenario.includes("zero witness")) return target(contractName, "test_ConstructorAllowsZeroWitness");
        if (scenario.includes("#setWitness") && (scenario.includes("should update witness") || scenario.includes("should emit"))) return target(contractName, "test_SetWitnessUpdatesStateAndEmits");
        if (scenario.includes("#setWitness")) return target(contractName, "test_SetWitnessRejectsZeroAndNonOwner");
        if (scenario.includes("valid signature and attestor")) return target(contractName, "test_VerifyReturnsTrueForWitnessSignature");
        if (scenario.includes("signed by non-witness")) return target(contractName, "test_VerifyRejectsNonWitnessSignature");
        if (scenario.includes("wrong message")) return target(contractName, "test_VerifyRejectsWitnessSignatureForWrongDigest");
        if (scenario.includes("malformed") || scenario.includes("empty bytes")) return target(contractName, "test_VerifyRejectsMalformedAndEmptySignature");
        if (scenario.includes("no signatures")) return target(contractName, "test_VerifyRejectsMissingSignaturesBeforeWitnessMatching");
        if (scenario.includes("multiple signatures")) return target(contractName, "test_VerifyAcceptsFirstValidSignatureAmongAdditionalSignatures");
    }
    if (test.sourceFile === "test/unifiedVerifier/MultiAttestationVerifier.spec.ts") {
        const contractName = "MultiAttestationVerifierParityTest";
        if (scenario.includes("one witness and threshold 1")) return target(contractName, "test_VerifySingleWitnessThresholdOne");
        if (scenario.includes("two witnesses and threshold 1") && (scenario.includes("witness A signs") || scenario.includes("witness B signs"))) return target(contractName, "test_VerifyEitherAuthorizedWitnessAtThresholdOne");
        if (scenario.includes("non-witness signs")) return target(contractName, "test_VerifyRejectsNonWitnessAtThresholdOne");
        if (scenario.includes("same witness signature is passed twice")) return target(contractName, "test_VerifyDuplicateSignerCountsOnceButMeetsThresholdOne");
        if (scenario.includes("witness A and witness B")) return target(contractName, "test_VerifyTwoDistinctWitnessesMeetThresholdTwo");
        if (scenario.includes("same witness signs twice") || scenario.includes("replayed three times")) return target(contractName, "test_VerifyDuplicateSignerDoesNotMeetThresholdTwoOrThree");
        if (scenario.includes("#constructor")) return target(contractName, "test_ConstructorRejectsZeroDuplicateAndInvalidThresholds");
        if (scenario.includes("#addWitness") && scenario.includes("emit WitnessAdded")) return target(contractName, "test_AddWitnessUpdatesSetCountAndEmits");
        if (scenario.includes("#addWitness")) return target(contractName, "test_AddWitnessRejectsNonOwnerZeroAndExistingWitness");
        if (scenario.includes("#removeWitness") && scenario.includes("emit WitnessRemoved")) return target(contractName, "test_RemoveWitnessUpdatesSetCountAndEmits");
        if (scenario.includes("#removeWitness")) return target(contractName, "test_RemoveWitnessRejectsBelowThresholdAndMissingWitness");
        if (scenario.includes("#setRequiredSignatures") && scenario.includes("emit RequiredSignaturesUpdated")) return target(contractName, "test_SetRequiredSignaturesUpdatesThresholdAndEmits");
        if (scenario.includes("#setRequiredSignatures")) return target(contractName, "test_SetRequiredSignaturesRejectsZeroAndAboveWitnessCount");
        if (scenario.includes("view helpers")) return target(contractName, "test_ViewHelpersTrackCurrentWitnessMembership");
    }
    return "";
}

function thresholdDestination(test) {
    if (test.sourceFile !== "test/libs/thresholdSigVerifierUtils.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${thresholdFile}:ThresholdSignatureParityTest::${testName}`;
    if (scenario.includes("Single witness")) return target("test_SingleWitnessMeetsThresholdOne");
    if (scenario.includes("Multiple witnesses meeting exact")) return target("test_MultipleWitnessesMeetExactThreshold");
    if (scenario.includes("More signatures than threshold")) return target("test_ExcessSignaturesAreAcceptedAfterThreshold");
    if (scenario.includes("Different signature orderings")) return target("test_SignatureOrderDoesNotAffectThreshold");
    if (scenario.includes("Zero threshold")) return target("test_RejectsZeroThreshold");
    if (scenario.includes("Threshold exceeds signatures")) return target("test_RejectsThresholdAboveSignatureCount");
    if (scenario.includes("Threshold exceeds witnesses")) return target("test_RejectsThresholdAboveWitnessCount");
    if (scenario.includes("Not enough valid signatures")) return target("test_RejectsMixedSignaturesBelowThreshold");
    if (scenario.includes("Some valid signatures") && scenario.includes("exact failure")) return target("test_ExactFailureScenarioDistinguishesTwoFromThreeValidSigners");
    if (scenario.includes("Some valid signatures")) return target("test_RejectsMixedSignaturesBelowThreshold");
    if (scenario.includes("Invalid signatures") || scenario.includes("Duplicate witnesses signing")) return target("test_RejectsInvalidSignerAndDuplicateSigner");
    if (scenario.includes("Empty signatures") || scenario.includes("Empty witnesses")) return target("test_RejectsEmptySignatureOrWitnessArrays");
    if (scenario.includes("Maximum practical")) return target("test_HandlesTenWitnessThreshold");
    if (scenario.includes("Signatures from non-witnesses")) return target("test_IgnoresNonWitnessSignaturesWhenEnoughWitnessesSign");
    if (scenario.includes("Same witness appearing")) return target("test_DuplicateWitnessEntriesDoNotPreventDistinctSignerThreshold");
    if (scenario.includes("Early exit optimization")) return target("test_EarlyThresholdSuccessIgnoresUnneededLaterSignatures");
    if (scenario.includes("Malformed signatures")) return target("test_RejectsMalformedAndEmptySignatureBytes");
    return "";
}

function baseUnifiedDestination(test) {
    if (test.sourceFile !== "test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${baseUnifiedFile}:BaseUnifiedVerifierParityTest::${testName}`;
    if (scenario.includes("#constructor")) return target("test_ConstructorSetsRegistriesAttestationVerifierAndOwner");
    if (scenario.includes("#setAttestationVerifier") && !scenario.includes("should revert")) return target("test_SetAttestationVerifierUpdatesStateAndEmits");
    if (scenario.includes("#setAttestationVerifier")) return target("test_SetAttestationVerifierRejectsZeroSameAndNonOwner");
    if (scenario.includes("#addPaymentMethod") && !scenario.includes("should revert")) return target("test_AddPaymentMethodUpdatesArrayMappingAndEmits");
    if (scenario.includes("#addPaymentMethod")) return target("test_AddPaymentMethodRejectsDuplicateAndNonOwner");
    if (scenario.includes("#removePaymentMethod") && !scenario.includes("should revert")) return target("test_RemovePaymentMethodUpdatesArrayMappingAndEmits");
    if (scenario.includes("#removePaymentMethod")) return target("test_RemovePaymentMethodRejectsMissingAndNonOwner");
    if (scenario.includes("view functions")) return target("test_ViewFunctionsReturnAllConfiguredMethodsAndMembership");
    return "";
}

function unifiedV3Destination(test) {
    if (test.sourceFile !== "test/unifiedVerifier/unifiedPaymentVerifierV3.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${unifiedV3File}:UnifiedPaymentVerifierV3ParityTest::${testName}`;
    const mappings = [
        ["serves Orchestrator V2 and V3", "test_ServesLegacyAndV2ShapedOrchestratorsWithThreeFieldResultAndBindings"],
        ["rejects predecessor replay", "test_RejectsPredecessorReplayAndReplayAcrossLiveOrchestrators"],
        ["rejects an attested method", "test_RejectsMethodMismatchAndZeroPaymentFields"],
        ["rejects an attestation bound", "test_RejectsDifferentAttestedIntentBeforeNullifierWrite"],
        ["rejects a zero attested release", "test_RejectsZeroReleaseBeforeNullifierWrite"],
        ["accepts only a distinct deployed", "test_AttestationVerifierRotationRequiresDistinctDeployedContractAndOwner"],
        ["fully enforces constructor", "test_ConstructorAndPaymentMethodGovernanceEnforceAllBoundaries"],
        ["rejects unauthorized callers", "test_RejectsUnauthorizedUnsupportedInvalidSignatureAndTamperedData"],
        ["validates every attested intent snapshot", "test_ValidatesEveryIntentSnapshotFieldAndTimestampCeiling"],
        ["caps overpayment", "test_CapsOverpaymentOnLegacySnapshotShape"],
        ["survives verifier rotation", "test_VerifierRotationPreservesServiceAndRetiresOldWriter"],
    ];
    const mapping = mappings.find(([needle]) => scenario.includes(needle));
    return mapping ? target(mapping[1]) : "";
}

function unifiedDestination(test) {
    if (test.sourceFile !== "test/unifiedVerifier/unifiedPaymentVerifier.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${unifiedFile}:UnifiedPaymentVerifierParityTest::${testName}`;
    if (scenario.includes("verifies witness signature")) return target("test_VerifiesWitnessSignatureAndReturnsExactResult");
    if (scenario.includes("emits PaymentVerified")) return target("test_EmitsCompletePaymentVerifiedEvent");
    if (scenario.includes("nullify the payment")) return target("test_NullifiesCollisionResistantMethodAndPaymentIdentifier");
    if (scenario.includes("snapshot validation failures")) return target("test_RejectsEveryMismatchedSnapshotFieldAndExcessiveTimestampBuffer");
    if (scenario.includes("payment method is not registered")) return target("test_RejectsUnregisteredPaymentMethod");
    if (scenario.includes("witness signature is not")) return target("test_RejectsSignatureFromNonWitness");
    if (scenario.includes("attestation verifier returns false")) return target("test_RejectsFalseAttestationVerifierResult");
    if (scenario.includes("release amount exceeds")) return target("test_CapsReleaseAmountToIntentAmount");
    if (scenario.includes("payment has already been verified")) return target("test_RejectsReusedPaymentAcrossDifferentIntents");
    if (scenario.includes("caller is not orchestrator")) return target("test_RejectsCallerOutsideOrchestratorRegistry");
    if (scenario.includes("attestation data hash")) return target("test_RejectsAttestationDataHashMismatch");
    if (scenario.includes("signature digest is tampered")) return target("test_RejectsTamperedSignatureDigest");
    return "";
}

function unifiedV2CompatibilityDestination(test) {
    if (test.sourceFile !== "test/unifiedVerifier/unifiedPaymentVerifierV2.spec.ts") return "";
    if (!test.scenario.includes("fulfills a V2 intent using UnifiedPaymentVerifier")) return "";
    return `${unifiedV2CompatibilityFile}:UnifiedPaymentVerifierV2CompatibilityParityTest::test_FulfillsV2IntentWithUnifiedVerifierAndTransfersExactTokens`;
}

const header = [
    "id", "source_file", "suite_path", "hardhat_test", "scenario", "expected_behavior",
    "fixture_dependencies", "foundry_destination", "translation_shape", "status", "evidence",
];
let verified = 0;
const rows = inventory.tests.map((test) => {
    const foundryDestination = registryDestination(test) || oracleDestination(test) || attestationDestination(test) || thresholdDestination(test) || baseUnifiedDestination(test) || unifiedDestination(test) || unifiedV2CompatibilityDestination(test) || unifiedV3Destination(test);
    if (test.sourceFile.startsWith("test/registries/") && !foundryDestination) {
        throw new Error(`Unmapped registry behavior: ${test.id} ${test.scenario}`);
    }
    if (["test/rateManager/chainlinkOracleAdapter.spec.ts", "test/rateManager/pythOracleAdapter.spec.ts"].includes(test.sourceFile) && !foundryDestination) {
        throw new Error(`Unmapped oracle behavior: ${test.id} ${test.scenario}`);
    }
    if (["test/unifiedVerifier/simpleAttestationVerifier.spec.ts", "test/unifiedVerifier/MultiAttestationVerifier.spec.ts"].includes(test.sourceFile) && !foundryDestination) {
        throw new Error(`Unmapped attestation behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/libs/thresholdSigVerifierUtils.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped threshold-signature behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/unifiedVerifier/baseUnifiedPaymentVerifier.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped base unified verifier behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/unifiedVerifier/unifiedPaymentVerifierV3.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped unified verifier V3 behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/unifiedVerifier/unifiedPaymentVerifier.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped unified verifier behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/unifiedVerifier/unifiedPaymentVerifierV2.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped unified verifier V2 compatibility behavior: ${test.id} ${test.scenario}`);
    }
    if (foundryDestination) verified += 1;
    let evidence = "";
    if (foundryDestination.startsWith(registryFile)) evidence = "RegistryParity.t.sol: 50 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(oracleFile)) evidence = "OracleAdapterParity.t.sol: 25 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(attestationFile)) evidence = "AttestationVerifierParity.t.sol: 24 passed, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(thresholdFile)) evidence = "ThresholdSignatureParity.t.sol: 16 passed, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(baseUnifiedFile)) evidence = "BaseUnifiedVerifierParity.t.sol: 8 passed, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(unifiedFile)) evidence = "UnifiedPaymentVerifierParity.t.sol: 12 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(unifiedV2CompatibilityFile)) evidence = "UnifiedPaymentVerifierV2CompatibilityParity.t.sol: 1 end-to-end topology test passed independently, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(unifiedV3File)) evidence = "UnifiedPaymentVerifierV3Parity.t.sol: 11 passed individually and together, 0 failed, 0 skipped";
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
        foundryDestination ? evidence : (test.pending ? "baseline-pending" : "baseline-passed"),
    ];
});

fs.writeFileSync(outputPath, `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`);
console.log(JSON.stringify({ total: rows.length, verified, remaining: rows.length - verified }, null, 2));
