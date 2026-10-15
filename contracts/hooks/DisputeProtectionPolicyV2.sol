// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import {ERC165} from "@openzeppelin/contracts/utils/introspection/ERC165.sol";
import {IIntentSettlementPolicy} from "../interfaces/IIntentSettlementPolicy.sol";
import {IWhitelistPolicy} from "../interfaces/IWhitelistPolicy.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import {IDisputeProtectionPolicyV2} from "../interfaces/IDisputeProtectionPolicyV2.sol";
import {IDisputeVerifier} from "../interfaces/IDisputeVerifier.sol";
import {INullifierRegistry} from "../interfaces/INullifierRegistry.sol";
import {IStakeVaultV2} from "../interfaces/IStakeVaultV2.sol";

/**
 * @title DisputeProtectionPolicyV2
 * @notice Selects existing stake or deferred payout collateral at settlement.
 * @dev Deferred payouts are stake locks funded by the payout. The token must have no transfer callbacks
 * (canonical USDC only). StakeVaultV2 owns collateral accounting; the dedicated dispute registry owns replay state.
 * TRUST: Authorized orchestrators must invoke callbacks only for their own validated intents and escrows.
 * Settlement uses the depositor and token captured before escrow unlock; this policy never reads escrow.
 * Intent hashes must embed the originating orchestrator so identities cannot collide. Governance must keep
 * orchestrators authorized on predecessor policies until their snapshotted intents drain. Authorize a successor
 * policy alongside its predecessor in StakeVaultV2 and select it on O4 for new intents and settlements. The
 * predecessor keeps serving its own locks; de-authorize it only after its locks drain. Any authorized vault
 * controller can lock any owner's free stake and pay out that free stake only to its owner.
 * Protection applies only to stake-token deposits with a nonzero attested window supplied in the signed extension.
 * There are no per-method windows or paused admissions. Whitelisted takers, manual releases and zero
 * windows settle without a record or event. Non-stake tokens return without a record
 * or event. Protected settlements lock gross stake or defer the net payout until now plus the attested
 * window; only these STAKE and DEFERRED_PAYOUT settlements emit DisputeProtectionIntentSettled.
 */
