// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IEscrow } from "../interfaces/IEscrow.sol";
import { IOrchestratorRegistry } from "../interfaces/IOrchestratorRegistry.sol";
import { IPreIntentHook } from "../interfaces/IPreIntentHook.sol";
import { ReferralFeeLib } from "../lib/ReferralFeeLib.sol";

/**
 * @title SignatureGatingPreIntentHook
 * @notice Pre-intent hook that validates taker eligibility using an off-chain signature.
 * @dev Uses the built-in gating payload fields and additionally binds the caller taker address.
 */
contract SignatureGatingPreIntentHook is IPreIntentHook {
    using ECDSA for bytes32;
    using SignatureChecker for address;

    /* ============ Events ============ */

    event DepositSignerSet(
        address indexed escrow,
        uint256 indexed depositId,
        address indexed signer,
        address setter
    );

    /* ============ Errors ============ */

    error ZeroAddress();
    error UnauthorizedCallerOrDelegate(address caller, address owner, address delegate);
    error UnauthorizedOrchestratorCaller(address caller);
    error SignerNotSet(address escrow, uint256 depositId);
    error SignatureExpired(uint256 expiration, uint256 currentTime);
    error InvalidSignature();

    /* ============ State Variables ============ */

    IOrchestratorRegistry public immutable orchestratorRegistry;
    uint256 public immutable chainId;

    // escrow => depositId => authorized signer
    mapping(address => mapping(uint256 => address)) public depositSigner;

    /* ============ Constructor ============ */

    constructor(address _orchestratorRegistry, uint256 _chainId) {
        if (_orchestratorRegistry == address(0)) revert ZeroAddress();

        orchestratorRegistry = IOrchestratorRegistry(_orchestratorRegistry);
        chainId = _chainId;
    }

    /* ============ External Functions ============ */

    /**
     * @notice Sets or clears the authorized signature signer for a specific deposit.
     * @dev Callable only by the deposit's depositor or delegate.
     *
     * @param _escrow      Escrow address.
     * @param _depositId   Deposit id.
     * @param _signer      Authorized signer (address(0) to clear).
     */
    function setDepositSigner(address _escrow, uint256 _depositId, address _signer) external {
        if (_escrow == address(0)) revert ZeroAddress();

        IEscrow.Deposit memory deposit = IEscrow(_escrow).getDeposit(_depositId);
        bool isDepositorOrDelegate = msg.sender == deposit.depositor
            || (deposit.delegate != address(0) && msg.sender == deposit.delegate);
        if (!isDepositorOrDelegate) {
            revert UnauthorizedCallerOrDelegate(msg.sender, deposit.depositor, deposit.delegate);
        }

        depositSigner[_escrow][_depositId] = _signer;

        emit DepositSignerSet(_escrow, _depositId, _signer, msg.sender);
    }

    function getDepositSigner(address _escrow, uint256 _depositId) external view returns (address) {
        return depositSigner[_escrow][_depositId];
    }

    /**
     * @inheritdoc IPreIntentHook
     */
    function validateSignalIntent(PreIntentContext calldata _ctx) external view override {
        if (!orchestratorRegistry.isOrchestrator(msg.sender)) revert UnauthorizedOrchestratorCaller(msg.sender);

        address signer = depositSigner[_ctx.escrow][_ctx.depositId];
        if (signer == address(0)) revert SignerNotSet(_ctx.escrow, _ctx.depositId);

        (bytes memory signature, uint256 signatureExpiration) = abi.decode(_ctx.preIntentHookData, (bytes, uint256));
        if (block.timestamp > signatureExpiration) {
            revert SignatureExpired(signatureExpiration, block.timestamp);
        }

        bytes memory message = abi.encodePacked(
            msg.sender,
            _ctx.escrow,
            _ctx.depositId,
            _ctx.amount,
            _ctx.taker,
            _ctx.to,
            _ctx.paymentMethod,
            _ctx.fiatCurrency,
            _ctx.conversionRate,
            ReferralFeeLib.hashReferralFees(_ctx.referralFees),
            signatureExpiration,
            chainId
        );

        bytes32 verifierPayload = keccak256(message).toEthSignedMessageHash();
        if (!signer.isValidSignatureNow(verifierPayload, signature)) {
            revert InvalidSignature();
        }
    }
}
