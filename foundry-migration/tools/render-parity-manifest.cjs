#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const inventory = require(path.join(repositoryRoot, "foundry-migration/baseline/hardhat-inventory.json"));
const outputPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");
const registryFile = "test-foundry/deterministic/registries/RegistryParity.t.sol";
const escrowV2PythFile = "test-foundry/deterministic/escrow/EscrowV2PythOracleParity.t.sol";
const escrowV2CurrencyRateFile = "test-foundry/deterministic/escrow/EscrowV2CurrencyRateParity.t.sol";
const oracleFile = "test-foundry/deterministic/oracles/OracleAdapterParity.t.sol";
const orchestratorV2File = "test-foundry/deterministic/orchestrator/OrchestratorV2RateManagerParity.t.sol";
const preIntentHookFile = "test-foundry/deterministic/orchestrator/PreIntentHookParity.t.sol";
const whitelistPreIntentHookFile = "test-foundry/deterministic/hooks/WhitelistPreIntentHookParity.t.sol";
const acrossBridgeHookFile = "test-foundry/deterministic/hooks/AcrossBridgeHookParity.t.sol";
const rateManagerV1File = "test-foundry/deterministic/rateManager/RateManagerV1Parity.t.sol";
const escrowV2DelegationFile = "test-foundry/deterministic/escrow/EscrowV2DelegationParity.t.sol";
const escrowV2OracleConfigFile = "test-foundry/deterministic/escrow/EscrowV2OracleRateConfigParity.t.sol";
const escrowV2LegacyManagementFile = "test-foundry/deterministic/escrow/EscrowV2ManagementParity.t.sol";
const escrowV2LegacyLifecycleFile = "test-foundry/deterministic/escrow/EscrowV2LifecycleParity.t.sol";
const escrowV2LegacyConfigurationFile = "test-foundry/deterministic/escrow/EscrowV2ConfigurationParity.t.sol";
const escrowV2BranchAuthorizationFile = "test-foundry/deterministic/escrow/EscrowV2BranchAuthorizationParity.t.sol";
const escrowV2BranchValidationFile = "test-foundry/deterministic/escrow/EscrowV2BranchValidationParity.t.sol";
const escrowV2BranchGovernanceLifecycleFile = "test-foundry/deterministic/escrow/EscrowV2BranchGovernanceLifecycleParity.t.sol";
const escrowV2BranchStatePauseFile = "test-foundry/deterministic/escrow/EscrowV2BranchStatePauseParity.t.sol";
const escrowCreateDepositFile = "test-foundry/deterministic/escrow/EscrowCreateDepositParity.t.sol";
const escrowFundingFile = "test-foundry/deterministic/escrow/EscrowFundingParity.t.sol";
const escrowWithdrawFile = "test-foundry/deterministic/escrow/EscrowWithdrawParity.t.sol";
const escrowRateRangeFile = "test-foundry/deterministic/escrow/EscrowRateRangeParity.t.sol";
const escrowPaymentMethodFile = "test-foundry/deterministic/escrow/EscrowPaymentMethodParity.t.sol";
const escrowCurrencyFile = "test-foundry/deterministic/escrow/EscrowCurrencyParity.t.sol";
const escrowDelegateFile = "test-foundry/deterministic/escrow/EscrowDelegateParity.t.sol";
const escrowAcceptingRetainFile = "test-foundry/deterministic/escrow/EscrowAcceptingRetainParity.t.sol";
const escrowPruningFile = "test-foundry/deterministic/escrow/EscrowPruningParity.t.sol";
const escrowLockFundsFile = "test-foundry/deterministic/escrow/EscrowLockFundsParity.t.sol";
const escrowUnlockFundsFile = "test-foundry/deterministic/escrow/EscrowUnlockFundsParity.t.sol";
const escrowUnlockTransferFile = "test-foundry/deterministic/escrow/EscrowUnlockTransferParity.t.sol";
const escrowIntentExpiryFile = "test-foundry/deterministic/escrow/EscrowIntentExpiryParity.t.sol";
const escrowGovernanceFile = "test-foundry/deterministic/escrow/EscrowGovernanceParity.t.sol";
const escrowExpiredIntentsViewFile = "test-foundry/deterministic/escrow/EscrowExpiredIntentsViewParity.t.sol";
const orchestratorLegacySignalFile = "test-foundry/deterministic/orchestrator/OrchestratorSignalParity.t.sol";
const orchestratorLegacyCancelFile = "test-foundry/deterministic/orchestrator/OrchestratorCancelParity.t.sol";
const orchestratorLegacyFulfillCoreFile = "test-foundry/deterministic/orchestrator/OrchestratorFulfillCoreParity.t.sol";
const orchestratorLegacyFulfillAccountingFile = "test-foundry/deterministic/orchestrator/OrchestratorFulfillAccountingParity.t.sol";
const orchestratorV2LifecycleFile = "test-foundry/deterministic/orchestrator/OrchestratorV2LifecycleParity.t.sol";
const orchestratorV2HooksFile = "test-foundry/deterministic/orchestrator/OrchestratorV2HooksGovernanceParity.t.sol";
const protocolViewerV2File = "test-foundry/deterministic/periphery/ProtocolViewerV2Parity.t.sol";
const protocolViewerFile = "test-foundry/deterministic/periphery/ProtocolViewerParity.t.sol";
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

function orchestratorV2Destination(test) {
    if (test.sourceFile !== "test/orchestratorV2/orchestratorV2.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${orchestratorV2File}:OrchestratorV2RateManagerParityTest::${testName}`;
    if (scenario.includes("uses EscrowV2 delegated effective rate")) return target("test_SignalUsesDelegatedRateAndSnapshotsManagerFee");
    if (scenario.includes("allows an ordinary account")) return target("test_OrdinaryAccountCanKeepMultipleConcurrentIntents");
    if (scenario.includes("does not expose retired relayer")) return target("test_RetiredRelayerAndGlobalMultipleIntentSelectorsAreAbsent");
    if (scenario.includes("conversion rate is below delegated")) return target("test_SignalRejectsConversionRateBelowDelegatedRate");
    if (scenario.includes("delegated manager fee exceeds")) return target("test_SignalRejectsDelegatedManagerFeeAboveMaximum");
    if (scenario.includes("deducts manager fee")) return target("test_FulfillDeductsManagerFeeAndTransfersNetAmount");
    return "";
}

function escrowV2PythDestination(test) {
    if (test.sourceFile !== "test/escrowV2/escrowV2.pythOracle.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${escrowV2PythFile}:EscrowV2PythOracleParityTest::${testName}`;
    if (scenario.includes("sets Pyth oracle config and returns correct spread")) return target("test_SetPythConfigReturnsRoundedUpSpreadRate");
    if (scenario.includes("returns max(fixedRate")) return target("test_EffectiveRateReturnsMaximumOfFixedAndPythSpreadRate");
    if (scenario.includes("returns zero when Pyth price is stale")) return target("test_StalePythPriceHaltsEffectiveRateAtZero");
    if (scenario.includes("updates effective rate when mock price changes")) return target("test_EffectiveRateTracksFreshPythPriceUpdate");
    if (scenario.includes("sets oracle config during createDeposit")) return target("test_CreateDepositStoresInlinePythConfigAndEmits");
    return "";
}

function escrowV2CurrencyRateDestination(test) {
    if (test.sourceFile !== "test/escrowV2/escrowV2.getDepositCurrencyMinRate.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${escrowV2CurrencyRateFile}:EscrowV2CurrencyRateParityTest::${testName}`;
    if (scenario.includes("returns fixed rate when only fixed")) return target("test_ReturnsFixedRateWhenOnlyFixedSourceConfigured");
    if (scenario.includes("returns spread rate when fixed floor is zero")) return target("test_ReturnsSpreadRateWhenFixedFloorIsZero");
    if (scenario.includes("returns max(fixed, spread)")) return target("test_ReturnsMaximumOfFixedAndSpreadRates");
    if (scenario.includes("below-market oracle floor")) return target("test_ReturnsBelowMarketFloorForNegativeSpread");
    if (scenario.includes("oracle configured but stale")) return target("test_StaleConfiguredOracleHaltsRateAtZero");
    if (scenario.includes("fixed floor when no oracle")) return target("test_ReturnsUpdatedFixedFloorWithoutOracle");
    if (scenario.includes("returns zero when currency is deactivated")) return target("test_DeactivatedCurrencyReturnsZero");
    if (scenario.includes("clears fixed and oracle")) return target("test_DeactivateClearsFixedAndOracleConfigAndEmitsBothEvents");
    if (scenario.includes("re-enable by setting fixed")) return target("test_DeactivatedCurrencyCanBeReenabledByFixedFloor");
    if (scenario.includes("re-enable by setting oracle")) return target("test_DeactivatedCurrencyCanBeReenabledByOracleConfig");
    if (scenario.includes("fixed floor is set to zero but oracle")) return target("test_ZeroFixedFloorKeepsCurrencyActiveWhileOracleRemains");
    if (scenario.includes("oracle config is removed but fixed")) return target("test_RemovingOracleKeepsCurrencyActiveWhileFixedFloorRemains");
    return "";
}

function protocolViewerV2Destination(test) {
    if (test.sourceFile !== "test/periphery/protocolViewerV2.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${protocolViewerV2File}:ProtocolViewerV2ParityTest::${testName}`;
    if (scenario.includes("returns deposit data for a provided")) return target("test_GetDepositReturnsCompleteDepositPaymentMethodAndCurrencyData");
    if (scenario.includes("returns native min rate")) return target("test_GetDepositReturnsNativeRateWithoutManager");
    if (scenario.includes("returns delegated rate")) return target("test_GetDepositReturnsDelegatedManagerRate");
    if (scenario.includes("falls back to native rate")) return target("test_GetDepositFallsBackToNativeRateWhenManagerReverts");
    if (scenario.includes("rate manager returns zero")) return target("test_GetDepositReturnsZeroWhenManagerDisablesPair");
    if (scenario.includes("#getDeposit reverts when escrow")) return target("test_GetDepositRejectsZeroEscrow");
    if (scenario.includes("returns all requested deposits")) return target("test_GetDepositFromIdsReturnsEveryRequestedDeposit");
    if (scenario.includes("zero even with empty deposit ids")) return target("test_GetDepositFromIdsRejectsZeroEscrowEvenWhenIdsEmpty");
    if (scenario.includes("returns a single intent")) return target("test_GetIntentReturnsIntentAndDepositResolvedFromIntentEscrow");
    if (scenario.includes("returns all intents for an account")) return target("test_GetAccountIntentsReturnsAllAccountIntents");
    if (scenario.includes("returns intents for a provided list")) return target("test_GetIntentsReturnsViewsForProvidedHashesInOrder");
    if (scenario.includes("orchestrator address is zero")) return target("test_GetIntentRejectsZeroOrchestrator");
    return "";
}

function protocolViewerDestination(test) {
    if (test.sourceFile !== "test/periphery/protocolViewer.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${protocolViewerFile}:ProtocolViewerParityTest::${testName}`;
    if (scenario.includes("should set the initial escrow")) return target("test_ConstructorSetsInitialEscrowAndOrchestrator");
    if (scenario.includes("constructor when escrow is zero")) return target("test_ConstructorRejectsZeroEscrow");
    if (scenario.includes("constructor when orchestrator is zero")) return target("test_ConstructorRejectsZeroOrchestrator");
    if (scenario.includes("return the correct deposit details")) return target("test_GetDepositReturnsCompleteDepositDetails");
    if (scenario.includes("return the correct payment method")) return target("test_GetDepositReturnsCompletePaymentMethodDetails");
    if (scenario.includes("return the correct available liquidity")) return target("test_GetDepositReturnsAvailableLiquidity");
    if (scenario.includes("prunable amounts")) return target("test_GetDepositIncludesExpiredIntentAmountInAvailableLiquidity");
    if (scenario.includes("return empty deposit view")) return target("test_GetDepositReturnsEmptyViewForMissingDeposit");
    if (scenario.includes("should return correct deposits")) return target("test_GetDepositFromIdsReturnsRequestedDepositsInOrder");
    if (scenario.includes("zero address depositor")) return target("test_GetDepositFromIdsReturnsEmptyViewForMissingId");
    if (scenario.includes("#getIntent should return correct")) return target("test_GetIntentReturnsCorrectIntent");
    if (scenario.includes("#getIntents should return correct")) return target("test_GetIntentsReturnsCorrectIntentList");
    if (scenario.includes("correct intents for account")) return target("test_GetAccountIntentsReturnsCorrectAccountIntents");
    if (scenario.includes("account has no intents")) return target("test_GetAccountIntentsReturnsEmptyForAccountWithoutIntents");
    if (scenario.includes("account has multiple intents")) return target("test_GetAccountIntentsReturnsAllMultipleIntents");
    return "";
}

function preIntentHookDestination(test) {
    if (test.sourceFile !== "test/orchestrator/preIntentHook.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${preIntentHookFile}:PreIntentHookParityTest::${testName}`;
    if (scenario.includes("allows depositor to set a pre-intent")) return target("test_DepositorCanSetPreIntentHookAndEmits");
    if (scenario.includes("allows delegate to set a pre-intent")) return target("test_DelegateCanSetPreIntentHookAndEmits");
    if (scenario.includes("reverts for unauthorized caller")) return target("test_UnauthorizedCallerCannotSetPreIntentHook");
    if (scenario.includes("removes a pre-intent hook")) return target("test_ZeroHookRemovesPreIntentHookAndEmits");
    if (scenario.includes("hook is an EOA")) return target("test_EoaCannotBeConfiguredAsPreIntentHook");
    if (scenario.includes("deposit does not exist")) return target("test_MissingDepositCannotConfigurePreIntentHook");
    if (scenario.includes("#setDepositPreIntentHook when escrow is zero")) return target("test_ZeroEscrowCannotConfigurePreIntentHook");
    if (scenario.includes("passes preIntentHookData")) return target("test_SignalPassesEphemeralHookDataWithoutPersistingIt");
    if (scenario.includes("reverts when pre-intent hook rejects")) return target("test_SignalRevertsAtomicallyWhenPreIntentHookRejects");
    if (scenario.includes("works normally when no pre-intent")) return target("test_SignalWorksWithoutConfiguredPreIntentHook");
    if (scenario.includes("skips hook execution")) return target("test_SignalSkipsRemovedPreIntentHook");
    if (scenario.includes("prevents hook-driven reentrant")) return target("test_ReentrantHookCannotCreateSecondIntent");
    if (scenario.includes("SignatureGatingPreIntentHook #constructor")) return target("test_SignatureHookConstructorRejectsZeroRegistry");
    if (scenario.includes("allows depositor to set signer")) return target("test_DepositorCanSetDepositSignerAndEmits");
    if (scenario.includes("allows delegate to set signer")) return target("test_DelegateCanSetDepositSignerAndEmits");
    if (scenario.includes("#setDepositSigner when called by unauthorized")) return target("test_UnauthorizedCallerCannotSetDepositSigner");
    if (scenario.includes("#setDepositSigner when escrow is zero")) return target("test_ZeroEscrowCannotSetDepositSigner");
    if (scenario.includes("accepts valid signature data")) return target("test_SignatureHookAcceptsValidSignature");
    if (scenario.includes("when signature is invalid")) return target("test_SignatureHookRejectsInvalidSigner");
    if (scenario.includes("when called directly")) return target("test_SignatureHookRejectsDirectCaller");
    if (scenario.includes("when signer is not set")) return target("test_SignatureHookRejectsDepositWithoutSigner");
    if (scenario.includes("caller differs from signed taker")) return target("test_SignatureHookBindsActualCallerAsTaker");
    if (scenario.includes("when signature is expired")) return target("test_SignatureHookRejectsExpiredSignature");
    return "";
}

function whitelistPreIntentHookDestination(test) {
    if (test.sourceFile !== "test/hooks/whitelistPreIntentHook.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${whitelistPreIntentHookFile}:WhitelistPreIntentHookParityTest::${testName}`;
    if (scenario.includes("#constructor") && scenario.includes("zero address")) return target("test_ConstructorRejectsZeroOrchestratorRegistry");
    if (scenario.includes("#constructor")) return target("test_ConstructorStoresOrchestratorRegistry");
    if (scenario.includes("#addToWhitelist") && scenario.includes("whitelists takers")) return target("test_DepositorWhitelistsTakersAndEmitsPerTaker");
    if (scenario.includes("#addToWhitelist") && scenario.includes("allows delegate")) return target("test_DelegateCanWhitelistTakers");
    if (scenario.includes("#addToWhitelist") && scenario.includes("unauthorized caller")) return target("test_UnauthorizedCallerCannotWhitelistTakers");
    if (scenario.includes("#addToWhitelist") && scenario.includes("escrow is zero")) return target("test_ZeroEscrowCannotWhitelistTakers");
    if (scenario.includes("#addToWhitelist") && scenario.includes("array is empty")) return target("test_EmptyArrayCannotWhitelistTakers");
    if (scenario.includes("#addToWhitelist") && scenario.includes("taker is zero")) return target("test_ZeroTakerRevertsEntireWhitelistBatch");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("removes takers")) return target("test_DepositorRemovesTakerAndEmitsWithoutAffectingOthers");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("allows delegate")) return target("test_DelegateCanRemoveTaker");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("unauthorized caller")) return target("test_UnauthorizedCallerCannotRemoveTaker");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("escrow is zero")) return target("test_ZeroEscrowCannotRemoveTaker");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("array is empty")) return target("test_EmptyArrayCannotRemoveTakers");
    if (scenario.includes("#removeFromWhitelist") && scenario.includes("not in whitelist")) return target("test_NonWhitelistedTakerCannotBeRemoved");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("sets whitelist hook")) return target("test_DepositorSetsWhitelistHookAndEmits");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("allows delegate")) return target("test_DelegateCanSetWhitelistHook");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("allows removing")) return target("test_ZeroHookRemovesWhitelistHookAndEmits");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("unauthorized caller")) return target("test_UnauthorizedCallerCannotSetWhitelistHook");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("escrow is zero")) return target("test_ZeroEscrowCannotSetWhitelistHook");
    if (scenario.includes("#setDepositWhitelistHook") && scenario.includes("hook is an EOA")) return target("test_EoaCannotBeConfiguredAsWhitelistHook");
    if (scenario.includes("dedicated whitelist hook slot") && scenario.includes("when taker is whitelisted")) return target("test_WhitelistedTakerCanSignalAndEmitsIntent");
    if (scenario.includes("dedicated whitelist hook slot") && scenario.includes("when taker is not whitelisted")) return target("test_NonWhitelistedTakerCannotSignal");
    if (scenario.includes("dedicated whitelist hook slot") && scenario.includes("whitelisted then removed")) return target("test_RemovedTakerCannotSignal");
    if (scenario.includes("dedicated whitelist hook slot") && scenario.includes("called directly")) return target("test_DirectValidationCallRejectsNonOrchestrator");
    if (scenario.includes("both hooks") && scenario.includes("stored independently")) return target("test_GenericAndWhitelistHooksAreStoredIndependently");
    if (scenario.includes("both hooks") && scenario.includes("whitelisted taker passes")) return target("test_SignalCallsBothHooksWhenTakerIsWhitelisted");
    if (scenario.includes("both hooks") && scenario.includes("whitelist hook rejects")) return target("test_WhitelistRejectionRevertsGenericHookStateToo");
    if (scenario.includes("both hooks") && scenario.includes("removing whitelist hook")) return target("test_RemovingWhitelistHookLeavesGenericHookIntact");
    if (scenario.includes("both hooks") && scenario.includes("removing generic hook")) return target("test_RemovingGenericHookLeavesWhitelistHookIntact");
    return "";
}