contract DisputeProtectionPolicyV2 is IDisputeProtectionPolicyV2, Ownable2Step, ReentrancyGuard, ERC165 {
    /* ============ Constants ============ */

    uint64 public constant MAX_RISK_WINDOW = 180 days;

    /* ============ State Variables ============ */

    /// @notice Stake custody and lock accounting controlled by this policy.
    IStakeVaultV2 public immutable override stakeVault;

    /// @notice Live deposit/payment-method whitelist used to exempt allowed takers.
    IWhitelistPolicy public immutable whitelistPolicy;

    /// @notice Dedicated replay registry for payment-method-scoped dispute nullifiers.
    INullifierRegistry public immutable disputeNullifierRegistry;

    /// @notice Verifier used to validate signed dispute evidence.
    IDisputeVerifier public disputeVerifier;

    /// @dev Orchestrator authorization keyed by caller address.
    mapping(address => bool) internal isOrchestratorAuthorizedByAddress;

    /// @dev Dispute protection lifecycle state keyed by globally unique intent hash.
    mapping(bytes32 => DisputeProtectionIntent) internal disputeProtectionIntentByIntentHash;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a dispute protection policy over one StakeVaultV2 and one dedicated dispute-nullifier registry.
     * @dev After deployment, authorize this policy as a StakeVaultV2 controller and as a writer on the dedicated
     * dispute nullifier registry before enabling deposits.
     * @param _owner Governance owner for policy and dependency configuration.
     * @param _stakeVault Vault holding and locking taker collateral.
     * @param _disputeVerifier Verifier for signed dispute evidence.
     * @param _disputeNullifierRegistry Dedicated registry that rejects reused dispute nullifiers.
     * @param _whitelistPolicy Live whitelist for settlement exemptions.
     */
    constructor(
        address _owner,
        IStakeVaultV2 _stakeVault,
        IDisputeVerifier _disputeVerifier,
        INullifierRegistry _disputeNullifierRegistry,
        IWhitelistPolicy _whitelistPolicy
    ) {
        if (_owner == address(0)) revert ZeroAddress();
        _validateDependency(address(_stakeVault));
        _validateDependency(address(_disputeVerifier));
        _validateDependency(address(_disputeNullifierRegistry));

        _validateDependency(address(_whitelistPolicy));
        whitelistPolicy = _whitelistPolicy;
        stakeVault = _stakeVault;
        disputeVerifier = _disputeVerifier;
        disputeNullifierRegistry = _disputeNullifierRegistry;
        _transferOwnership(_owner);
    }

    /* ============ Modifiers ============ */

    modifier onlyAuthorizedOrchestrator() {
        if (!isOrchestratorAuthorizedByAddress[msg.sender]) {
            revert UnauthorizedOrchestrator(msg.sender);
        }
        _;
    }

    /* ============ Lifecycle Functions ============ */

    /// @inheritdoc IIntentSettlementPolicy
    function settleIntent(SettlementContext calldata _context)
        external override onlyAuthorizedOrchestrator returns (address deferralVault)
    {
        if (_context.isManualRelease) return address(0);
        if (_context.extensionData.length < 32) revert MissingDisputeWindow();
        uint256 window = abi.decode(_context.extensionData[:32], (uint256));
        if (window > MAX_RISK_WINDOW) revert InvalidDisputeWindow(window);
        bytes32 expected = bytes32(_context.data);
        bytes32 attested = _context.extensionData.length >= 64
            ? abi.decode(_context.extensionData[32:64], (bytes32)) : bytes32(0);
        if (attested != expected) revert ConditionsNotAttested(_context.intentHash);
        if (window == 0) return address(0);
        if (
            whitelistPolicy.enabled(_context.escrow, _context.depositId, _context.paymentMethod)
                && whitelistPolicy.isTakerAllowed(
                    _context.escrow, _context.depositId, _context.paymentMethod, _context.taker
                )
        ) return address(0);
        if (_context.token != address(stakeVault.stakeToken())) return address(0);
        if (disputeProtectionIntentByIntentHash[_context.intentHash].status != DisputeProtectionIntentStatus.NONE) {
            revert DisputeProtectionIntentAlreadyExists(_context.intentHash);
        }
        if (_context.releaseAmount == 0 || _context.netAmount == 0) {
            revert InvalidSettlementAmount(_context.releaseAmount, _context.netAmount);
        }
        return _settleProtectedIntent(_context, uint64(window));
    }

    /// @dev Apply the reentrancy guard only to protected settlements that change state.
    function _settleProtectedIntent(SettlementContext calldata _params, uint64 _riskWindow) internal nonReentrant returns (address deferralVault) {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_params.intentHash];
        intent.taker = _params.taker;
        intent.recipient = _params.recipient;
        intent.depositor = _params.depositor;
        intent.paymentMethod = _params.paymentMethod;
        intent.releaseEligibleAt = _calculateReleaseEligibleAt(_riskWindow);
        intent.status = DisputeProtectionIntentStatus.SETTLED;
        address stakeOwner = stakeVault.stakeOwnerOf(_params.taker);
        if (stakeVault.freeStake(stakeOwner) >= _params.releaseAmount) {
            intent.collateralSource = CollateralSource.STAKE;
            intent.stakeOwner = stakeOwner;
            intent.lockedAmount = _params.releaseAmount;
            stakeVault.lockStake(stakeOwner, _params.intentHash, _params.releaseAmount, intent.releaseEligibleAt);
        } else {
            intent.collateralSource = CollateralSource.DEFERRED_PAYOUT;
            intent.stakeOwner = _params.recipient;
            intent.lockedAmount = _params.netAmount;
            deferralVault = address(stakeVault);
        }
        emit DisputeProtectionIntentSettled(
            _params.intentHash, intent.taker, intent.depositor, intent.recipient, intent.paymentMethod,
            _riskWindow, intent.collateralSource, intent.stakeOwner, _params.releaseAmount,
            intent.lockedAmount, intent.releaseEligibleAt
        );
    }

    /// @inheritdoc IIntentSettlementPolicy
    function onDeferredPayoutFunded(bytes32 _intentHash) external override onlyAuthorizedOrchestrator nonReentrant {
        DisputeProtectionIntent storage intent = disputeProtectionIntentByIntentHash[_intentHash];
        if (intent.status != DisputeProtectionIntentStatus.SETTLED) {
            revert UnexpectedStatus(_intentHash, intent.status);
        }
        if (intent.collateralSource != CollateralSource.DEFERRED_PAYOUT) revert NotDeferredPayout(_intentHash);
        stakeVault.fundLock(intent.recipient, _intentHash, intent.lockedAmount, intent.releaseEligibleAt);
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

        IStakeVaultV2.Claim[] memory claims = new IStakeVaultV2.Claim[](1);
        claims[0] = IStakeVaultV2.Claim({beneficiary: disputeProtectionIntent.depositor, amount: compensatedAmount});
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
     * @notice GOVERNANCE ONLY: Authorizes or revokes one orchestrator.
     * @dev Authorize an orchestrator before configuring this policy on it. Revoke it only after every intent
     * snapshotted to this policy has been cancelled or settled.
     * @param _orchestrator Orchestrator whose callback authority is updated.
     * @param _isAuthorized Whether the orchestrator may mutate dispute protection intent state.
     */
    function setOrchestratorAuthorization(address _orchestrator, bool _isAuthorized) external override onlyOwner {
        if (_isAuthorized) _validateDependency(_orchestrator);
        isOrchestratorAuthorizedByAddress[_orchestrator] = _isAuthorized;
        emit OrchestratorAuthorizationUpdated(_orchestrator, _isAuthorized);
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
     * @notice Returns whether a orchestrator may mutate dispute protection intent state.
     * @param _orchestrator Orchestrator whose callback authorization is queried.
     */
    function isOrchestratorAuthorized(address _orchestrator) external view override returns (bool) {
        return isOrchestratorAuthorizedByAddress[_orchestrator];
    }

    /// @notice Reports ERC-165 and the minimal settlement interface supported by this policy.
    function supportsInterface(bytes4 interfaceId) public view override returns (bool) {
        return interfaceId == type(IIntentSettlementPolicy).interfaceId || super.supportsInterface(interfaceId);
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
