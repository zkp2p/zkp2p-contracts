// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IOrchestratorV2 } from "../interfaces/IOrchestratorV2.sol";
import { IOrchestratorV3 } from "../interfaces/IOrchestratorV3.sol";

/**
 * @title OrchestratorV3Validation
 * @notice Shared validation for V3-only constructor dependencies.
 * @dev This library validates deployed code, not implementation identity or code hashes. Registry
 *      admission remains an explicit governance trust decision.
 */
library OrchestratorV3Validation {
    uint256 internal constant MAX_PROTOCOL_FEE = 5e16;

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

    function _requireContract(address _account) private view {
        if (_account.code.length == 0) revert IOrchestratorV3.InvalidContract(_account);
    }
}
