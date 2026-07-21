// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/security/ReentrancyGuard.sol";

import { IEscrowV2 } from "../interfaces/IEscrowV2.sol";

/**
 * @title EscrowDepositReceiver
 * @notice Single-use receiver that turns a precommitted token delivery into an EscrowV2 deposit.
 * @dev A receiver can be the destination of a bridge or swap. Anyone may finalize the order,
 *      but only the immutable depositor owns the resulting escrow deposit and can recover funds.
 */
contract EscrowDepositReceiver is ReentrancyGuard {
    using SafeERC20 for IERC20;

    /* ============ Events ============ */

    event ReceiverFinalized(address indexed caller, address indexed depositor, uint256 amount);
    event ReceiverFundsRecovered(address indexed token, address indexed depositor, uint256 amount);

    /* ============ Errors ============ */

    error ZeroAddress();
    error AddressHasNoCode(address target);
    error ZeroAmount();
    error ZeroDepositParamsHash();
    error AlreadyFinalized();
    error OrderExpired(uint256 expiry, uint256 currentTime);
    error OrderNotExpired(uint256 expiry, uint256 currentTime);
    error UnauthorizedCaller(address caller, address depositor);
    error TokenMismatch(address expected, address actual);
    error AmountMismatch(uint256 expected, uint256 actual);
    error DepositParamsHashMismatch(bytes32 expected, bytes32 actual);
    error InsufficientReceiverBalance(uint256 required, uint256 actual);
    error EscrowDepositFailed(bytes reason);
    error NoFundsToRecover(address token);

    /* ============ Immutable State ============ */

    IERC20 public immutable token;
    IEscrowV2 public immutable escrow;
    address public immutable depositor;
    uint256 public immutable amount;
    bytes32 public immutable depositParamsHash;
    uint64 public immutable expiry;

    /* ============ Mutable State ============ */

    bool public finalized;

    /* ============ Constructor ============ */

    constructor(
        IERC20 _token,
        IEscrowV2 _escrow,
        address _depositor,
        uint256 _amount,
        bytes32 _depositParamsHash,
        uint64 _expiry
    ) {
        if (address(_token) == address(0) || address(_escrow) == address(0) || _depositor == address(0)) {
            revert ZeroAddress();
        }
        if (address(_token).code.length == 0) revert AddressHasNoCode(address(_token));
        if (address(_escrow).code.length == 0) revert AddressHasNoCode(address(_escrow));
        if (_amount == 0) revert ZeroAmount();
        if (_depositParamsHash == bytes32(0)) revert ZeroDepositParamsHash();

        token = _token;
        escrow = _escrow;
        depositor = _depositor;
        amount = _amount;
        depositParamsHash = _depositParamsHash;
        expiry = _expiry;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Creates the immutable depositor's escrow deposit after the committed funds arrive.
     * @dev Permissionless and retryable after transient failures. The commitment covers the full
     *      CreateDepositParams value, including nested payment method and currency configuration.
     */
    function finalize(IEscrowV2.CreateDepositParams calldata _params) external nonReentrant {
        if (finalized) revert AlreadyFinalized();
        if (block.timestamp >= expiry) revert OrderExpired(expiry, block.timestamp);
        if (address(_params.token) != address(token)) {
            revert TokenMismatch(address(token), address(_params.token));
        }
        if (_params.amount != amount) revert AmountMismatch(amount, _params.amount);

        bytes32 actualParamsHash = hashDepositParams(_params);
        if (actualParamsHash != depositParamsHash) {
            revert DepositParamsHashMismatch(depositParamsHash, actualParamsHash);
        }

        uint256 balanceBefore = token.balanceOf(address(this));
        if (balanceBefore < amount) revert InsufficientReceiverBalance(amount, balanceBefore);

        finalized = true;
        _setEscrowAllowance(amount);

        try escrow.depositTo(depositor, _params) {
            uint256 balanceAfter = token.balanceOf(address(this));
            if (balanceBefore - balanceAfter != amount) {
                revert AmountMismatch(amount, balanceBefore - balanceAfter);
            }
            _setEscrowAllowance(0);
        } catch (bytes memory reason) {
            revert EscrowDepositFailed(reason);
        }

        emit ReceiverFinalized(msg.sender, depositor, amount);
    }

    /**
     * @notice Recovers any ERC20 held by the receiver once its order has expired.
     * @dev Only the immutable depositor can recover. This also rescues wrong-token transfers.
     */
    function recover(IERC20 _token) external nonReentrant {
        if (msg.sender != depositor) revert UnauthorizedCaller(msg.sender, depositor);
        if (block.timestamp < expiry) revert OrderNotExpired(expiry, block.timestamp);

        if (address(_token) == address(token)) _setEscrowAllowance(0);

        uint256 recoverableAmount = _token.balanceOf(address(this));
        if (recoverableAmount == 0) revert NoFundsToRecover(address(_token));

        _token.safeTransfer(depositor, recoverableAmount);

        emit ReceiverFundsRecovered(address(_token), depositor, recoverableAmount);
    }

    /**
     * @notice Returns the canonical commitment for a complete EscrowV2 deposit request.
     */
    function hashDepositParams(IEscrowV2.CreateDepositParams calldata _params) public pure returns (bytes32) {
        return keccak256(abi.encode(_params));
    }

    /* ============ Internal Functions ============ */

    function _setEscrowAllowance(uint256 _allowance) internal {
        token.safeApprove(address(escrow), 0);
        if (_allowance != 0) token.safeApprove(address(escrow), _allowance);
    }
}