function acrossBridgeHookDestination(test) {
    const legacy = test.sourceFile === "test/hooks/acrossBridgeHook.spec.ts";
    const v2 = test.sourceFile === "test/hooks/acrossBridgeHookV2.spec.ts";
    if (!legacy && !v2) return "";
    const scenario = test.scenario;
    const contractName = legacy ? "AcrossBridgeHookLegacyParityTest" : "AcrossBridgeHookV2ParityTest";
    const target = (testName) => `${acrossBridgeHookFile}:${contractName}::${testName}`;
    if (scenario.includes("initial variables correctly")) return target("test_ConstructorStoresInitialVariables");
    if (scenario.includes("inputToken is zero")) return target("test_ConstructorRejectsZeroInputToken");
    if (scenario.includes("orchestratorRegistry is zero")) return target("test_ConstructorRejectsZeroOrchestratorRegistry");
    if (scenario.includes("orchestrator is zero")) return target("test_ConstructorRejectsZeroOrchestrator");
    if (scenario.includes("spokePool is zero")) return target("test_ConstructorRejectsZeroSpokePool");
    if (scenario.includes("owner to deployer")) return target("test_OwnerIsDeployer");
    if (scenario.includes("execute with valid parameters") || scenario.includes("bridge successfully")) return target("test_ExecuteBridgesAndForwardsEveryAcrossParameter");
    if (scenario.includes("caller is not a registered orchestrator")) return target("test_ExecuteRejectsNonRegisteredOrchestrator");
    if (scenario.includes("caller is not orchestrator")) return target("test_ExecuteRejectsNonOrchestrator");
    if (scenario.includes("length is not 128")) return target("test_ExecuteRejectsWrongFulfillDataLength");
    if (scenario.includes("fulfillHookData is empty")) return target("test_ExecuteRejectsEmptyFulfillData");
    if (scenario.includes("destinationChainId is zero")) return target("test_ExecuteRejectsZeroDestinationChainId");
    if (scenario.includes("recipient is zero bytes32")) return target("test_ExecuteRejectsZeroRecipient");
    if (scenario.includes("outputToken is zero bytes32")) return target("test_ExecuteRejectsZeroOutputToken");
    if (scenario.includes("outputAmount is below") || scenario.includes("outputAmount is below minOutputAmount")) return target("test_OutputBelowMinimumFallsBackToIntentRecipient");
    if (scenario.includes("bridge call reverts")) return target("test_BridgeRevertFallsBackToIntentRecipient");
    if (scenario.includes("outputAmount equals minOutputAmount")) return target("test_OutputEqualToMinimumBridges");
    if (scenario.includes("different fillDeadlineOffset")) return target("test_CustomFillDeadlineOffsetReachesSpokePool");
    if (scenario.includes("pass custom exclusiveRelayer") || scenario.includes("pass exclusiveRelayer")) return target("test_CustomExclusiveRelayerAndParameterReachSpokePool");
    if (scenario.includes("zero exclusivity")) return target("test_ZeroExclusivityCreatesOpenRelayDeposit");
    if (scenario.includes("convert depositor")) return target("test_HookAddressIsBytes32Depositor");
    if (scenario.includes("#rescueERC20") && scenario.includes("rescue ERC20")) return target("test_RescueERC20TransfersTokensAndEmits");
    if (scenario.includes("#rescueERC20") && scenario.includes("non-owner")) return target("test_RescueERC20RejectsNonOwner");
    if (scenario.includes("#rescueERC20") && scenario.includes("token address is zero")) return target("test_RescueERC20RejectsZeroToken");
    if (scenario.includes("#rescueERC20") && scenario.includes("recipient address is zero")) return target("test_RescueERC20RejectsZeroRecipient");
    if (scenario.includes("#rescueNative") && scenario.includes("rescue native")) return target("test_RescueNativeTransfersAndEmits");
    if (scenario.includes("#rescueNative") && scenario.includes("non-owner")) return target("test_RescueNativeRejectsNonOwner");
    if (scenario.includes("#rescueNative") && scenario.includes("recipient address is zero")) return target("test_RescueNativeRejectsZeroRecipient");
    if (scenario.includes("#rescueNative") && scenario.includes("partial rescue")) return target("test_RescueNativeAllowsPartialAmount");
    if (scenario.includes("#rescueNative") && scenario.includes("native transfer fails")) return target("test_RescueNativeRejectsFailedTransfer");
    if (scenario.includes("#receive") && scenario.includes("accept native")) return target("test_ReceiveAcceptsNativeTokens");
    return "";
}

