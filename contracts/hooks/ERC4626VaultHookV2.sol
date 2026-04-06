// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IERC4626 } from "../external/Interfaces/IERC4626.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPostIntentHookV2 } from "../interfaces/IPostIntentHookV2.sol";

/**
 * @title ERC4626VaultHookV2
 * @notice V2 post-intent hook that deposits the net intent payout into any ERC-4626 compliant
 *         vault chosen by the taker at signalIntent time. Generic to any vault whose underlying
 *         asset matches the hook's input token (e.g. USDC), so integrators can target Morpho,
 *         Aave wrappers, Yearn v3, Spark, Euler wrappers, etc. without deploying new contracts.
 *
 * @dev Slippage protection comes from `minSharesOut`, committed at signalIntent time and signed
 *      over by the gating service. Per ERC-4626 spec, `previewDeposit` MUST return no more than
 *      the shares that would actually be minted in the same transaction, so it is a sound lower
 *      bound on the actual mint. The hook uses `previewDeposit` as a pre-gate: if the preview
 *      already clears `minSharesOut`, the deposit is guaranteed to clear it for spec-compliant
 *      vaults and we proceed; otherwise we fall back to a direct transfer of the underlying to
 *      `intent.to`. There is no post-deposit revert on the share count: once the vault has the
 *      assets we cannot safely undo, and hard-reverting would leave the intent stuck (the
 *      vault is committed in `signalHookData`, so relayers cannot retry against a different
 *      vault). The trade-off is that a vault whose `previewDeposit` lies relative to its
 *      `deposit` is not caught by this hook; integrators should only expose reputable vaults.
 *
 *      FALLBACK BEHAVIOR: If the deposit cannot be completed (preview below minimum, preview
 *      reverts, or vault.deposit reverts), the net amount is transferred to `intent.to` on the
 *      source chain. The user always receives their funds, matching the UX guarantee of
 *      AcrossBridgeHookV2.
 */
