# Upstream parity delta after standalone OrchestratorV3

This addendum mechanically reconciles the Hardhat behavior changes introduced by
`f6fd7aa4b475ea0045cddabe245c26584b960000` (`refactor: inline OrchestratorV2 lifecycle into standalone OrchestratorV3 (#193)`) after the original 1,517-row Hardhat oracle had been translated and removed. The prior rebased base was `845f8a077404a3c000e723265288f83be65194c7`.

The upstream diff adds 61 named OrchestratorV3 behaviors, replaces three named V2/deployment behaviors, and strengthens three existing V2 governance behaviors. All 67 impacted behaviors have executable deterministic destinations below; zero are omitted. The standalone V3 contracts execute 66 tests because five additional branch assertions are retained beyond the 61 upstream V3 source rows.

## New `test/orchestratorV3/orchestratorV3.spec.ts` behaviors

| Upstream suite / behavior | Foundry destination in `OrchestratorV3StandaloneParity.t.sol` |
| --- | --- |
| `#signalIntent` — uses EscrowV2 delegated effective rate and snapshots manager fee | `OrchestratorV3RateManagerParityTest.test_SignalUsesDelegatedRateAndSnapshotsManagerFee` |
| `#signalIntent` — allows an ordinary account to keep multiple concurrent intents | `OrchestratorV3RateManagerParityTest.test_GovernanceCanAllowOrdinaryAccountMultipleConcurrentIntents` |
| `#signalIntent` — does not expose retired relayer or global multiple-intent controls | `OrchestratorV3RateManagerParityTest.test_WhitelistedRelayerCanKeepMultipleIntentsWhenGlobalMultipleDisabled` |
| `#signalIntent / when conversion rate is below delegated manager rate` — reverts with RateBelowMinimum | `OrchestratorV3RateManagerParityTest.test_SignalRejectsConversionRateBelowDelegatedRate` |
| `#signalIntent / when delegated manager fee exceeds orchestrator max` — reverts with FeeExceedsMaximum | `OrchestratorV3RateManagerParityTest.test_SignalRejectsDelegatedManagerFeeAboveMaximum` |
| `#fulfillIntent` — deducts manager fee and transfers net amount | `OrchestratorV3RateManagerParityTest.test_FulfillDeductsManagerFeeAndTransfersNetAmount` |

## New `test/orchestratorV3/orchestratorV3.legacyCoverage.spec.ts` behaviors