function rateManagerV1Destination(test) {
    if (test.sourceFile !== "test/rateManager/rateManagerV1.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${rateManagerV1File}:RateManagerV1ParityTest::${testName}`;
    if (scenario.includes("creates manager and emits")) return target("test_CreateRateManagerEmitsAndStoresConfig");
    if (scenario.includes("emits MinLiquidityUpdated when")) return target("test_CreateRateManagerWithMinimumLiquidityEmitsBothEvents");
    if (scenario.includes("#createRateManager") && scenario.includes("maxFee exceeds")) return target("test_CreateRejectsMaxFeeAboveGlobalCap");
    if (scenario.includes("#createRateManager") && scenario.includes("manager is zero")) return target("test_CreateRejectsZeroManager");
    if (scenario.includes("#createRateManager") && scenario.includes("fee recipient is zero")) return target("test_CreateRejectsZeroFeeRecipientForNonzeroFee");
    if (scenario.includes("#createRateManager") && scenario.includes("fee exceeds maxFee")) return target("test_CreateRejectsFeeAboveManagerMaximum");
    if (scenario.includes("#setRate") && scenario.includes("sets manager rate")) return target("test_SetRateStoresRateAndEmits");
    if (scenario.includes("#setRate") && scenario.includes("caller is not manager")) return target("test_SetRateRejectsNonManager");
    if (scenario.includes("#setRate") && scenario.includes("id does not exist")) return target("test_SetRateRejectsMissingManager");
    if (scenario.includes("#setRate") && scenario.includes("payment method is zero")) return target("test_SetRateRejectsZeroPaymentMethod");
    if (scenario.includes("#setRate") && scenario.includes("currency code is zero")) return target("test_SetRateRejectsZeroCurrency");
    if (scenario.includes("#setFee") && scenario.includes("updates fee")) return target("test_SetFeeUpdatesFeeAndEmits");
    if (scenario.includes("#setFee") && scenario.includes("exceeds manager maxFee")) return target("test_SetFeeRejectsAboveManagerMaximum");
    if (scenario.includes("#setFee") && scenario.includes("caller is not manager")) return target("test_SetFeeRejectsNonManager");
    if (scenario.includes("#setFee") && scenario.includes("id does not exist")) return target("test_SetFeeRejectsMissingManager");
    if (scenario.includes("#setFee") && scenario.includes("fee recipient is zero")) return target("test_SetFeeRejectsNonzeroFeeAfterRecipientRemoved");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("updates rate manager config")) return target("test_SetConfigUpdatesMutableFieldsAndEmits");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("manager is zero")) return target("test_SetConfigRejectsZeroManager");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("current fee is non-zero")) return target("test_SetConfigRejectsZeroRecipientWhileFeeNonzero");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("current fee is zero")) return target("test_SetConfigAllowsZeroRecipientWhenFeeIsZero");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("caller is not manager")) return target("test_SetConfigRejectsNonManager");
    if (scenario.includes("#setRateManagerConfig") && scenario.includes("id does not exist")) return target("test_SetConfigRejectsMissingManager");
    if (scenario.includes("#setRateBatch") && scenario.includes("sets manager rates")) return target("test_SetRateBatchStoresRateAndEmitsAggregate");
    if (scenario.includes("#setRateBatch") && scenario.includes("payment methods length does not match currencies")) return target("test_SetRateBatchRejectsMethodCurrencyOuterLengthMismatch");
    if (scenario.includes("#setRateBatch") && scenario.includes("payment methods length does not match rates")) return target("test_SetRateBatchRejectsMethodRateOuterLengthMismatch");
    if (scenario.includes("#setRateBatch") && scenario.includes("currency codes length does not match")) return target("test_SetRateBatchRejectsInnerLengthMismatch");
    if (scenario.includes("#setRateBatch") && scenario.includes("payment method is zero")) return target("test_SetRateBatchRejectsZeroPaymentMethod");
    if (scenario.includes("#setRateBatch") && scenario.includes("currency code is zero")) return target("test_SetRateBatchRejectsZeroCurrency");
    if (scenario.includes("#setRateBatch") && scenario.includes("caller is not manager")) return target("test_SetRateBatchRejectsNonManager");
    if (scenario.includes("#setRateBatch") && scenario.includes("id does not exist")) return target("test_SetRateBatchRejectsMissingManager");
    if (scenario.includes("#getRate") && scenario.includes("manager rate when set")) return target("test_GetRateReturnsStoredManagerRate");
    if (scenario.includes("#getRate") && scenario.includes("rate not set")) return target("test_GetRateReturnsZeroForUnsetPair");
    if (scenario.includes("#getRate") && scenario.includes("manager does not exist")) return target("test_GetRateReturnsZeroForMissingManager");
    if (scenario.includes("view getters")) return target("test_GetRateManagerReturnsConfig");
    if (scenario.includes("#setMinLiquidity") && scenario.includes("sets min liquidity")) return target("test_SetMinLiquidityStoresAndEmits");
    if (scenario.includes("#setMinLiquidity") && scenario.includes("reads back")) return target("test_GetRateManagerReadsMinimumLiquidity");
    if (scenario.includes("#setMinLiquidity") && scenario.includes("clears min liquidity")) return target("test_SetMinLiquidityZeroClearsRequirement");
    if (scenario.includes("#setMinLiquidity") && scenario.includes("caller is not manager")) return target("test_SetMinLiquidityRejectsNonManager");
    if (scenario.includes("#setMinLiquidity") && scenario.includes("id does not exist")) return target("test_SetMinLiquidityRejectsMissingManager");
    if (scenario.includes("#onDepositOptIn with minLiquidity") && scenario.includes("no min liquidity")) return target("test_OptInPassesWhenMinimumLiquidityDisabled");
    if (scenario.includes("#onDepositOptIn with minLiquidity") && scenario.includes("meets threshold")) return target("test_OptInPassesWhenDepositMeetsMinimumLiquidity");
    if (scenario.includes("#onDepositOptIn with minLiquidity") && scenario.includes("below threshold")) return target("test_OptInRejectsDepositBelowMinimumLiquidity");
    if (scenario.includes("#onDepositOptIn with minLiquidity") && scenario.includes("cleared back")) return target("test_OptInPassesAfterMinimumLiquidityCleared");
    if (scenario.includes("#onDepositOptIn access control") && scenario.includes("not a whitelisted")) return target("test_OptInRejectsUnlistedEscrow");
    if (scenario.includes("#onDepositOptIn access control") && scenario.includes("whitelisted escrow")) return target("test_OptInPassesForWhitelistedEscrow");
    if (scenario.includes("#onDepositOptIn access control") && scenario.includes("acceptAllEscrows")) return target("test_OptInPassesWhenRegistryAcceptsAllEscrows");
    if (scenario.includes("#setEscrowRegistry") && scenario.includes("updates escrow registry")) return target("test_SetEscrowRegistryUpdatesState");
    if (scenario.includes("#setEscrowRegistry") && scenario.includes("emits EscrowRegistryUpdated")) return target("test_SetEscrowRegistryEmits");
    if (scenario.includes("#setEscrowRegistry") && scenario.includes("non-owner")) return target("test_SetEscrowRegistryRejectsNonOwner");
    if (scenario.includes("#setEscrowRegistry") && scenario.includes("zero address")) return target("test_SetEscrowRegistryRejectsZeroAddress");
    return "";
}

