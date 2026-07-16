// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { SignatureChecker } from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";
import { ReferralFeeLib } from "./ReferralFeeLib.sol";

/**
 * @title OrchestratorV3Validation
 * @notice Shared validation for V3-only constructor dependencies.
 * @dev This library validates deployed code, not implementation identity or code hashes. Registry
 *      admission remains an explicit governance trust decision.
 */
library OrchestratorV3Validation {
    using ECDSA for bytes32;
    using SignatureChecker for address;

    uint256 internal constant MAX_PROTOCOL_FEE = 5e16;
    bytes32 internal constant INTENT_GATING_AUTHORIZATION_TYPEHASH = keccak256(
        "IntentGatingAuthorization(address verifyingOrchestrator,uint256 chainId,address taker,address escrow,uint256 depositId,uint256 amount,address recipient,bytes32 paymentMethod,bytes32 fiatCurrency,uint256 conversionRate,bytes32 referralFeesHash,address settlementHook,bytes32 preIntentHookDataHash,bytes32 signalHookDataHash,uint256 signatureExpiration,uint256 nonce)"
    );

    event IntentGatingAuthorizationConsumed(
        address indexed taker,
        address indexed escrow,
        uint256 indexed depositId,
        bytes32 paymentMethod,
        uint256 nonce
    );

    /** @notice Validates the V3 constructor inputs that legacy V2 does not validate. */
    function validateConstructor(
        uint256 _chainId,
        address _escrowRegistry,
        address _paymentVerifierRegistry,
        address _relayerRegistry,
        uint256 _protocolFee,
        address _protocolFeeRecipient
    ) external view {
        if (_chainId != block.chainid) {
            revert IOrchestratorV3.InvalidChainId(_chainId, block.chainid);
        }
        if (
            _escrowRegistry == address(0)
                || _paymentVerifierRegistry == address(0)
                || _relayerRegistry == address(0)
                || _protocolFeeRecipient == address(0)
        ) {
            revert IOrchestratorV2.ZeroAddress();
        }
        _requireContract(_escrowRegistry);
        _requireContract(_paymentVerifierRegistry);
        _requireContract(_relayerRegistry);
        if (_protocolFee > MAX_PROTOCOL_FEE) {
            revert IOrchestratorV2.FeeExceedsMaximum(_protocolFee, MAX_PROTOCOL_FEE);
        }
    }

    /** @notice Returns the current nonce for one taker's deposit/payment-method authorization stream. */
    function intentGatingNonce(
        mapping(bytes32 => uint256) storage _nonces,
        address _taker,
        address _escrow,
        uint256 _depositId,
        bytes32 _paymentMethod
    ) external view returns (uint256) {
        return _nonces[keccak256(abi.encode(_taker, _escrow, _depositId, _paymentMethod))];
    }

    /** @notice Returns the unprefixed V3 gating authorization hash for the current scoped nonce. */
    function currentIntentGatingMessageHash(
        mapping(bytes32 => uint256) storage _nonces,
        IOrchestratorV2.SignalIntentParams calldata _params,
        address _taker,
        address _verifyingOrchestrator,
        uint256 _chainId
    ) external view returns (bytes32) {
        bytes32 scope = keccak256(
            abi.encode(_taker, _params.escrow, _params.depositId, _params.paymentMethod)
        );
        return _intentGatingMessageHash(
            _params,
            _taker,
            _verifyingOrchestrator,
            _chainId,
            _nonces[scope]
        );
    }

    /** @notice Consumes the current scoped nonce and verifies a single-use V3 authorization. */
    function validateAndConsumeIntentGatingAuthorization(
        mapping(bytes32 => uint256) storage _nonces,
        IOrchestratorV2.SignalIntentParams calldata _params,
        address _intentGatingService,
        address _taker,
        address _verifyingOrchestrator,
        uint256 _chainId
    ) external {
        bytes32 scope = keccak256(
            abi.encode(_taker, _params.escrow, _params.depositId, _params.paymentMethod)
        );
        uint256 nonce = _nonces[scope];
        _nonces[scope] = nonce + 1;

        bytes32 messageHash = _intentGatingMessageHash(
            _params,
            _taker,
            _verifyingOrchestrator,
            _chainId,
            nonce
        );
        if (!_intentGatingService.isValidSignatureNow(
            messageHash.toEthSignedMessageHash(),
            _params.gatingServiceSignature
        )) {
            revert IOrchestratorV2.InvalidSignature();
        }

        emit IntentGatingAuthorizationConsumed(
            _taker,
            _params.escrow,
            _params.depositId,
            _params.paymentMethod,
            nonce
        );
    }

    function _intentGatingMessageHash(
        IOrchestratorV2.SignalIntentParams calldata _params,
        address _taker,
        address _verifyingOrchestrator,
        uint256 _chainId,
        uint256 _nonce
    ) private pure returns (bytes32) {
        return keccak256(abi.encode(
            INTENT_GATING_AUTHORIZATION_TYPEHASH,
            _verifyingOrchestrator,
            _chainId,
            _taker,
            _params.escrow,
            _params.depositId,
            _params.amount,
            _params.to,
            _params.paymentMethod,
            _params.fiatCurrency,
            _params.conversionRate,
            ReferralFeeLib.hashReferralFees(_params.referralFees),
            address(_params.settlementHook),
            keccak256(_params.preIntentHookData),
            keccak256(_params.data),
            _params.signatureExpiration,
            _nonce
        ));
    }
    function _requireContract(address _account) private view {
        if (_account.code.length == 0) revert IOrchestratorV3.InvalidContract(_account);
    }
}