| Upstream suite / behavior | Foundry destination in `OrchestratorV3StandaloneParity.t.sol` |
| --- | --- |
| `#cancelIntent` — cancels intent and unlocks escrow funds | `OrchestratorV3LifecycleParityTest.test_CancelIntentPrunesAndUnlocksFunds` |
| `#cancelIntent` — reverts when intent does not exist | `OrchestratorV3LifecycleParityTest.test_CancelIntentRejectsMissingIntent` |
| `#cancelIntent` — reverts when caller is not intent owner | `OrchestratorV3LifecycleParityTest.test_CancelIntentRejectsNonOwner` |
| hook setters and execution — sets pre-intent hook | `OrchestratorV3HooksGovernanceParityTest.test_DepositorSetsPreIntentHookAndEmits` |
| hook setters and execution — sets whitelist hook | `OrchestratorV3HooksGovernanceParityTest.test_DepositorSetsWhitelistHookAndEmits` |
| hook setters and execution — reverts hook setter when caller is unauthorized | `OrchestratorV3HooksGovernanceParityTest.test_HookSetterRejectsUnauthorizedCaller` |
| hook setters and execution — reverts hook setter when escrow is zero | `OrchestratorV3HooksGovernanceParityTest.test_HookSetterRejectsZeroEscrow` |
| hook setters and execution — reverts hook setter when hook is an EOA | `OrchestratorV3HooksGovernanceParityTest.test_HookSetterRejectsEoaHook` |
| hook setters and execution — executes both pre and whitelist hooks during signalIntent | `OrchestratorV3HooksGovernanceParityTest.test_SignalExecutesBothHooksWithReferralFeeContext` |
| hook setters and execution — exposes configured hooks via getters | `OrchestratorV3HooksGovernanceParityTest.test_HookGettersExposeIndependentConfiguredHooks` |
| hook setters and execution — blocks hook reentry into setDepositPreIntentHook via nonReentrant | `OrchestratorV3HooksGovernanceParityTest.test_PreIntentHookCannotReenterHookSetter` |
| `#releaseFundsToPayer` — releases funds from depositor to taker | `OrchestratorV3LifecycleParityTest.test_ManualReleaseTransfersFundsToTakerAndEmits` |
| `#releaseFundsToPayer` — applies protocol and referrer fees on manual release | `OrchestratorV3LifecycleParityTest.test_ManualReleaseAppliesProtocolAndReferralFees` |
| `#releaseFundsToPayer` — splits referral fees across multiple recipients on manual release | `OrchestratorV3LifecycleParityTest.test_ManualReleaseSplitsMultipleReferralFeesExactly` |
| `#releaseFundsToPayer` — reverts when intent does not exist | `OrchestratorV3LifecycleParityTest.test_ManualReleaseRejectsMissingIntent` |
| `#releaseFundsToPayer` — reverts when caller is not the depositor | `OrchestratorV3LifecycleParityTest.test_ManualReleaseRejectsCallerOtherThanDepositor` |
| `#releaseFundsToPayer` — blocks escrow-triggered reentrant release calls | `OrchestratorV3LifecycleParityTest.test_ManualReleaseBlocksEscrowTriggeredReentry` |
| `#fulfillIntent` — reverts when verifier release amount is below min-at-signal | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsReleaseAmountBelowSignalMinimum` |
| `#fulfillIntent` — reverts when intent does not exist | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsMissingIntent` |
| `#fulfillIntent` — reverts when payment method is removed after signal | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsPaymentMethodRemovedAfterSignal` |
| `#fulfillIntent` — reverts when verifier marks payment as failed | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsFailedPaymentVerification` |
| `#fulfillIntent` — reverts on intent hash mismatch in verifier result | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsVerifierIntentHashMismatch` |
| `#fulfillIntent` — reverts when orchestrator is paused | `OrchestratorV3LifecycleParityTest.test_FulfillRejectsWhilePaused` |
| pruning paths — prunes intents when called by escrow | `OrchestratorV3LifecycleParityTest.test_EscrowPrunesExpiredIntentFromOrchestrator` |
| pruning paths — cleans up orphaned intents | `OrchestratorV3LifecycleParityTest.test_AnyoneCleansUpIntentOrphanedByEscrow` |
| pruning paths — skips cleanup when intent hash is unknown | `OrchestratorV3LifecycleParityTest.test_OrphanCleanupSkipsUnknownIntent` |
| pruning paths — does not prune active intents during orphan cleanup | `OrchestratorV3LifecycleParityTest.test_OrphanCleanupPreservesActiveEscrowIntent` |
| pruning paths — ignores zero hashes and non-escrow callers in pruneIntents | `OrchestratorV3LifecycleParityTest.test_PruneIntentsIgnoresZeroAndNonEscrowCaller` |
| governance and views — updates registry and fee configuration | `OrchestratorV3HooksGovernanceParityTest.test_GovernanceUpdatesRegistriesFeesAndPauseState` |
| governance and views — reverts when governance setters receive invalid values | `OrchestratorV3HooksGovernanceParityTest.test_GovernanceRejectsInvalidSetterValues` |
| governance and views — reverts governance-only functions for non-owner callers | `OrchestratorV3HooksGovernanceParityTest.test_GovernanceRejectsEveryNonOwnerCall` |
| governance and views — returns account intents and min-at-signal snapshot | `OrchestratorV3HooksGovernanceParityTest.test_ViewsReturnAccountIntentsAndSignalMinimumSnapshot` |
| signal validations and post-intent hook path — allows an account to create multiple active intents | `OrchestratorV3HooksGovernanceParityTest.test_AccountWithActiveIntentRevertsWhenMultipleIntentsDisabled` (V3 override asserts two live intents) |
| signal validations and post-intent hook path — reverts when escrow is not whitelisted | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsUnwhitelistedEscrow` |
| signal validations and post-intent hook path — reverts when orchestrator is paused | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsWhilePaused` |
| signal validations and post-intent hook path — reverts when recipient is zero | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsZeroRecipient` |
| signal validations and post-intent hook path — reverts when referrer fee exceeds max | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsSingleReferralFeeAboveMaximum` |
| signal validations and post-intent hook path — reverts when total referral fees exceed max | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsTotalReferralFeesAboveMaximum` |
| signal validations and post-intent hook path — reverts when referrer is zero and fee is non-zero | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsZeroReferralRecipientWithNonzeroFee` |
| signal validations and post-intent hook path — reverts when referral fee recipients contain duplicates | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsDuplicateReferralRecipients` |
| signal validations and post-intent hook path — reverts when referral fee recipient count exceeds max | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsMoreThanTenReferralRecipients` |
| signal validations and post-intent hook path — emits referral fee distribution events for each recipient on manual release | `OrchestratorV3HooksGovernanceParityTest.test_ManualReleaseEmitsDistributionForEveryReferralRecipient` |
| signal validations and post-intent hook path — reverts when payment method is removed from registry | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsRemovedPaymentMethod` |
| signal validations and post-intent hook path — reverts when payment method is inactive on deposit | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsInactiveDepositPaymentMethod` |
| signal validations and post-intent hook path — reverts when currency is disabled on deposit | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsDisabledDepositCurrency` |
| signal validations and post-intent hook path — reverts when post-intent hook is an EOA | `OrchestratorV3HooksGovernanceParityTest.test_SignalRejectsEoaPostIntentHook` |
| signal validations and post-intent hook path — executes post-intent hook flow on fulfill | `OrchestratorV3HooksGovernanceParityTest.test_FulfillExecutesPostIntentHookAndTransfersNetAmount` |
| signal validations and post-intent hook path — blocks hook-driven signalIntent reentrancy | `OrchestratorV3HooksGovernanceParityTest.test_PreIntentHookBlocksSignalReentry` |
| signal validations and post-intent hook path — reverts when post-intent hook pulls less than net amount | `OrchestratorV3HooksGovernanceParityTest.test_FulfillRejectsPostIntentHookThatPullsTooLittle` |
| signal validations and post-intent hook path — reverts when post-intent hook increases orchestrator balance | `OrchestratorV3HooksGovernanceParityTest.test_FulfillRejectsPostIntentHookThatIncreasesBalance` |
| signal validations and post-intent hook path — blocks reentrant fulfillIntent calls from post-intent hook | `OrchestratorV3HooksGovernanceParityTest.test_PostIntentHookCannotReenterFulfill` |
| gating signature validation — accepts valid gating service signature | `OrchestratorV3HooksGovernanceParityTest.test_GatingAcceptsValidSignature` |
| gating signature validation — reverts when signature is expired | `OrchestratorV3HooksGovernanceParityTest.test_GatingRejectsExpiredSignature` |
| gating signature validation — reverts when signature signer is invalid | `OrchestratorV3HooksGovernanceParityTest.test_GatingRejectsSignatureFromWrongSigner` |
| gating signature validation — reverts when a different sender replays a valid gating signature | `OrchestratorV3HooksGovernanceParityTest.test_GatingSignatureCannotBeReplayedByDifferentSender` |

## Replaced V2 and deployment behaviors

| Upstream source / current behavior | Foundry destination |
| --- | --- |
| `test/deploy/14_v2System.spec.ts` — should have the correct relayer registry | `V2SystemDeploymentParityTest.test_OrchestratorV2DeploymentWiresRelayerRegistry` |
| `test/orchestrator/preIntentHook.spec.ts` — prevents hook-driven reentrant signalIntent from bypassing one-active-intent rule | `PreIntentHookParityTest.test_ReentrantHookCannotCreateSecondIntent` |
| `test/orchestratorV2/orchestratorV2.legacyCoverage.spec.ts` — reverts when account already has an active intent | `OrchestratorV2HooksGovernanceParityTest.test_AccountWithActiveIntentRevertsWhenMultipleIntentsDisabled` |

Three existing V2 governance rows also gained assertions without changing their names:

| Upstream source / strengthened behavior | Foundry destination |
| --- | --- |
| governance updates now emit and persist `AllowMultipleIntentsUpdated` and `RelayerRegistryUpdated` | `OrchestratorV2HooksGovernanceParityTest.test_GovernanceUpdatesRegistriesFeesAndPauseState` |
| invalid governance values now reject a zero relayer registry | `OrchestratorV2HooksGovernanceParityTest.test_GovernanceRejectsInvalidSetterValues` |
| non-owner governance rejection now includes both multiple-intent and relayer-registry setters | `OrchestratorV2HooksGovernanceParityTest.test_GovernanceRejectsEveryNonOwnerCall` |

The superseded deployment assertion that V2 had no relayer getter and the superseded V2 assertion that ordinary accounts could always create multiple active intents are deliberately not retained as V2 expectations: `f6fd7aa` restored the relayer registry and one-active-intent gate to V2. Their semantics remain explicitly asserted for standalone V3 by the two V3 multiple-intent tests and retired-selector test above. The renamed pre-intent reentry behavior is strengthened by explicitly disabling global multiple intents before triggering hook reentry.

## Additive V3 checks

The 61 upstream V3 rows execute alongside five V3-only assertions that receive no parity-row credit:

- a second multiple-intent assertion in the delegated-rate topology;
- zero-protocol-fee fulfillment transfers the entire release amount;
- the whitelist-hook setter reentrancy branch;
- the accept-all escrow-registry branch; and
- rejection of a nonzero referral recipient paired with a zero fee.

The V3 fixture deploys the real standalone `OrchestratorV3`, recreates its registry/verifier topology, and reuses only ABI-compatible test setup and assertions that are independently executed against the new address. No V2 contract instance supplies V3 parity credit.
