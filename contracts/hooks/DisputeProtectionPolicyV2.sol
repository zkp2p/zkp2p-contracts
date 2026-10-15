// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVault} from "../interfaces/IStakeVault.sol";

/**
 * @title DisputeProtectionPolicyV2
 * @notice Selects existing stake or deferred payout collateral at settlement.
 * @dev Deferred payouts are stake locks funded by the payout. The token must have no transfer callbacks
 * (canonical USDC only). StakeVault owns collateral accounting; the dedicated dispute registry owns replay state.
 * TRUST: Registered orchestrators must invoke callbacks only for their own validated intents and escrows.
 * Settlement uses the depositor and token captured before escrow unlock; this policy never reads escrow.
 * Intent hashes must embed the originating orchestrator so identities cannot collide. Governance must keep
 * predecessor hooks authorized and orchestrators registered until their snapshotted intents drain, and drain
 * active locks before moving vault control unless the successor explicitly adopts their state.
 * Protection applies only to stake-token deposits with a nonzero attested window supplied by the hook.
 * There are no per-method windows or paused admissions. Whitelisted takers, manual releases and zero
 * windows settle in the hook without any policy call or event. Non-stake tokens return without a record
 * or event. Protected settlements lock gross stake or defer the net payout until now plus the attested
 * window; only these STAKE and DEFERRED_PAYOUT settlements emit DisputeProtectionIntentSettled.
 */