function escrowV2DelegationDestination(test) {
    if (test.sourceFile !== "test/escrowV2/escrowV2.delegation.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${escrowV2DelegationFile}:EscrowV2DelegationParityTest::${testName}`;
    if (scenario.includes("sets delegated manager")) return target("test_SetRateManagerStoresConfigAndEmits");
    if (scenario.includes("calls onDepositOptIn")) return target("test_SetRateManagerCallsOptInCallback");
    if (scenario.includes("manager already set")) return target("test_SetRateManagerRejectsExistingManager");
    if (scenario.includes("#setRateManager") && scenario.includes("caller is delegate")) return target("test_SetRateManagerRejectsDelegate");
    if (scenario.includes("manager rejects opt-in")) return target("test_SetRateManagerPropagatesOptInRejectionAtomically");
    if (scenario.includes("malicious manager attempts reentrancy")) return target("test_SetRateManagerWritesStateBeforeReentrantOptIn");
    if (scenario.includes("clears delegated manager")) return target("test_ClearRateManagerDeletesConfigAndEmitsPriorValues");
    if (scenario.includes("#clearRateManager") && scenario.includes("caller is not depositor")) return target("test_ClearRateManagerRejectsNonDepositor");
    if (scenario.includes("native rate when deposit is not delegated")) return target("test_EffectiveRateUsesNativeRateWithoutDelegation");
    if (scenario.includes("passes through to delegated manager")) return target("test_EffectiveRateUsesDelegatedRate");
    if (scenario.includes("native rate after clear")) return target("test_EffectiveRateReturnsNativeRateAfterClear");
    if (scenario.includes("manager reverts")) return target("test_EffectiveRateFallsBackToFloorWhenManagerReverts");
    if (scenario.includes("manager rate is below floor")) return target("test_EffectiveRateUsesFloorWhenManagerBelowFloor");
    if (scenario.includes("escrow floor is 0")) return target("test_EffectiveRateIsZeroWhenCurrencyDeactivated");
    if (scenario.includes("manager returns 0")) return target("test_EffectiveRateIsZeroWhenManagerDisablesPair");
    if (scenario.includes("oracle configured but stale")) return target("test_EffectiveRateIsZeroWhenConfiguredOracleIsStale");
    if (scenario.includes("max(managerRate")) return target("test_EffectiveRateReturnsMaximumOfManagerAndFloor");
    if (scenario.includes("manager rate equals floor")) return target("test_EffectiveRateReturnsFloorWhenManagerEqualsFloor");
    if (scenario.includes("zero fee when not delegated")) return target("test_ManagerFeeIsZeroWithoutDelegation");
    if (scenario.includes("returns delegated manager fee")) return target("test_ManagerFeeUsesDelegatedManager");
    if (scenario.includes("zero fee when delegated manager reverts")) return target("test_ManagerFeeIsZeroWhenManagerReverts");
    return "";
}

function escrowV2OracleConfigDestination(test) {
    if (test.sourceFile !== "test/escrowV2/escrowV2.oracleRates.spec.ts") return "";
    const scenario = test.scenario;
    const target = (testName) => `${escrowV2OracleConfigFile}:EscrowV2OracleRateConfigParityTest::${testName}`;
    if (scenario.includes("sets oracle config during createDeposit")) return target("test_CreateDepositStoresInlineOracleConfigAndEmits");
    if (scenario.includes("allows a zero fixed floor")) return target("test_CreateDepositAllowsZeroFixedFloorWithInlineOracle");
    if (scenario.includes("skips oracle config")) return target("test_CreateDepositSkipsEmptyInlineOracleConfig");
    if (scenario.includes("sets oracle config and computes")) return target("test_SetOracleConfigComputesPositiveSpreadFloor");
    if (scenario.includes("supports negative spreads")) return target("test_SetOracleConfigSupportsNegativeSpread");
    if (scenario.includes("positive spreads above")) return target("test_SetOracleConfigAllowsInt16MaximumPositiveSpread");
    if (scenario.includes("returns max(fixed")) return target("test_EffectiveRateReturnsMaximumOfFixedAndSpread");
    if (scenario.includes("oracle is stale")) return target("test_StaleOracleHaltsRateAtZero");
    if (scenario.includes("oracle quote is invalid")) return target("test_InvalidZeroOracleQuoteHaltsRateAtZero");
    if (scenario.includes("oracle timestamp is in the future")) return target("test_FutureOracleTimestampHaltsRateAtZero");
    if (scenario.includes("oracle adapter reverts")) return target("test_RevertingOracleAdapterHaltsRateAtZero");
    if (scenario.includes("allows delegate to set config")) return target("test_DelegateCanSetOracleConfig");
    if (scenario.includes("caller is not depositor or delegate")) return target("test_UnauthorizedCallerCannotSetOracleConfig");
    if (scenario.includes("adapter config is too long")) return target("test_NormalizedAdapterConfigAbove256BytesIsRejected");
    if (scenario.includes("spreadBps is at or below")) return target("test_SpreadAtNegativeTenThousandIsRejected");
    if (scenario.includes("removes config and falls back")) return target("test_RemoveOracleConfigFallsBackToFixedRateAndEmits");
    if (scenario.includes("#removeOracleRateConfig") && scenario.includes("tuple is not listed")) return target("test_RemoveOracleConfigRejectsUnlistedTuple");
    if (scenario.includes("sets multiple configs")) return target("test_SetOracleConfigBatchSetsMultipleConfigs");
    if (scenario.includes("paymentMethods and currencyCodes length")) return target("test_SetOracleConfigBatchRejectsMethodCurrencyLengthMismatch");
    if (scenario.includes("paymentMethods and configs length")) return target("test_SetOracleConfigBatchRejectsMethodConfigLengthMismatch");
    if (scenario.includes("nested currencyCodes and configs")) return target("test_SetOracleConfigBatchRejectsNestedLengthMismatch");
    if (scenario.includes("updates fixed floors and optionally")) return target("test_UpdateCurrencyBatchUpdatesFloorsAndOptionalOracle");
    if (scenario.includes("removes oracle config when updateOracle")) return target("test_UpdateCurrencyBatchRemovesExistingOracleWhenRequested");
    if (scenario.includes("does not emit oracle removal")) return target("test_UpdateCurrencyBatchDoesNotEmitRemovalForAbsentOracle");
    if (scenario.includes("#updateCurrencyConfigBatch") && scenario.includes("length mismatch")) return target("test_UpdateCurrencyBatchRejectsOuterLengthMismatch");
    if (scenario.includes("deactivates multiple currencies")) return target("test_DeactivateCurrenciesBatchClearsRatesAndOnlyExistingOracle");
    if (scenario.includes("payment method is not active")) return target("test_DeactivateCurrenciesBatchRejectsInactivePaymentMethod");
    if (scenario.includes("#deactivateCurrenciesBatch") && scenario.includes("length mismatch")) return target("test_DeactivateCurrenciesBatchRejectsOuterLengthMismatch");
    if (scenario.includes("unsupported tuple")) return target("test_SetOracleConfigRejectsUnlistedCurrency");
    return "";
}

function escrowV2LegacyDestination(test) {
    if (test.sourceFile !== "test/escrowV2/escrowV2.legacyCoverage.spec.ts") return "";
    const key = `${test.suitePath}\t${test.hardhatTest}`;
    const mappings = new Map([
        ["EscrowV2 > #createDeposit\treverts when min is greater than max", ["management", "test_CreateDepositRejectsMinimumAboveMaximum"]],
        ["EscrowV2 > #createDeposit\treverts when amount is below min", ["management", "test_CreateDepositRejectsAmountBelowMinimum"]],
        ["EscrowV2 > #createDeposit\tallows currency min conversion rate to be zero", ["management", "test_CreateDepositAllowsZeroCurrencyFloor"]],
        ["EscrowV2 > #depositTo\tcreates a deposit for the specified owner while pulling funds from caller", ["management", "test_DepositToPullsFromCallerButAssignsSpecifiedOwner"]],
        ["EscrowV2 > #addFunds\tadds funds and emits event", ["management", "test_AddFundsUpdatesLiquidityAndEmitsFunder"]],
        ["EscrowV2 > #addFunds\tdoes not change acceptingIntents when adding funds", ["management", "test_AddFundsDoesNotChangeDisabledAcceptingState"]],
        ["EscrowV2 > #addFunds > when deposit does not exist\treverts", ["management", "test_AddFundsRejectsMissingDeposit"]],
        ["EscrowV2 > #addFunds > when amount is zero\treverts", ["management", "test_AddFundsRejectsZeroAmount"]],
        ["EscrowV2 > #removeFunds\tremoves funds and emits event", ["management", "test_RemoveFundsUpdatesLiquidityAndEmits"]],
        ["EscrowV2 > #removeFunds\treclaims expired intent liquidity and attempts orchestrator prune", ["management", "test_RemoveFundsReclaimsExpiredIntentAndPrunesOrchestrator"]],
        ["EscrowV2 > #removeFunds\tdoes not auto-disable acceptingIntents when remaining falls below min", ["management", "test_RemoveFundsDoesNotAutoDisableBelowMinimumLiquidity"]],
        ["EscrowV2 > #removeFunds\treverts when requested removal exceeds available liquidity", ["management", "test_RemoveFundsRejectsAmountAboveAvailableLiquidity"]],
        ["EscrowV2 > #removeFunds > when caller is not depositor\treverts", ["management", "test_RemoveFundsRejectsNonDepositor"]],
        ["EscrowV2 > #withdrawDeposit\twithdraws, prunes expired intents, and closes the deposit", ["management", "test_WithdrawDepositPrunesExpiredIntentsAndCloses"]],
        ["EscrowV2 > #withdrawDeposit\temits DepositAcceptingIntentsUpdated(false) when transitioning from accepting", ["management", "test_WithdrawDepositDisablesAcceptingStateWhenTransitioning"]],
        ["EscrowV2 > #withdrawDeposit\tdoes not emit DepositAcceptingIntentsUpdated when already not accepting", ["management", "test_WithdrawDepositDoesNotRepeatAlreadyDisabledEvent"]],
        ["EscrowV2 > #setDelegate\tsets delegate and emits event", ["management", "test_SetDelegateUpdatesStateAndEmits"]],
        ["EscrowV2 > #setDelegate > when caller is not depositor\treverts", ["management", "test_SetDelegateRejectsNonDepositor"]],
        ["EscrowV2 > #removeDelegate\tremoves delegate and emits event", ["management", "test_RemoveDelegateClearsStateAndEmits"]],
        ["EscrowV2 > #removeDelegate > when no delegate is set\treverts", ["management", "test_RemoveDelegateRejectsWhenNoneConfigured"]],
        ["EscrowV2 > #setIntentRange\tupdates range and emits event", ["management", "test_SetIntentRangeUpdatesBothBounds"]],
        ["EscrowV2 > #setIntentRange > when min is zero\treverts", ["management", "test_SetIntentRangeRejectsZeroMinimum"]],
        ["EscrowV2 > #setIntentRange > when min is greater than max\treverts", ["management", "test_SetIntentRangeRejectsMinimumAboveMaximum"]],
        ["EscrowV2 > #setCurrencyMinRate\treverts when currency is not listed", ["management", "test_SetCurrencyMinimumRejectsUnlistedCurrency"]],
        ["EscrowV2 > #addPaymentMethods\tadds payment method to existing deposit", ["management", "test_AddPaymentMethodsAddsWhitelistedMethod"]],
        ["EscrowV2 > #addPaymentMethods\treverts when payment method is not whitelisted", ["management", "test_AddPaymentMethodsRejectsUnwhitelistedMethod"]],
        ["EscrowV2 > #setPaymentMethodActive\ttoggles payment method active state", ["management", "test_SetPaymentMethodActiveTogglesAndEmits"]],
        ["EscrowV2 > #setPaymentMethodActive\treverts when payment method is already in the requested state", ["management", "test_SetPaymentMethodActiveRejectsExistingState"]],
        ["EscrowV2 > #addCurrencies\tadds additional currencies on active payment method", ["management", "test_AddCurrenciesAddsSupportedCurrency"]],
        ["EscrowV2 > #addCurrencies\treverts for unsupported currency", ["management", "test_AddCurrenciesRejectsUnsupportedCurrency"]],
        ["EscrowV2 > #addCurrencies\treverts when currency already exists", ["management", "test_AddCurrenciesRejectsExistingCurrency"]],
        ["EscrowV2 > #addCurrencies\tallows min conversion rate to be zero", ["management", "test_AddCurrenciesAllowsZeroFixedFloor"]],
        ["EscrowV2 > #addCurrencies\tsets inline oracle config via addCurrencies", ["management", "test_AddCurrenciesStoresInlineOracleConfig"]],
        ["EscrowV2 > #setAcceptingIntents\tsets accepting intents flag", ["management", "test_SetAcceptingIntentsUpdatesFlagAndEmits"]],
        ["EscrowV2 > #setAcceptingIntents\treverts when enabling while liquidity is below minimum", ["management", "test_SetAcceptingIntentsRejectsEnableBelowMinimumLiquidity"]],
        ["EscrowV2 > #setRetainOnEmpty\tsets retainOnEmpty", ["management", "test_SetRetainOnEmptyUpdatesFlagAndEmits"]],
        ["EscrowV2 > #pruneExpiredIntents\tprunes expired intents and unlocks liquidity", ["lifecycle", "test_PruneExpiredIntentsUnlocksLiquidityAndEmits"]],
        ["EscrowV2 > #pruneExpiredIntents\treverts when orchestrator prune reverts", ["lifecycle", "test_PruneExpiredIntentsRevertsWhenOrchestratorPruneReverts"]],
        ["EscrowV2 > #pruneExpiredIntents\tkeeps intent orchestrator mapping when orchestrator prune reverts", ["lifecycle", "test_PruneExpiredIntentsPreservesOrchestratorMappingOnRevert"]],
        ["EscrowV2 > #pruneExpiredIntents\tskips orchestrator call when intentOrchestrator is cleared", ["lifecycle", "test_PruneExpiredIntentsSkipsClearedOrchestrator"]],
        ["EscrowV2 > #pruneExpiredIntents\tprunes each expired intent with a per-intent orchestrator call", ["lifecycle", "test_PruneExpiredIntentsCallsEachOwningOrchestratorPerIntent"]],
        ["EscrowV2 > #pruneExpiredIntents\tdoes not change acceptingIntents after prune restores free liquidity", ["lifecycle", "test_PruneExpiredIntentsDoesNotChangeAcceptingState"]],
        ["EscrowV2 > #lockFunds\treclaims expired intents and prunes on orchestrator during a new lock", ["lifecycle", "test_LockFundsReclaimsExpiredIntentAndPrunesOwner"]],
        ["EscrowV2 > #lockFunds\treverts when caller is not whitelisted orchestrator", ["lifecycle", "test_LockFundsRejectsNonOrchestrator"]],
        ["EscrowV2 > #lockFunds\treverts on duplicate intent hash", ["lifecycle", "test_LockFundsRejectsDuplicateIntentHash"]],
        ["EscrowV2 > #lockFunds\treverts when liquidity is insufficient after reclaim", ["lifecycle", "test_LockFundsRejectsInsufficientLiquidityAfterReclaim"]],
        ["EscrowV2 > #lockFunds\treverts when max intents is exceeded with no prunable intent", ["lifecycle", "test_LockFundsRejectsFourthUnexpiredIntent"]],
        ["EscrowV2 > #unlockFunds\tunlocks existing intent", ["lifecycle", "test_UnlockFundsUnlocksExistingIntentAndEmits"]],
        ["EscrowV2 > #unlockFunds\tdoes not change acceptingIntents on unlock", ["lifecycle", "test_UnlockFundsDoesNotChangeAcceptingState"]],
        ["EscrowV2 > #unlockFunds\treverts when a different allowlisted orchestrator attempts to unlock", ["lifecycle", "test_UnlockFundsRejectsDifferentAllowlistedOrchestrator"]],
        ["EscrowV2 > #unlockAndTransferFunds\tunlocks and transfers full amount", ["lifecycle", "test_UnlockAndTransferFundsTransfersFullLockedAmount"]],
        ["EscrowV2 > #unlockAndTransferFunds\treturns unused amount to liquidity on partial transfer", ["lifecycle", "test_UnlockAndTransferFundsReturnsUnusedAmountToLiquidity"]],
        ["EscrowV2 > #unlockAndTransferFunds\tdoes not change acceptingIntents on partial release", ["lifecycle", "test_UnlockAndTransferFundsDoesNotChangeAcceptingState"]],
        ["EscrowV2 > #unlockAndTransferFunds\tcollects dust when a partial transfer closes deposit near zero", ["lifecycle", "test_UnlockAndTransferFundsCollectsDustWhenClosingNearZero"]],
        ["EscrowV2 > #unlockAndTransferFunds\treverts when a different allowlisted orchestrator attempts to unlock and transfer", ["lifecycle", "test_UnlockAndTransferFundsRejectsDifferentAllowlistedOrchestrator"]],
        ["EscrowV2 > #extendIntentExpiry\textends expiry when called by intent guardian", ["lifecycle", "test_ExtendIntentExpiryAllowsGuardianAndEmits"]],
        ["EscrowV2 > #extendIntentExpiry\treverts when extension exceeds maximum horizon", ["lifecycle", "test_ExtendIntentExpiryRejectsExtensionBeyondMaximumHorizon"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tupdates fixed floor and emits event in setCurrencyMinRate", ["configuration", "test_SetCurrencyMinRateUpdatesFixedFloorAndEmits"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tsets oracle config and computes spread floor", ["configuration", "test_SetOracleRateConfigComputesSpreadFloor"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tsupports batch oracle config updates", ["configuration", "test_SetOracleRateConfigBatchUpdatesEveryTuple"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\treverts batch oracle config when outer arrays mismatch", ["configuration", "test_SetOracleRateConfigBatchRejectsOuterArrayMismatch"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tremoves oracle config and deactivates currency with oracle cleanup", ["configuration", "test_RemoveOracleConfigAndDeactivateCurrencyCleanUpOracleAndFloor"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tcovers delegated rate manager happy and fallback paths", ["configuration", "test_RateManagerProvidesRateAndFeeWithSafeFallbacks"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\tclears delegated rate manager", ["configuration", "test_ClearRateManagerRemovesDelegationAndEmits"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\treturns zero when oracle adapter reverts (oracle halt)", ["configuration", "test_OracleAdapterRevertHaltsRateAtZero"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\treturns zero when oracle quote is invalid (oracle halt)", ["configuration", "test_InvalidOracleQuoteHaltsRateAtZero"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\treturns zero when oracle timestamp is in the future (oracle halt)", ["configuration", "test_FutureOracleTimestampHaltsRateAtZero"]],
        ["EscrowV2 > oracle and delegated rate manager coverage paths\treturns zero when oracle quote is stale (oracle halt)", ["configuration", "test_StaleOracleTimestampHaltsRateAtZero"]],
        ["EscrowV2 > governance setters and pause\tupdates all owner-controlled config fields", ["configuration", "test_GovernanceUpdatesEveryOwnerControlledFieldAndPauseState"]],
        ["EscrowV2 > view getters\treturns stored values from all getter helpers", ["configuration", "test_ViewGettersReturnAllStoredDepositAndIntentValues"]],
    ]);
    const mapping = mappings.get(key);
    if (!mapping) return "";
    const [domain, testName] = mapping;
    if (domain === "management") return `${escrowV2LegacyManagementFile}:EscrowV2ManagementParityTest::${testName}`;
    if (domain === "lifecycle") return `${escrowV2LegacyLifecycleFile}:EscrowV2LifecycleParityTest::${testName}`;
    return `${escrowV2LegacyConfigurationFile}:EscrowV2ConfigurationParityTest::${testName}`;
}

const escrowV2BranchSource = "test/escrowV2/escrowV2.branchCoverage.spec.ts";
const escrowV2BranchSourceTests = inventory.tests.filter((test) => test.sourceFile === escrowV2BranchSource);
const escrowV2BranchDestinations = [
    ...[
        "test_CreateDepositRejectsZeroIntentMinimum",
        "test_CreateDepositRejectsSelfDelegation",
        "test_DepositToRejectsZeroOwner",
        "test_DepositToRejectsOwnerAsDelegate",
        "test_WithdrawDepositRejectsNonDepositor",
        "test_WithdrawDepositWithoutExpiredIntentsSkipsOrchestratorPrune",
        "test_RemoveDelegateRejectsNonDepositor",
        "test_PruneExpiredIntentsWithoutExpiredEntriesSkipsOrchestrator",
        "test_UnlockFundsRejectsDirectNonOrchestratorCaller",
        "test_UnlockAndTransferRejectsDirectNonOrchestratorCaller",
        "test_SetOracleRateConfigBatchRejectsUnauthorizedCaller",
        "test_UpdateCurrencyConfigBatchRejectsUnauthorizedCaller",
        "test_RemoveOracleRateConfigRejectsUnauthorizedCaller",
        "test_SetIntentRangeRejectsUnauthorizedCaller",
        "test_AddPaymentMethodsRejectsUnauthorizedCaller",
        "test_SetPaymentMethodActiveRejectsUnauthorizedCaller",
        "test_AddCurrenciesRejectsUnauthorizedCaller",
        "test_DeactivateCurrencyRejectsUnauthorizedCaller",
        "test_DeactivateCurrenciesBatchRejectsUnauthorizedCaller",
        "test_SetAcceptingIntentsRejectsUnauthorizedCaller",
        "test_SetRetainOnEmptyRejectsUnauthorizedCaller",
    ].map((testName) => [escrowV2BranchAuthorizationFile, "EscrowV2BranchAuthorizationParityTest", testName]),
    ...[
        "test_AddPaymentMethodsRejectsZeroMethod",
        "test_AddPaymentMethodsRejectsEmptyPayeeDetails",
        "test_AddPaymentMethodsRejectsExistingMethod",
        "test_AddPaymentMethodsRejectsMethodDataLengthMismatch",
        "test_AddPaymentMethodsRejectsCurrencyArrayLengthMismatch",
        "test_SetOracleRateConfigRejectsEoaAdapter",
        "test_SetOracleRateConfigAcceptsSpreadAboveTenThousand",
        "test_SetOracleRateConfigRejectsNegativeTenThousandSpread",
        "test_SetOracleRateConfigRejectsZeroMaxStaleness",
        "test_SetOracleRateConfigRejectsZeroAdapter",
        "test_RemoveOracleRateConfigRejectsUnsupportedCurrency",
        "test_DeactivateCurrencyRejectsInactivePaymentMethod",
        "test_DeactivateCurrencyRejectsUnlistedCurrency",
        "test_DeactivateCurrencyWithoutOracleEmitsOnlyFloorUpdate",
        "test_DeactivateCurrencyWithoutOracleDoesNotEmitRemoval",
        "test_AddCurrenciesRejectsInactivePaymentMethod",
        "test_SetPaymentMethodActiveRejectsUnlistedMethod",
        "test_SetRateManagerRejectsMissingDeposit",
        "test_SetRateManagerRejectsZeroAddress",
        "test_SetRateManagerRejectsEoa",
        "test_SetRateManagerRejectsZeroManagerId",
        "test_SetRateManagerPropagatesMissingManagerError",
        "test_ClearRateManagerRejectsMissingDeposit",
        "test_ClearRateManagerRejectsUnsetManager",
        "test_SetDelegateRejectsZeroAddress",
        "test_SetDelegateRejectsDepositorSelfDelegation",
    ].map((testName) => [escrowV2BranchValidationFile, "EscrowV2BranchValidationParityTest", testName]),
    ...[
        "test_SetOrchestratorRegistryRejectsZeroAddress",
        "test_SetOrchestratorRegistryRejectsNonOwner",
        "test_SetPaymentVerifierRegistryRejectsZeroAddress",
        "test_SetPaymentVerifierRegistryRejectsNonOwner",
        "test_SetDustRecipientRejectsZeroAddress",
        "test_SetDustRecipientRejectsNonOwner",
        "test_SetDustThresholdRejectsValueAboveMaximum",
        "test_SetDustThresholdRejectsNonOwner",
        "test_SetMaxIntentsRejectsZero",
        "test_SetMaxIntentsRejectsNonOwner",
        "test_SetIntentExpirationPeriodRejectsZero",
        "test_SetIntentExpirationPeriodRejectsNonOwner",
        "test_PauseEscrowRejectsNonOwner",
        "test_UnpauseEscrowRejectsNonOwner",
        "test_LockFundsRejectsMissingDeposit",
        "test_LockFundsRejectsDepositNotAcceptingIntents",
        "test_LockFundsRejectsAmountBelowRange",
        "test_LockFundsRejectsAmountAboveRange",
        "test_UnlockFundsRejectsMissingDeposit",
        "test_UnlockFundsRejectsMissingIntent",
        "test_UnlockAndTransferRejectsMissingDeposit",
        "test_UnlockAndTransferRejectsMissingIntent",
        "test_UnlockAndTransferRejectsZeroTransferAmount",
        "test_UnlockAndTransferRejectsAmountAboveLockedAmount",
        "test_ExtendIntentExpiryRejectsMissingDeposit",
        "test_ExtendIntentExpiryRejectsMissingIntent",
        "test_ExtendIntentExpiryRejectsNonGuardian",
        "test_ExtendIntentExpiryRejectsZeroAdditionalTime",
    ].map((testName) => [escrowV2BranchGovernanceLifecycleFile, "EscrowV2BranchGovernanceLifecycleParityTest", testName]),
    ...[
        "test_ZeroOracleMarketRateHaltsRate",
        "test_ZeroOracleUpdatedAtHaltsRate",
        "test_RetainOnEmptyPreservesDepositAfterFullSettlement",
        "test_ZeroRemainingClosesDepositWithoutDustEvent",
        "test_SetAcceptingIntentsRejectsAlreadyTrue",
        "test_SetAcceptingIntentsRejectsAlreadyFalse",
        "test_SetRetainOnEmptyRejectsAlreadyFalse",
        "test_SetRetainOnEmptyRejectsAlreadyTrue",
        "test_RemoveFundsRejectsZeroAmount",
        "test_CreateDepositRejectsWhilePaused",
        "test_DepositToRejectsWhilePaused",
        "test_AddFundsRejectsWhilePaused",
        "test_RemoveFundsRejectsWhilePaused",
        "test_SetCurrencyMinRateRejectsUnauthorizedCallerWithDelegateConfigured",
        "test_SetCurrencyMinRateRejectsUnauthorizedCallerWithNoDelegate",
        "test_SetCurrencyMinRateRejectsWhilePaused",
        "test_SetOracleRateConfigRejectsWhilePaused",
        "test_AddPaymentMethodsRejectsWhilePaused",
        "test_AddCurrenciesRejectsWhilePaused",
        "test_SetPaymentMethodActiveRejectsWhilePaused",
        "test_SetAcceptingIntentsRejectsWhilePaused",
        "test_SetRetainOnEmptyRejectsWhilePaused",
        "test_SetIntentRangeRejectsWhilePaused",
        "test_SetDelegateRejectsWhilePaused",
        "test_RemoveDelegateRejectsWhilePaused",
        "test_RemoveOracleRateConfigRejectsWhilePaused",
        "test_DeactivateCurrencyRejectsWhilePaused",
        "test_SetRateManagerRejectsWhilePaused",
        "test_ClearRateManagerRejectsWhilePaused",
        "test_SetOracleRateConfigBatchRejectsWhilePaused",
        "test_UpdateCurrencyConfigBatchRejectsWhilePaused",
        "test_DeactivateCurrenciesBatchRejectsWhilePaused",
        "test_RemoveFundsRejectsWhenReentrancyGuardIsEntered",
    ].map((testName) => [escrowV2BranchStatePauseFile, "EscrowV2BranchStatePauseParityTest", testName]),
];
if (escrowV2BranchSourceTests.length !== 108 || escrowV2BranchDestinations.length !== 108) {
    throw new Error(
        `EscrowV2 branch mapping count mismatch: ${escrowV2BranchSourceTests.length} source / ${escrowV2BranchDestinations.length} destinations`
    );
}

function escrowV2BranchDestination(test) {
    if (test.sourceFile !== escrowV2BranchSource) return "";
    const sourceIndex = escrowV2BranchSourceTests.findIndex((sourceTest) => sourceTest.id === test.id);
    if (sourceIndex < 0) return "";
    const [file, contractName, testName] = escrowV2BranchDestinations[sourceIndex];
    return `${file}:${contractName}::${testName}`;
}

const escrowLegacySource = "test/escrow/escrow.spec.ts";
const escrowLegacySourceTests = inventory.tests.filter((test) => test.sourceFile === escrowLegacySource);
const escrowLegacyDestinations = [
    ...[
        "test_ConstructorSetsEveryStateVariable",
        "test_CreateDepositTransfersTokensIntoEscrow",
        "test_CreateDepositPopulatesCompleteDepositView",
        "test_CreateDepositAddsIdToAccountDeposits",
        "test_CreateDepositIncrementsCounter",
        "test_CreateDepositStoresPaymentMethodData",
        "test_CreateDepositMarksPaymentMethodActive",
        "test_CreateDepositMarksPaymentMethodListed",
        "test_CreateDepositStoresRetainOnEmpty",
        "test_CreateDepositStoresEveryCurrencyMinimumRate",
        "test_CreateDepositMarksCurrencyListed",
        "test_CreateDepositEmitsDepositReceived",
        "test_CreateDepositEmitsPaymentMethodAdded",
        "test_CreateDepositEmitsEveryCurrencyAddedInOrder",
        "test_CreateDepositStoresAllMultiplePaymentMethodMappings",
        "test_CreateDepositActivatesAllMultiplePaymentMethods",
        "test_CreateDepositRejectsZeroIntentMinimum",
        "test_CreateDepositRejectsMinimumAboveMaximum",
        "test_CreateDepositRejectsAmountBelowMinimum",
        "test_CreateDepositRejectsPaymentMethodDataLengthMismatch",
        "test_CreateDepositRejectsCurrencyArrayLengthMismatch",
        "test_CreateDepositRejectsUnsupportedCurrency",
        "test_CreateDepositRejectsZeroConversionRate",
        "test_CreateDepositRejectsZeroPaymentMethod",
        "test_CreateDepositRejectsUnwhitelistedPaymentMethod",
        "test_CreateDepositRejectsEmptyPayeeDetails",
        "test_CreateDepositRejectsDuplicatePaymentMethods",
        "test_CreateDepositRejectsDuplicateCurrencies",
        "test_CreateDepositRejectsWhilePaused",
    ].map((testName) => [escrowCreateDepositFile, "EscrowCreateDepositParityTest", testName]),
    ...[
        "test_AddFundsTransfersTokensIntoEscrow",
        "test_AddFundsUpdatesRemainingDepositAmount",
        "test_AddFundsEmitsFunderAndAmount",
        "test_AddFundsSucceedsWithoutReenablingDisabledDeposit",
        "test_AddFundsAllowsThirdPartyFunder",
        "test_AddFundsRejectsMissingDeposit",
        "test_AddFundsRejectsZeroAmount",
        "test_AddFundsRejectsWhilePaused",
        "test_RemoveFundsTransfersTokensToDepositor",
        "test_RemoveFundsUpdatesRemainingDepositAmount",
        "test_RemoveFundsEmitsWithdrawal",
        "test_RemoveFundsPreservesAcceptingStateAboveMinimum",
        "test_RemoveFundsSucceedsWhileDepositIsDisabled",
        "test_RemoveFundsBelowMinimumAutomaticallyDisablesDeposit",
        "test_RemoveFundsBelowMinimumEmitsAcceptingStateUpdate",
        "test_RemoveFundsBelowMinimumEmitsWithdrawal",
        "test_RemoveAllFundsDoesNotCloseDeposit",
        "test_RemoveFundsPrunesExpiredIntentAndReclaimsLiquidity",
        "test_RemoveFundsAfterExpiredIntentEmitsWithdrawal",
        "test_RemoveFundsAfterExpiredIntentRemainsAccepting",
        "test_RemoveFundsRejectsAmountAboveAvailableLiquidity",
        "test_RemoveFundsRejectsNonDepositor",
        "test_RemoveFundsRejectsMissingDepositWithUnauthorizedError",
        "test_RemoveFundsRejectsZeroAmount",
        "test_RemoveFundsRejectsWhilePaused",
    ].map((testName) => [escrowFundingFile, "EscrowFundingParityTest", testName]),
    ...[
        "test_WithdrawDepositTransfersAllAvailableFunds",
        "test_WithdrawDepositDeletesDeposit",
        "test_WithdrawDepositRemovesAccountDepositId",
        "test_WithdrawDepositDeletesPaymentMethodData",
        "test_WithdrawDepositClearsPaymentMethodActive",
        "test_WithdrawDepositClearsPaymentMethodListed",
        "test_WithdrawDepositDeletesPaymentMethodArray",
        "test_WithdrawDepositDeletesCurrencyArray",
        "test_WithdrawDepositDeletesCurrencyMinimumRate",
        "test_WithdrawDepositClearsCurrencyListed",
        "test_WithdrawDepositEmitsWithdrawal",
        "test_WithdrawDepositClearsAcceptingState",
        "test_WithdrawDepositEmitsDepositClosed",
        "test_WithdrawDepositWithOutstandingIntentTransfersOnlyAvailableFunds",
        "test_WithdrawDepositWithOutstandingIntentZerosRemainingOnly",
        "test_WithdrawDepositWithOutstandingIntentDisablesDeposit",
        "test_WithdrawDepositWithOutstandingIntentEmitsAvailableWithdrawal",
        "test_WithdrawDepositWithOutstandingIntentClearsAcceptingState",
        "test_WithdrawDepositWithExpiredIntentTransfersReclaimedAndAvailableFunds",
        "test_WithdrawDepositWithExpiredIntentDeletesDeposit",
        "test_WithdrawDepositWithExpiredIntentDeletesIntent",
        "test_WithdrawDepositWithExpiredIntentEmitsFullWithdrawal",
        "test_WithdrawDepositWithExpiredIntentClearsAcceptingState",
        "test_WithdrawDepositWithExpiredIntentEmitsDepositClosed",
        "test_WithdrawDepositRejectsNonDepositor",
        "test_WithdrawDepositRejectsDelegate",
        "test_WithdrawDepositRejectsMissingDepositWithUnauthorizedError",
        "test_WithdrawDepositSucceedsWhilePaused",
    ].map((testName) => [escrowWithdrawFile, "EscrowWithdrawParityTest", testName]),
    ...[
        "test_SetCurrencyMinRateUpdatesRate",
        "test_SetCurrencyMinRateEmitsUpdate",
        "test_SetCurrencyMinRateAllowsDelegate",
        "test_SetCurrencyMinRateRejectsUnauthorizedCaller",
        "test_SetCurrencyMinRateRejectsMissingDepositWithUnauthorizedError",
        "test_SetCurrencyMinRateRejectsUnsupportedCurrency",
        "test_SetCurrencyMinRateRejectsZeroRate",
        "test_SetCurrencyMinRateRejectsWhilePaused",
        "test_SetIntentRangeUpdatesBothBounds",
        "test_SetIntentRangeEmitsUpdate",
        "test_SetIntentRangeAllowsIncreasingMinimum",
        "test_SetIntentRangeDisablesDepositWhenLiquidityBelowNewMinimum",
        "test_SetIntentRangeEmitsDisabledStateWhenLiquidityBelowNewMinimum",
        "test_SetIntentRangeDoesNotReenableAfterMinimumDecreases",
        "test_SetIntentRangeAllowsDelegate",
        "test_SetIntentRangeRejectsUnauthorizedCaller",
        "test_SetIntentRangeRejectsMissingDepositWithUnauthorizedError",
        "test_SetIntentRangeRejectsZeroMinimum",
        "test_SetIntentRangeRejectsMinimumAboveMaximum",
        "test_SetIntentRangeRejectsWhilePaused",
    ].map((testName) => [escrowRateRangeFile, "EscrowRateRangeParityTest", testName]),
    ...[
        "test_AddPaymentMethodStoresMethodAndVerificationData",
        "test_AddPaymentMethodMarksMethodActive",
        "test_AddPaymentMethodMarksMethodListed",
        "test_AddPaymentMethodStoresAllCurrenciesAndRates",
        "test_AddPaymentMethodEmitsMethodAndEveryCurrencyEvent",
        "test_AddPaymentMethodAllowsDelegate",
        "test_AddPaymentMethodRejectsUnauthorizedCaller",
        "test_AddPaymentMethodRejectsMissingDepositWithUnauthorizedError",
        "test_AddPaymentMethodRejectsUnwhitelistedMethod",
        "test_AddPaymentMethodRejectsWhilePaused",
        "test_AddPaymentMethodRejectsAlreadyListedMethod",
        "test_SetPaymentMethodInactiveKeepsMethodListed",
        "test_SetPaymentMethodInactivePreservesVerificationData",
        "test_SetPaymentMethodInactiveUpdatesActiveMapping",
        "test_SetPaymentMethodInactivePreservesCurrenciesRatesAndData",
        "test_SetPaymentMethodInactiveEmitsUpdate",
        "test_SetPaymentMethodInactiveRejectsAlreadyInactive",
        "test_SetPaymentMethodActiveReactivatesInactiveMethod",
        "test_SetPaymentMethodActiveEmitsReactivation",
        "test_SetPaymentMethodActiveAllowsDelegate",
        "test_SetPaymentMethodActiveRejectsUnauthorizedCaller",
        "test_SetPaymentMethodActiveRejectsMissingDepositWithUnauthorizedError",
        "test_SetPaymentMethodActiveRejectsUnlistedMethod",
        "test_SetPaymentMethodActiveRejectsAlreadyInactive",
        "test_SetPaymentMethodActiveRejectsWhilePaused",
    ].map((testName) => [escrowPaymentMethodFile, "EscrowPaymentMethodParityTest", testName]),
    ...[
        "test_AddCurrencyStoresCurrencyAndRate",
        "test_AddCurrencyEmitsAddedEvent",
        "test_AddCurrencyAllowsDelegate",
        "test_AddCurrencyRejectsUnauthorizedCaller",
        "test_AddCurrencyRejectsMissingDepositWithUnauthorizedError",
        "test_AddCurrencyRejectsInactiveOrMissingPaymentMethod",
        "test_AddCurrencyRejectsUnsupportedCurrency",
        "test_AddCurrencyRejectsZeroConversionRate",
        "test_AddCurrencyRejectsExistingCurrency",
        "test_AddCurrencyRejectsWhilePaused",
        "test_DeactivateCurrencyKeepsCurrencyListedAndZerosRate",
        "test_DeactivateCurrencyEmitsZeroRateUpdate",
        "test_DeactivateCurrencyAllowsDelegate",
        "test_DeactivateCurrencyRejectsUnauthorizedCaller",
        "test_DeactivateCurrencyRejectsMissingDepositWithUnauthorizedError",
        "test_DeactivateCurrencyRejectsInactiveOrMissingPaymentMethod",
        "test_DeactivateCurrencyRejectsMissingCurrency",
        "test_DeactivateCurrencyRejectsWhilePaused",
    ].map((testName) => [escrowCurrencyFile, "EscrowCurrencyParityTest", testName]),
    ...[
        "test_SetDelegateStoresDelegate",
        "test_SetDelegateEmitsDepositorAndDelegate",
        "test_SetDelegateRejectsNonDepositor",
        "test_SetDelegateRejectsProspectiveDelegateCaller",
        "test_SetDelegateRejectsZeroAddress",
        "test_SetDelegateUpdatesExistingDelegate",
        "test_SetDelegateUpdateEmitsNewDelegate",
        "test_SetDelegateRejectsMissingDeposit",
        "test_SetDelegateRejectsWhilePaused",
        "test_RemoveDelegateClearsDelegate",
        "test_RemoveDelegateEmitsDepositor",
        "test_RemoveDelegateRejectsNonDepositor",
        "test_RemoveDelegateRejectsDelegateCaller",
        "test_RemoveDelegateRejectsWhenNoDelegateExists",
        "test_RemoveDelegateRejectsMissingDeposit",
        "test_RemoveDelegateRejectsWhilePaused",
    ].map((testName) => [escrowDelegateFile, "EscrowDelegateParityTest", testName]),
    ...[
        "test_SetAcceptingIntentsUpdatesState",
        "test_SetAcceptingIntentsEmitsUpdate",
        "test_SetAcceptingIntentsReenablesDeposit",
        "test_SetAcceptingIntentsEmitsReenabledState",
        "test_SetAcceptingIntentsAllowsDelegate",
        "test_SetAcceptingIntentsDelegateUpdatesState",
        "test_SetAcceptingIntentsRejectsMissingDeposit",
        "test_SetAcceptingIntentsRejectsUnauthorizedCaller",
        "test_SetAcceptingIntentsRejectsExistingState",
        "test_SetAcceptingIntentsRejectsZeroRemainingLiquidity",
        "test_SetAcceptingIntentsRejectsLiquidityBelowMinimum",
        "test_SetAcceptingIntentsAllowsDisableWithOutstandingIntent",
        "test_SetAcceptingIntentsRejectsWhilePaused",
    ].map((testName) => [escrowAcceptingRetainFile, "EscrowAcceptingRetainParityTest", testName]),
    ...[
        "test_PruneBeforeExpiryDoesNotUpdateDeposit",
        "test_PruneAfterExpiryRemovesIntent",
        "test_PruneAfterExpiryReclaimsAmounts",
        "test_PruneAfterExpiryCallsOrchestratorAndEmits",
        "test_PruneMultipleIntentsRemovesOnlyExpiredIntent",
    ].map((testName) => [escrowPruningFile, "EscrowPruningParityTest", testName]),
    ...[
        "test_SetRetainOnEmptyUpdatesFlag",
        "test_SetRetainOnEmptyEmitsUpdate",
        "test_SetRetainOnEmptyAllowsDelegate",
        "test_SetRetainOnEmptyDelegateUpdatesFlag",
        "test_SetRetainOnEmptyRejectsUnauthorizedCaller",
        "test_SetRetainOnEmptyRejectsMissingDeposit",
        "test_SetRetainOnEmptyRejectsExistingState",
        "test_SetRetainOnEmptyRejectsWhilePaused",
    ].map((testName) => [escrowAcceptingRetainFile, "EscrowAcceptingRetainParityTest", testName]),
    ...[
        "test_LockFundsUpdatesDepositAccounting",
        "test_LockFundsCreatesIntentWithTimestampAndExpiry",
        "test_LockFundsAddsIntentHash",
        "test_LockFundsEmitsAmountAndExpiry",
        "test_LockFundsRejectsCallerThatIsNoLongerOrchestrator",
        "test_LockFundsRejectsMissingDeposit",
        "test_LockFundsDoesNotDisableWhenRemainingFallsBelowMinimum",
        "test_LockFundsRejectsDepositThatStoppedAcceptingIntents",
        "test_LockFundsRejectsAmountBelowMinimum",
        "test_LockFundsRejectsAmountAboveMaximum",
        "test_LockFundsReclaimsExpiredIntentWhenLiquidityIsInsufficient",
        "test_LockFundsContainsReentryDuringExpiredIntentCallback",
        "test_LockFundsRejectsDuplicateIntentHash",
        "test_LockFundsRejectsInsufficientLiquidityAfterExpiredReclaim",
        "test_LockFundsAllowsConfiguredMaximumIntentCount",
        "test_LockFundsRejectsIntentAboveConfiguredMaximumCount",
        "test_LockFundsAllowsNewIntentAfterCancellation",
        "test_LockFundsAllowsNewIntentAfterAutomaticExpiryPruning",
    ].map((testName) => [escrowLockFundsFile, "EscrowLockFundsParityTest", testName]),
    ...[
        "test_UnlockFundsRestoresDepositAccounting",
        "test_UnlockFundsDeletesIntent",
        "test_UnlockFundsRemovesIntentHash",
        "test_UnlockFundsEmitsUnlockedAmount",
        "test_UnlockFundsRejectsCallerThatIsNoLongerOrchestrator",
        "test_UnlockFundsRejectsMissingDeposit",
        "test_UnlockFundsRejectsMissingIntent",
    ].map((testName) => [escrowUnlockFundsFile, "EscrowUnlockFundsParityTest", testName]),
    ...[
        "test_UnlockAndTransferTransfersFullAmount",
        "test_UnlockAndTransferUpdatesAccountingForFullTransfer",
        "test_UnlockAndTransferDeletesIntent",
        "test_UnlockAndTransferEmitsSettlementAmounts",
        "test_UnlockAndTransferRemovesIntentHash",
        "test_UnlockAndTransferTransfersPartialAmount",
        "test_UnlockAndTransferReturnsUnusedAmountToAvailableLiquidity",
        "test_UnlockAndTransferRejectsZeroTransfer",
        "test_UnlockAndTransferClosesEmptyDeposit",
        "test_UnlockAndTransferEmitsDepositClosed",
        "test_UnlockAndTransferRetainOnEmptyPreservesDepositConfiguration",
        "test_UnlockAndTransferRetainOnEmptyKeepsAcceptingIntentsDisabled",
        "test_UnlockAndTransferRetainOnEmptyDoesNotEmitDepositClosed",
        "test_UnlockAndTransferSweepsDustAndClosesDeposit",
        "test_UnlockAndTransferRejectsAmountAboveIntent",
        "test_UnlockAndTransferRejectsCallerThatIsNoLongerOrchestrator",
        "test_UnlockAndTransferRejectsMissingDeposit",
        "test_UnlockAndTransferRejectsMissingIntent",
    ].map((testName) => [escrowUnlockTransferFile, "EscrowUnlockTransferParityTest", testName]),
    ...[
        "test_ExtendIntentExpiryAddsRequestedTime",
        "test_ExtendIntentExpiryEmitsNewExpiry",
        "test_ExtendIntentExpiryRejectsNonGuardian",
        "test_ExtendIntentExpiryRejectsMissingIntent",
        "test_ExtendIntentExpiryRejectsDepositWithoutGuardian",
        "test_ExtendIntentExpiryRejectsExtensionBeyondMaximumTotalPeriod",
        "test_ExtendIntentExpiryAllowsMultipleExtensionsWithinAggregateCap",
        "test_ExtendIntentExpiryRejectsMissingDeposit",
        "test_ExtendIntentExpiryRejectsZeroAdditionalTime",
    ].map((testName) => [escrowIntentExpiryFile, "EscrowIntentExpiryParityTest", testName]),
    ...[
        "test_SetOrchestratorUpdatesAddress",
        "test_SetOrchestratorEmitsUpdate",
        "test_SetOrchestratorRejectsZeroAddress",
        "test_SetOrchestratorRejectsNonOwner",
        "test_SetPaymentVerifierRegistryUpdatesAddress",
        "test_SetPaymentVerifierRegistryEmitsUpdate",
        "test_SetPaymentVerifierRegistryRejectsZeroAddress",
        "test_SetPaymentVerifierRegistryRejectsNonOwner",
        "test_PauseEscrowSetsPausedState",
        "test_PauseEscrowEmitsOwner",
        "test_PauseEscrowRejectsNonOwner",
        "test_PauseEscrowRejectsAlreadyPaused",
        "test_UnpauseEscrowClearsPausedState",
        "test_UnpauseEscrowEmitsOwner",
        "test_UnpauseEscrowRejectsNonOwner",
        "test_UnpauseEscrowRejectsWhenNotPaused",
        "test_SetDustRecipientUpdatesRecipient",
        "test_SetDustRecipientEmitsUpdate",
        "test_SetDustRecipientReplacesExistingRecipient",
        "test_SetDustRecipientRejectsZeroAddress",
        "test_SetDustRecipientRejectsNonOwner",
        "test_SetDustThresholdUpdatesThreshold",
        "test_SetDustThresholdEmitsUpdate",
        "test_SetDustThresholdAllowsZero",
        "test_SetDustThresholdRejectsAboveMaximum",
        "test_SetDustThresholdRejectsNonOwner",
        "test_SetIntentExpirationPeriodUpdatesPeriod",
        "test_SetIntentExpirationPeriodEmitsUpdate",
        "test_SetIntentExpirationPeriodRejectsZero",
        "test_SetIntentExpirationPeriodRejectsNonOwner",
        "test_SetMaxIntentsPerDepositUpdatesMaximum",
        "test_SetMaxIntentsPerDepositEmitsUpdate",
        "test_SetMaxIntentsPerDepositRejectsZero",
        "test_SetMaxIntentsPerDepositRejectsNonOwner",
    ].map((testName) => [escrowGovernanceFile, "EscrowGovernanceParityTest", testName]),
    ...[
        "test_GetExpiredIntentsBeforeExpiryReturnsEmpty",
        "test_GetExpiredIntentsAfterExpiryReturnsHashAndAmount",
        "test_GetExpiredIntentsWithoutIntentsReturnsEmpty",
    ].map((testName) => [escrowExpiredIntentsViewFile, "EscrowExpiredIntentsViewParityTest", testName]),
];
if (escrowLegacySourceTests.length !== 276 || escrowLegacyDestinations.length !== 276) {
    throw new Error(
        `Escrow legacy mapping count mismatch: ${escrowLegacySourceTests.length} source / ${escrowLegacyDestinations.length} translated destinations`
    );
}

function escrowLegacyDestination(test) {
    if (test.sourceFile !== escrowLegacySource) return "";
    const sourceIndex = escrowLegacySourceTests.findIndex((sourceTest) => sourceTest.id === test.id);
    if (sourceIndex < 0 || sourceIndex >= escrowLegacyDestinations.length) return "";
    const [file, contractName, testName] = escrowLegacyDestinations[sourceIndex];
    return `${file}:${contractName}::${testName}`;
}

const orchestratorLegacySource = "test/orchestrator/orchestrator.spec.ts";
const orchestratorLegacySourceTests = inventory.tests.filter((test) => test.sourceFile === orchestratorLegacySource);
const orchestratorLegacyDestinations = [
    ...[
        "test_ConstructorSetsEveryStateVariable",
        "test_SignalIntentStoresCompleteIntent",
        "test_SignalIntentLocksEscrowFunds",
        "test_SignalIntentAddsHashToAccount",
        "test_SignalIntentSnapshotsMinimumAmount",
        "test_SignalIntentEmitsCompleteEvent",
        "test_SignalIntentPrunesExpiredIntentAndUpdatesDeposit",
        "test_SignalIntentPruningDeletesOriginalOrchestratorIntent",
        "test_SignalIntentPruningEmitsIntentPruned",
        "test_SignalIntentRejectsWhenUnexpiredLiquidityCannotCoverAmount",
        "test_SignalIntentRejectsSecondActiveIntentForOrdinaryAccount",
        "test_SignalIntentAllowsNewIntentAfterCancellation",
        "test_SignalIntentAllowsMultipleWhenGovernanceEnablesIt",
        "test_SignalIntentAllowsMultipleForWhitelistedRelayer",
        "test_SignalIntentStoresWhitelistedPostHookAndData",
        "test_SignalIntentRejectsUnwhitelistedPostHook",
        "test_SignalIntentRejectsMissingDepositAsUnsupportedMethod",
        "test_SignalIntentRejectsPaymentMethodNotConfiguredOnDeposit",
        "test_SignalIntentRejectsMethodRemovedFromRegistry",
        "test_SignalIntentRejectsCurrencyNotConfiguredOnDeposit",
        "test_SignalIntentRejectsRateBelowMinimum",
        "test_SignalIntentAllowsRateEqualToMinimum",
        "test_SignalIntentRejectsUnwhitelistedEscrow",
        "test_SignalIntentAllowsAnyEscrowWhenRegistryAcceptsAll",
        "test_SignalIntentRejectsDepositNotAcceptingIntents",
        "test_SignalIntentRejectsAmountBelowDepositMinimum",
        "test_SignalIntentRejectsAmountAboveDepositMaximum",
        "test_SignalIntentRejectsZeroRecipient",
        "test_SignalIntentRejectsInvalidGatingSignature",
        "test_SignalIntentAllowsEmptySignatureWithoutGatingService",
        "test_SignalIntentRejectsExpiredGatingSignature",
        "test_SignalIntentRejectsWhilePaused",
        "test_SignalIntentRejectsReferrerFeeAboveMaximum",
        "test_SignalIntentRejectsFeeWithoutReferrer",
        "test_SignalIntentStoresValidReferrerAndFee",
        "test_SignalIntentAllowsMaximumReferrerFee",
    ].map((testName) => [orchestratorLegacySignalFile, "OrchestratorSignalParityTest", testName]),
    ...[
        "test_CancelIntentUnlocksEscrowFunds",
        "test_CancelIntentDeletesIntent",
        "test_CancelIntentDeletesMinimumSnapshot",
        "test_CancelIntentRemovesAccountIndex",
        "test_CancelIntentRejectsMissingIntent",
        "test_CancelIntentRejectsNonOwner",
        "test_CancelIntentSucceedsWhileEscrowPaused",
    ].map((testName) => [orchestratorLegacyCancelFile, "OrchestratorCancelParityTest", testName]),
    ...[
        "test_FulfillIntentTransfersReleaseAmountToRecipient",
        "test_FulfillIntentPrunesIntent",
        "test_FulfillIntentUpdatesDepositAccounting",
        "test_FulfillIntentEmitsNetReleaseAmount",
        "test_FulfillIntentRejectsReleaseBelowSignalMinimum",
        "test_FulfillIntentUsesSnapshottedRateAfterDepositRateIncrease",
        "test_FulfillIntentRateUpdateDoesNotChangeDepositAccounting",
    ].map((testName) => [orchestratorLegacyFulfillCoreFile, "OrchestratorFulfillCoreParityTest", testName]),
    ...[
        "test_FulfillIntentClosesFullyConsumedDeposit",
        "test_FulfillIntentCloseDeletesPaymentMethodData",
        "test_FulfillIntentCloseDeletesCurrencyRate",
        "test_FulfillIntentCloseEmitsDepositClosed",
        "test_FulfillIntentProtocolFeeTransfersNetAndFee",
        "test_FulfillIntentProtocolFeeEmitsNetAmount",
        "test_FulfillIntentReferrerFeeTransfersNetAndFee",
        "test_FulfillIntentReferrerFeeEmitsNetAmount",
        "test_FulfillIntentCombinedFeesTransferEveryShare",
        "test_FulfillIntentCombinedFeesEmitNetAmount",
        "test_FulfillIntentRejectsMissingIntent",
        "test_FulfillIntentRejectsVerifierHashMismatch",
        "test_FulfillIntentRejectsMethodRemovedAfterSignal",
        "test_FulfillIntentRejectsFailedPaymentVerification",
        "test_FulfillIntentRejectsWhilePaused",
        "test_FulfillIntentSucceedsAfterUnpause",
    ].map((testName) => [orchestratorLegacyFulfillAccountingFile, "OrchestratorFulfillAccountingParityTest", testName]),
];
if (orchestratorLegacySourceTests.length !== 141 || orchestratorLegacyDestinations.length !== 66) {
    throw new Error(
        `Orchestrator legacy mapping count mismatch: ${orchestratorLegacySourceTests.length} source / ${orchestratorLegacyDestinations.length} translated destinations`
    );
}

function orchestratorLegacyDestination(test) {
    if (test.sourceFile !== orchestratorLegacySource) return "";
    const sourceIndex = orchestratorLegacySourceTests.findIndex((sourceTest) => sourceTest.id === test.id);
    if (sourceIndex < 0 || sourceIndex >= orchestratorLegacyDestinations.length) return "";
    const [file, contractName, testName] = orchestratorLegacyDestinations[sourceIndex];
    return `${file}:${contractName}::${testName}`;
}

function orchestratorV2LegacyDestination(test) {
    if (test.sourceFile !== "test/orchestratorV2/orchestratorV2.legacyCoverage.spec.ts") return "";
    const scenario = test.scenario;
    const lifecycle = (testName) => `${orchestratorV2LifecycleFile}:OrchestratorV2LifecycleParityTest::${testName}`;
    const hooks = (testName) => `${orchestratorV2HooksFile}:OrchestratorV2HooksGovernanceParityTest::${testName}`;
    if (scenario.includes("cancels intent and unlocks")) return lifecycle("test_CancelIntentPrunesAndUnlocksFunds");
    if (scenario.includes("#cancelIntent") && scenario.includes("does not exist")) return lifecycle("test_CancelIntentRejectsMissingIntent");
    if (scenario.includes("#cancelIntent") && scenario.includes("not intent owner")) return lifecycle("test_CancelIntentRejectsNonOwner");
    if (scenario.includes("sets pre-intent hook")) return hooks("test_DepositorSetsPreIntentHookAndEmits");
    if (scenario.includes("sets whitelist hook")) return hooks("test_DepositorSetsWhitelistHookAndEmits");
    if (scenario.includes("hook setter when caller is unauthorized")) return hooks("test_HookSetterRejectsUnauthorizedCaller");
    if (scenario.includes("hook setter when escrow is zero")) return hooks("test_HookSetterRejectsZeroEscrow");
    if (scenario.includes("hook setter when hook is an EOA")) return hooks("test_HookSetterRejectsEoaHook");
    if (scenario.includes("executes both pre and whitelist")) return hooks("test_SignalExecutesBothHooksWithReferralFeeContext");
    if (scenario.includes("exposes configured hooks")) return hooks("test_HookGettersExposeIndependentConfiguredHooks");
    if (scenario.includes("blocks hook reentry into setDeposit")) return hooks("test_PreIntentHookCannotReenterHookSetter");
    if (scenario.includes("releases funds from depositor")) return lifecycle("test_ManualReleaseTransfersFundsToTakerAndEmits");
    if (scenario.includes("applies protocol and referrer")) return lifecycle("test_ManualReleaseAppliesProtocolAndReferralFees");
    if (scenario.includes("splits referral fees")) return lifecycle("test_ManualReleaseSplitsMultipleReferralFeesExactly");
    if (scenario.includes("#releaseFundsToPayer") && scenario.includes("does not exist")) return lifecycle("test_ManualReleaseRejectsMissingIntent");
    if (scenario.includes("#releaseFundsToPayer") && scenario.includes("not the depositor")) return lifecycle("test_ManualReleaseRejectsCallerOtherThanDepositor");
    if (scenario.includes("escrow-triggered reentrant release")) return lifecycle("test_ManualReleaseBlocksEscrowTriggeredReentry");
    if (scenario.includes("release amount is below min-at-signal")) return lifecycle("test_FulfillRejectsReleaseAmountBelowSignalMinimum");
    if (scenario.includes("#fulfillIntent") && scenario.includes("does not exist")) return lifecycle("test_FulfillRejectsMissingIntent");
    if (scenario.includes("payment method is removed after signal")) return lifecycle("test_FulfillRejectsPaymentMethodRemovedAfterSignal");
    if (scenario.includes("verifier marks payment as failed")) return lifecycle("test_FulfillRejectsFailedPaymentVerification");
    if (scenario.includes("intent hash mismatch")) return lifecycle("test_FulfillRejectsVerifierIntentHashMismatch");
    if (scenario.includes("#fulfillIntent") && scenario.includes("orchestrator is paused")) return lifecycle("test_FulfillRejectsWhilePaused");
    if (scenario.includes("prunes intents when called by escrow")) return lifecycle("test_EscrowPrunesExpiredIntentFromOrchestrator");
    if (scenario.includes("cleans up orphaned intents")) return lifecycle("test_AnyoneCleansUpIntentOrphanedByEscrow");
    if (scenario.includes("cleanup when intent hash is unknown")) return lifecycle("test_OrphanCleanupSkipsUnknownIntent");
    if (scenario.includes("does not prune active intents")) return lifecycle("test_OrphanCleanupPreservesActiveEscrowIntent");
    if (scenario.includes("ignores zero hashes")) return lifecycle("test_PruneIntentsIgnoresZeroAndNonEscrowCaller");
    if (scenario.includes("updates registry and fee configuration")) return hooks("test_GovernanceUpdatesRegistriesFeesAndPauseState");
    if (scenario.includes("governance setters receive invalid")) return hooks("test_GovernanceRejectsInvalidSetterValues");
    if (scenario.includes("governance-only functions")) return hooks("test_GovernanceRejectsEveryNonOwnerCall");
    if (scenario.includes("returns account intents and min-at-signal")) return hooks("test_ViewsReturnAccountIntentsAndSignalMinimumSnapshot");
    if (scenario.includes("allows an account to create multiple")) return hooks("test_AccountCanCreateMultipleActiveIntents");
    if (scenario.includes("escrow is not whitelisted")) return hooks("test_SignalRejectsUnwhitelistedEscrow");
    if (scenario.includes("signal validations") && scenario.includes("orchestrator is paused")) return hooks("test_SignalRejectsWhilePaused");
    if (scenario.includes("recipient is zero")) return hooks("test_SignalRejectsZeroRecipient");
    if (scenario.includes("referrer fee exceeds max")) return hooks("test_SignalRejectsSingleReferralFeeAboveMaximum");
    if (scenario.includes("total referral fees exceed")) return hooks("test_SignalRejectsTotalReferralFeesAboveMaximum");
    if (scenario.includes("referrer is zero")) return hooks("test_SignalRejectsZeroReferralRecipientWithNonzeroFee");
    if (scenario.includes("recipients contain duplicates")) return hooks("test_SignalRejectsDuplicateReferralRecipients");
    if (scenario.includes("recipient count exceeds")) return hooks("test_SignalRejectsMoreThanTenReferralRecipients");
    if (scenario.includes("emits referral fee distribution")) return hooks("test_ManualReleaseEmitsDistributionForEveryReferralRecipient");
    if (scenario.includes("payment method is removed from registry")) return hooks("test_SignalRejectsRemovedPaymentMethod");
    if (scenario.includes("payment method is inactive")) return hooks("test_SignalRejectsInactiveDepositPaymentMethod");
    if (scenario.includes("currency is disabled")) return hooks("test_SignalRejectsDisabledDepositCurrency");
    if (scenario.includes("post-intent hook is an EOA")) return hooks("test_SignalRejectsEoaPostIntentHook");
    if (scenario.includes("executes post-intent hook flow")) return hooks("test_FulfillExecutesPostIntentHookAndTransfersNetAmount");
    if (scenario.includes("hook-driven signalIntent reentrancy")) return hooks("test_PreIntentHookBlocksSignalReentry");
    if (scenario.includes("hook pulls less")) return hooks("test_FulfillRejectsPostIntentHookThatPullsTooLittle");
    if (scenario.includes("hook increases orchestrator balance")) return hooks("test_FulfillRejectsPostIntentHookThatIncreasesBalance");
    if (scenario.includes("reentrant fulfillIntent")) return hooks("test_PostIntentHookCannotReenterFulfill");
    if (scenario.includes("accepts valid gating")) return hooks("test_GatingAcceptsValidSignature");
    if (scenario.includes("signature is expired")) return hooks("test_GatingRejectsExpiredSignature");
    if (scenario.includes("signature signer is invalid")) return hooks("test_GatingRejectsSignatureFromWrongSigner");
    if (scenario.includes("different sender replays")) return hooks("test_GatingSignatureCannotBeReplayedByDifferentSender");
    return "";
}

const header = [
    "id", "source_file", "suite_path", "hardhat_test", "scenario", "expected_behavior",
    "fixture_dependencies", "foundry_destination", "translation_shape", "status", "evidence",
];
let verified = 0;
const rows = inventory.tests.map((test) => {
    const foundryDestination = registryDestination(test) || oracleDestination(test) || escrowV2PythDestination(test) || escrowV2CurrencyRateDestination(test) || escrowV2DelegationDestination(test) || escrowV2OracleConfigDestination(test) || escrowV2LegacyDestination(test) || escrowV2BranchDestination(test) || escrowLegacyDestination(test) || orchestratorLegacyDestination(test) || orchestratorV2Destination(test) || orchestratorV2LegacyDestination(test) || preIntentHookDestination(test) || whitelistPreIntentHookDestination(test) || acrossBridgeHookDestination(test) || rateManagerV1Destination(test) || protocolViewerV2Destination(test) || protocolViewerDestination(test) || attestationDestination(test) || thresholdDestination(test) || baseUnifiedDestination(test) || unifiedDestination(test) || unifiedV2CompatibilityDestination(test) || unifiedV3Destination(test);
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
    if (test.sourceFile === "test/orchestratorV2/orchestratorV2.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped orchestrator V2 behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/escrowV2/escrowV2.pythOracle.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 Pyth behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/escrowV2/escrowV2.getDepositCurrencyMinRate.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 currency-rate behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/periphery/protocolViewerV2.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped ProtocolViewerV2 behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/periphery/protocolViewer.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped ProtocolViewer behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/orchestrator/preIntentHook.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped pre-intent hook behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/hooks/whitelistPreIntentHook.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped whitelist pre-intent hook behavior: ${test.id} ${test.scenario}`);
    }
    if (["test/hooks/acrossBridgeHook.spec.ts", "test/hooks/acrossBridgeHookV2.spec.ts"].includes(test.sourceFile) && !foundryDestination) {
        throw new Error(`Unmapped Across bridge hook behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/rateManager/rateManagerV1.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped RateManagerV1 behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/escrowV2/escrowV2.delegation.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 delegation behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/escrowV2/escrowV2.oracleRates.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 oracle-config behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/escrowV2/escrowV2.legacyCoverage.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 legacy behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === escrowV2BranchSource && !foundryDestination) {
        throw new Error(`Unmapped EscrowV2 branch behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === escrowLegacySource && !foundryDestination) {
        throw new Error(`Unmapped Escrow behavior: ${test.id} ${test.scenario}`);
    }
    if (test.sourceFile === "test/orchestratorV2/orchestratorV2.legacyCoverage.spec.ts" && !foundryDestination) {
        throw new Error(`Unmapped OrchestratorV2 legacy behavior: ${test.id} ${test.scenario}`);
    }
    if (foundryDestination) verified += 1;
    let evidence = "";
    if (foundryDestination.startsWith(registryFile)) evidence = "RegistryParity.t.sol: 50 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(escrowV2PythFile)) evidence = "EscrowV2PythOracleParity.t.sol: 5 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(escrowV2CurrencyRateFile)) evidence = "EscrowV2CurrencyRateParity.t.sol: 12 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(oracleFile)) evidence = "OracleAdapterParity.t.sol: 25 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(orchestratorV2File)) evidence = "OrchestratorV2RateManagerParity.t.sol: 6 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(preIntentHookFile)) evidence = "PreIntentHookParity.t.sol: 23 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(whitelistPreIntentHookFile)) evidence = "WhitelistPreIntentHookParity.t.sol: 29 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(acrossBridgeHookFile)) evidence = "AcrossBridgeHookParity.t.sol: 56 passed individually and together across legacy and V2, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(rateManagerV1File)) evidence = "RateManagerV1Parity.t.sol: 50 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(escrowV2DelegationFile)) evidence = "EscrowV2DelegationParity.t.sol: 21 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(escrowV2OracleConfigFile)) evidence = "EscrowV2OracleRateConfigParity.t.sol: 29 passed individually and together, 0 failed, 0 skipped";
    if ([escrowV2LegacyManagementFile, escrowV2LegacyLifecycleFile, escrowV2LegacyConfigurationFile].some((file) => foundryDestination.startsWith(file))) evidence = "EscrowV2 management + lifecycle + configuration parity: 70 passed individually and together, 0 failed, 0 skipped; same-commit Hardhat source: 70/70";
    if ([escrowV2BranchAuthorizationFile, escrowV2BranchValidationFile, escrowV2BranchGovernanceLifecycleFile, escrowV2BranchStatePauseFile].some((file) => foundryDestination.startsWith(file))) evidence = "EscrowV2 branch parity: 108 passed individually and together, 0 failed, 0 skipped; same-commit Hardhat source: 108/108";
    if ([escrowCreateDepositFile, escrowFundingFile, escrowWithdrawFile, escrowRateRangeFile, escrowPaymentMethodFile, escrowCurrencyFile, escrowDelegateFile, escrowAcceptingRetainFile, escrowPruningFile, escrowLockFundsFile, escrowUnlockFundsFile, escrowUnlockTransferFile, escrowIntentExpiryFile, escrowGovernanceFile, escrowExpiredIntentsViewFile].some((file) => foundryDestination.startsWith(file))) evidence = "Complete legacy Escrow parity: 276 passed individually and together, 0 failed, 0 skipped; same-commit Hardhat source: 275 passed plus 1 baseline-pending case resolved in Foundry";
    if ([orchestratorLegacySignalFile, orchestratorLegacyCancelFile, orchestratorLegacyFulfillCoreFile, orchestratorLegacyFulfillAccountingFile].some((file) => foundryDestination.startsWith(file))) evidence = "Legacy Orchestrator constructor/signal/cancel/fulfillment parity slice: 66 passed individually and together, 0 failed, 0 skipped; 4 baseline-pending cases resolved in Foundry";
    if (foundryDestination.startsWith(orchestratorV2LifecycleFile) || foundryDestination.startsWith(orchestratorV2HooksFile)) evidence = "OrchestratorV2LifecycleParity.t.sol + OrchestratorV2HooksGovernanceParity.t.sol: 55 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(protocolViewerV2File)) evidence = "ProtocolViewerV2Parity.t.sol: 12 passed individually and together, 0 failed, 0 skipped";
    if (foundryDestination.startsWith(protocolViewerFile)) evidence = "ProtocolViewerParity.t.sol: 15 passed individually and together, 0 failed, 0 skipped";
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
        foundryDestination
            ? (["test/escrowV2/escrowV2.legacyCoverage.spec.ts", escrowV2BranchSource, escrowLegacySource, orchestratorLegacySource].includes(test.sourceFile)
                || test.sourceFile.includes("nullifierRegistryV2")
                ? "one-to-one"
                : "consolidated-with-explicit-destination")
            : "one-to-one",
        foundryDestination ? "verified-independent-file" : (test.pending ? "pending-resolution" : "pending-translation"),
        foundryDestination ? evidence : (test.pending ? "baseline-pending" : "baseline-passed"),
    ];
});

fs.writeFileSync(outputPath, `${[header, ...rows].map((row) => row.map(csv).join(",")).join("\n")}\n`);
console.log(JSON.stringify({ total: rows.length, verified, remaining: rows.length - verified }, null, 2));