contract ERC4626VaultHookV2 is IPostIntentHookV2, Ownable {
    using SafeERC20 for IERC20;

    /* ============ Enums ============ */

    /**
     * @notice Reason codes for fallback transfer when the vault deposit cannot be completed.
     * @dev Used in FallbackTransfer event for gas-efficient reason tracking.
     */
    enum FallbackReason {
        PREVIEW_BELOW_MINIMUM, // previewDeposit returned fewer shares than minSharesOut
        DEPOSIT_CALL_FAILED    // previewDeposit reverted, or vault.deposit() reverted
    }

    /* ============ Structs ============ */

    /**
     * @notice Commitment stored in intent signalHookData at signalIntent time.
     * @dev The commitment is fixed at signal time and covered by the gating service signature.
     *      `minSharesOut` is the user's slippage floor; off-chain tooling should compute it from
     *      a fresh `previewDeposit` quote with a small buffer (e.g. 50 bps) before signaling.
     * @param vault           ERC-4626 vault address (must have asset() == inputToken)
     * @param sharesReceiver  Address that receives the minted vault shares (often == intent.to)
     * @param minSharesOut    Minimum vault shares the user is willing to accept
     */
    struct VaultDepositCommitment {
        address vault;
        address sharesReceiver;
        uint256 minSharesOut;
    }

    /* ============ Events ============ */

    /**
     * @notice Emitted when a vault deposit is successfully executed.
     * @param intentHash     Hash of the fulfilled intent
     * @param vault          ERC-4626 vault that received the deposit
     * @param sharesReceiver Address that received the minted shares
     * @param assetsIn       Amount of underlying asset deposited
     * @param sharesOut      Actual shares minted (measured by balance delta)
     */
    event VaultDepositExecuted(
        bytes32 indexed intentHash,
        address indexed vault,
        address indexed sharesReceiver,
        uint256 assetsIn,
        uint256 sharesOut
    );

    /**
     * @notice Emitted when the deposit cannot be initiated and funds are transferred to intent.to.
     * @dev Graceful degradation: user receives the underlying asset instead of vault shares.
     * @param intentHash Hash of the intent being fulfilled
     * @param recipient  Address receiving the fallback transfer (intent.to)
     * @param amount     Amount transferred to recipient
     * @param reason     Why the deposit could not be initiated
     */
    event FallbackTransfer(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        FallbackReason reason
    );

    event RescueERC20(address indexed token, address indexed to, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedOrchestratorCaller(address caller);
    error InvalidFulfillHookDataLength(uint256 dataLength);
    error InvalidVault(address vault);
    error InvalidSharesReceiver(address sharesReceiver);
    error UnsupportedToken(address token);
    /// @dev Reverts fulfillIntent if the vault did not pull exactly `executableAmount` of the
    ///      underlying during `deposit()`. Without this check, a non-compliant vault could mint
    ///      shares while leaving funds stranded in the hook (the Orchestrator's exact-spend
    ///      invariant would still pass because the orch-to-hook transfer already counts as spent).
    error VaultDidNotConsumeAssets(uint256 hookAssetsBefore, uint256 hookAssetsAfter, uint256 expectedConsumed);

    /* ============ State Variables ============ */

    IERC20 public immutable inputToken;
    IOrchestratorRegistry public immutable orchestratorRegistry;

    /* ============ Constructor ============ */

    /**
     * @notice Creates a new ERC4626VaultHookV2 instance.
     * @param _inputToken           Underlying asset accepted by target vaults (e.g. USDC)
     * @param _orchestratorRegistry Registry of authorized orchestrators that may invoke this hook
     */
    constructor(
        address _inputToken,
        address _orchestratorRegistry
    ) Ownable() {
        if (_inputToken == address(0) || _orchestratorRegistry == address(0)) {
            revert ZeroAddress();
        }

        inputToken = IERC20(_inputToken);
        orchestratorRegistry = IOrchestratorRegistry(_orchestratorRegistry);
    }

    /* ============ External Functions ============ */

    /**
     * @notice Executes the hook by depositing the net intent payout into the committed ERC-4626 vault.
     * @dev Caller MUST be a registered orchestrator. Pulls `_ctx.executableAmount` from the orchestrator
     *      via safeTransferFrom and either deposits it into the vault for `sharesReceiver`, or — if the
     *      vault is non-viable — falls back by transferring the underlying to `_ctx.intent.to`.
     *
     *      The orchestrator enforces post-call that this hook consumed exactly `_ctx.executableAmount`,
     *      so every code path here must spend the full pulled amount.
     *
     * @param _ctx             Hook execution context (commitment is in _ctx.intent.signalHookData)
     * @param _fulfillHookData Must be empty (length 0); reserved for future JIT parameters
     */
    function execute(
        HookExecutionContext calldata _ctx,
        bytes calldata _fulfillHookData
    ) external override {
        address callingOrchestrator = msg.sender;
        if (!orchestratorRegistry.isOrchestrator(callingOrchestrator)) {
            revert UnauthorizedOrchestratorCaller(callingOrchestrator);
        }
        if (_fulfillHookData.length != 0) {
            revert InvalidFulfillHookDataLength(_fulfillHookData.length);
        }
        if (_ctx.token != address(inputToken)) {
            revert UnsupportedToken(_ctx.token);
        }

        VaultDepositCommitment memory commitment = abi.decode(
            _ctx.intent.signalHookData,
            (VaultDepositCommitment)
        );
        _validateCommitment(commitment);

        // Pull tokens from calling Orchestrator first (before any fallback logic).
        // The Orchestrator's post-call assertion (`spent == netAmount`) requires every branch
        // below to consume exactly `_ctx.executableAmount`.
        inputToken.safeTransferFrom(callingOrchestrator, address(this), _ctx.executableAmount);

        // Probe the vault preview as a spec-compliant lower bound on actual shares. Per EIP-4626,
        // `previewDeposit` MUST return no more than the shares that `deposit` would mint in the
        // same block, so `previewShares >= minSharesOut` guarantees the user's floor is honored
        // for compliant vaults. A revert here means the vault is non-compliant or unreachable;
        // we divert to the fallback path rather than reverting the whole fulfillIntent.
        (bool previewOk, uint256 previewShares) = _previewDeposit(commitment.vault, _ctx.executableAmount);
        bool priceMeetsMinimum = previewOk && previewShares >= commitment.minSharesOut;

        if (priceMeetsMinimum) {
            // Reset and grant exact allowance.
            inputToken.safeApprove(commitment.vault, 0);
            inputToken.safeApprove(commitment.vault, _ctx.executableAmount);

            // Snapshot recipient share balance to compute the authoritative shares delta.
            // We trust this delta over the value returned by deposit() in case the vault is buggy.
            uint256 sharesBefore = IERC20(commitment.vault).balanceOf(commitment.sharesReceiver);
            // Snapshot hook's underlying balance so we can verify the vault actually pulled
            // exactly `executableAmount`. Without this, a non-compliant vault could mint shares
            // while leaving funds stranded in the hook (the Orchestrator's exact-spend invariant
            // would still pass because the orch-to-hook transfer already counts as spent).
            uint256 hookAssetsBefore = inputToken.balanceOf(address(this));

            // Try the deposit; on revert fall through to the safeTransfer fallback below.
            try IERC4626(commitment.vault).deposit(_ctx.executableAmount, commitment.sharesReceiver) returns (uint256) {
                // Reset allowance even on success in case the vault under-pulled (defensive).
                inputToken.safeApprove(commitment.vault, 0);

                uint256 hookAssetsAfter = inputToken.balanceOf(address(this));
                if (hookAssetsAfter + _ctx.executableAmount != hookAssetsBefore) {
                    revert VaultDidNotConsumeAssets(hookAssetsBefore, hookAssetsAfter, _ctx.executableAmount);
                }

                // Use the balance delta as the authoritative mint amount. We intentionally do
                // NOT re-check `actualShares >= minSharesOut` here: the preview gate above
                // already guarantees this for spec-compliant vaults, and reverting post-deposit
                // on a non-compliant vault would leave the intent stuck (the vault is committed
                // in signalHookData, so relayers cannot retry against a different vault).
                uint256 actualShares = IERC20(commitment.vault).balanceOf(commitment.sharesReceiver) - sharesBefore;

                emit VaultDepositExecuted(
                    _ctx.intentHash,
                    commitment.vault,
                    commitment.sharesReceiver,
                    _ctx.executableAmount,
                    actualShares
                );
                return;
            } catch {
                // Deposit reverted; reset allowance and fall through to fallback transfer.
                inputToken.safeApprove(commitment.vault, 0);
            }
        }

        // Fallback: transfer the underlying directly to intent.to.
        inputToken.safeTransfer(_ctx.intent.to, _ctx.executableAmount);
        emit FallbackTransfer(
            _ctx.intentHash,
            _ctx.intent.to,
            _ctx.executableAmount,
            (previewOk && !priceMeetsMinimum)
                ? FallbackReason.PREVIEW_BELOW_MINIMUM
                : FallbackReason.DEPOSIT_CALL_FAILED
        );
    }

    /**
     * @notice Rescues ERC20 tokens sent to this contract.
     * @param _token  Token address to rescue
     * @param _to     Recipient address for rescued tokens
     * @param _amount Amount to rescue
     */
    function rescueERC20(address _token, address _to, uint256 _amount) external onlyOwner {
        if (_token == address(0) || _to == address(0)) revert ZeroAddress();
        IERC20(_token).safeTransfer(_to, _amount);
        emit RescueERC20(_token, _to, _amount);
    }

    /* ============ Internal Functions ============ */

    /**
     * @dev Validates structural commitment fields. These conditions can never be salvaged by a
     *      fallback (the data is malformed), so they revert hard.
     */
    function _validateCommitment(VaultDepositCommitment memory commitment) internal pure {
        if (commitment.vault == address(0)) revert InvalidVault(commitment.vault);
        if (commitment.sharesReceiver == address(0)) revert InvalidSharesReceiver(commitment.sharesReceiver);
    }

    /**
     * @dev Wraps `previewDeposit` in a try/catch so non-compliant vaults divert to the fallback
     *      path instead of reverting the entire fulfillIntent transaction.
     * @param vault  Vault address being probed
     * @param assets Amount of underlying asset that would be deposited
     * @return ok            True if previewDeposit returned without reverting
     * @return previewShares Preview value (0 if !ok)
     */
    function _previewDeposit(address vault, uint256 assets)
        internal
        view
        returns (bool ok, uint256 previewShares)
    {
        try IERC4626(vault).previewDeposit(assets) returns (uint256 p) {
            return (true, p);
        } catch {
            return (false, 0);
        }
    }
}