contract DisputeProtectionPolicyV2 is IDisputeProtectionPolicyV2, Ownable2Step, ReentrancyGuard {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 180 days;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVault public immutable override stakeVault;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @dev Lifecycle-hook authorization keyed by lifecycle hook address.
    mapping(address => bool) internal isLifecycleHookAuthorizedByHook;

    /// @dev Dispute protection lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => DisputeProtectionIntent) internal disputeProtectionIntentByIntentHash;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a dispute protection policy over one StakeVault and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as the StakeVault controller and as a writer on the dedicated
     * dispute nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     */
    constructor(
        address _owner,
        IStakeVault _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_disputeVerifier));
        _validateDependency(address(_disputeNullifierRegistry));

        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyLifecycleHook() {
        if (!isLifecycleHookAuthorizedByHook[msg.sender]) {
            revert UnauthorizedLifecycleHook(msg.sender);
        }
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /// @inheritdoc IDisputeProtectionPolicyV2
    function onIntentSettled(SettleParams calldata _params)
        external override onlyLifecycleHook returns (bool deferred)
    {
        if (_params.token != address(stakeVault.stakeToken())) return false;
        uint64 riskWindow = _params.riskWindow;
        if (riskWindow > MAX_RISK_WINDOW) revert InvalidRiskWindow(riskWindow);
        if (riskWindow == 0) return false;
        if (disputeProtectionIntentByIntentHash[_params.intentHash].status != DisputeProtectionIntentStatus.NONE) {
            revert DisputeProtectionIntentAlreadyExists(_params.intentHash);
        }
        if (_params.releaseAmount == 0 || _params.netAmount == 0) {
            revert InvalidSettlementAmount(_params.releaseAmount, _params.netAmount);
        }
        return _settleProtectedIntent(_params);
    }

    /// @dev Apply the reentrancy guard only to protected settlements that change state.
    function _settleProtectedIntent(SettleParams calldata _params) internal nonReentrant returns (bool deferred) {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_params.intentHash];
        intent.taker = _params.taker;
        intent.recipient = _params.recipient;
        intent.depositor = _params.depositor;
        intent.paymentMethod = _params.paymentMethod;
        intent.riskWindow = _params.riskWindow;
        intent.releaseAmount = _params.releaseAmount;
        intent.releaseEligibleAt = _calculateReleaseEligibleAt(_params.riskWindow);
        address stakeOwner = stakeVault.stakeOwnerOf(_params.taker);
        if (stakeVault.freeStake(stakeOwner) >= _params.releaseAmount) {
            intent.collateralSource = CollateralSource.STAKE;
            intent.stakeOwner = stakeOwner;
            intent.lockedAmount = _params.releaseAmount;
            intent.status = DisputeProtectionIntentStatus.SETTLED;
            stakeVault.lockStake(stakeOwner, _params.intentHash, _params.releaseAmount, intent.releaseEligibleAt);
        } else {
            intent.collateralSource = CollateralSource.DEFERRED_PAYOUT;
            intent.stakeOwner = _params.recipient;
            intent.lockedAmount = _params.netAmount;
            intent.status = DisputeProtectionIntentStatus.AWAITING_FUNDING;
            deferred = true;
        }
        emit DisputeProtectionIntentSettled(
            _params.intentHash, intent.taker, intent.depositor, intent.recipient, intent.paymentMethod,
            _params.riskWindow, intent.collateralSource, intent.stakeOwner, _params.releaseAmount,
            intent.lockedAmount, intent.releaseEligibleAt
        );
    }

    /// @inheritdoc IDisputeProtectionPolicyV2
    function onDeferredPayoutFunded(bytes32 _intentHash) external override onlyLifecycleHook nonReentrant {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.status != DisputeProtectionIntentStatus.AWAITING_FUNDING) {
            revert UnexpectedStatus(_intentHash, intent.status);
        }
        stakeVault.fundLock(intent.recipient, _intentHash, intent.lockedAmount, intent.releaseEligibleAt);
        intent.status = DisputeProtectionIntentStatus.SETTLED;
        emit DeferredPayoutFunded(_intentHash, intent.recipient, intent.lockedAmount, intent.releaseEligibleAt);
    }

    /// @notice Pushes a matured deferred payout's available, unclaimed stake only to its recipient.
    /// @dev Only the taker or recipient may call. A partial payout leaves the remainder claimable later.
    function claimFor(bytes32 _intentHash) external nonReentrant {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.collateralSource != CollateralSource.DEFERRED_PAYOUT) revert NotDeferredPayout(_intentHash);
        if (msg.sender != intent.taker && msg.sender != intent.recipient) revert UnauthorizedClaimer(msg.sender);
        if (intent.status == DisputeProtectionIntentStatus.SETTLED) _releaseMaturedDisputeProtectionIntent(_intentHash);
        if (intent.status != DisputeProtectionIntentStatus.RELEASED) revert UnexpectedStatus(_intentHash, intent.status);
        uint256 amount = intent.lockedAmount - intent.claimedAmount;
        uint256 freeStake = stakeVault.freeStake(intent.recipient);
        if (amount > freeStake) amount = freeStake;
        if (amount == 0) revert NothingToClaim(_intentHash);
        intent.claimedAmount += amount;
        stakeVault.payOutStake(intent.recipient, amount);
        emit DeferredPayoutClaimed(_intentHash, intent.recipient, msg.sender, amount, intent.claimedAmount);
    }

    /* ============ Permissionless Functions ============ */

    /**
     * @notice Releases collateral for one settled intent once its minimum risk window has elapsed.
     * @dev Disputes remain valid after `releaseEligibleAt` until this release transaction executes.
     * @param _intentHash Settled dispute protection intent whose collateral should be unlocked.
     */
    function releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) external nonReentrant {
        _releaseMaturedDisputeProtectionIntent(_intentHash);
    }

    /**
     * @notice Releases collateral for a batch of settled intents whose minimum risk windows have elapsed.
     * @dev The batch is atomic: one invalid or ineligible intent reverts every release in the call.
     * @param _intentHashes Settled dispute protection intents whose collateral should be unlocked.
     */
    function releaseMaturedDisputeProtectionIntents(bytes32[] calldata _intentHashes) external nonReentrant {
        for (uint256 intentIndex = 0; intentIndex < _intentHashes.length; intentIndex++) {
            _releaseMaturedDisputeProtectionIntent(_intentHashes[intentIndex]);
        }
    }

    /**
     * @notice Resolves valid dispute evidence into an immediately claimable depositor award.
     * @dev A settled intent remains disputable until its collateral release executes, even after
     * `releaseEligibleAt`. The dedicated dispute nullifier registry atomically rejects replayed disputes.
     * @param _attestation Signed dispute evidence for a settled intent.
     */
    function submitDispute(IDisputeVerifier.DisputeAttestation calldata _attestation) external nonReentrant {
        DisputeProtectionIntent storage disputeProtectionIntent =
            disputeProtectionIntentByIntentHash[_attestation.intentHash];
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert UnexpectedStatus(_attestation.intentHash, disputeProtectionIntent.status);
        }

        (bytes32 disputeId, bytes32 disputeNullifier) =
            disputeVerifier.verifyDispute(_attestation, disputeProtectionIntent.paymentMethod);
        disputeNullifierRegistry.addNullifier(disputeNullifier);

        uint256 compensatedAmount = disputeProtectionIntent.lockedAmount;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.DISPUTED;

        IStakeVault.Claim[] memory claims = new IStakeVault.Claim[](1);
        claims[0] = IStakeVault.Claim({beneficiary: disputeProtectionIntent.depositor, amount: compensatedAmount});
        stakeVault.resolveLock(_attestation.intentHash, claims);

        emit DisputeResolved(
            _attestation.intentHash,
            disputeProtectionIntent.stakeOwner,
            disputeProtectionIntent.depositor,
            compensatedAmount,
            disputeId
        );
    }

    /* ============ Governance Functions ============ */

    /**
     * @notice GOVERNANCE ONLY: Replaces the verifier used for future dispute submissions.
     * @param _verifier New non-zero deployed dispute verifier.
     */
    function setDisputeVerifier(address _verifier) external onlyOwner {
        _validateDependency(_verifier);
        address previousVerifier = address(disputeVerifier);
        disputeVerifier = IDisputeVerifier(_verifier);
        emit DisputeVerifierUpdated(previousVerifier, _verifier);
    }

    /**
     * @notice GOVERNANCE ONLY: Authorizes or revokes one lifecycle hook.
     * @dev Authorize a hook before configuring it on an Orchestrator. Revoke a predecessor only after every intent
     * snapshotted to it has been cancelled or settled.
     * @param _hook Lifecycle hook whose callback authority is updated.
     * @param _isAuthorized Whether the hook may mutate dispute protection intent state.
     */
    function setLifecycleHookAuthorization(address _hook, bool _isAuthorized) external onlyOwner {
        if (_isAuthorized) _validateDependency(_hook);
        isLifecycleHookAuthorizedByHook[_hook] = _isAuthorized;
        emit LifecycleHookAuthorizationUpdated(_hook, _isAuthorized);
    }

    /**
     * @notice GOVERNANCE ONLY: Accepts this policy as StakeVault's controller after its handover delay.
     * @dev Before replacing another policy, governance must drain its active dispute protection intents or execute an
     * explicit state-and-lock migration. Accepting controller authority alone cannot import the predecessor's intent
     * state.
     */
    function acceptVaultController() external onlyOwner {
        stakeVault.acceptController();
    }

    /**
     * @notice Disables ownership renunciation so governed safety controls cannot become unreachable.
     */
    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    /* ============ View Functions ============ */

    /**
     * @notice Returns the stored dispute protection state for an intent.
     * @param _intentHash Intent whose dispute protection state is queried.
     */
    function getDisputeProtectionIntent(bytes32 _intentHash) external view returns (DisputeProtectionIntent memory) {
        return disputeProtectionIntentByIntentHash[_intentHash];
    }

    /**
     * @notice Returns whether a lifecycle hook may mutate dispute protection intent state.
     * @param _hook Lifecycle hook whose callback authorization is queried.
     */
    function isLifecycleHookAuthorized(address _hook) external view override returns (bool) {
        return isLifecycleHookAuthorizedByHook[_hook];
    }

    /* ============ Internal Functions ============ */

    function _releaseMaturedDisputeProtectionIntent(bytes32 _intentHash) internal {
        DisputeProtectionIntent storage disputeProtectionIntent = disputeProtectionIntentByIntentHash[_intentHash];
        if (disputeProtectionIntent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert UnexpectedStatus(_intentHash, disputeProtectionIntent.status);
        }

        uint64 currentTime = _currentTimestamp();
        uint64 releaseEligibleAt = disputeProtectionIntent.releaseEligibleAt;
        if (currentTime < releaseEligibleAt) {
            revert DisputeProtectionIntentNotReleaseEligible(releaseEligibleAt, currentTime);
        }

        uint256 releasedAmount = disputeProtectionIntent.lockedAmount;
        disputeProtectionIntent.status = DisputeProtectionIntentStatus.RELEASED;
        stakeVault.unlockStake(_intentHash);
        emit DisputeProtectionIntentReleased(_intentHash, disputeProtectionIntent.stakeOwner, releasedAmount);
    }

    function _calculateReleaseEligibleAt(uint64 _riskWindow) internal view returns (uint64) {
        uint256 releaseEligibleAt = block.timestamp + _riskWindow;
        if (releaseEligibleAt > type(uint64).max) revert TimestampOverflow(releaseEligibleAt);
        return uint64(releaseEligibleAt);
    }

    function _currentTimestamp() internal view returns (uint64) {
        if (block.timestamp > type(uint64).max) revert TimestampOverflow(block.timestamp);
        return uint64(block.timestamp);
    }

    function _validateDependency(address _dependency) internal view {
        if (_dependency == address(0)) revert ZeroAddress();
        if (_dependency.code.length == 0) revert InvalidContract(_dependency);
    }
}
