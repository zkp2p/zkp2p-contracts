// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

/**
 * @title PaymentNullifierLib
 * @notice Derives the replay key for one payment identifier. A payment can carry several identifiers, each tagged
 * with the scheme that says what kind of identifier it is.
 * @dev The native scheme keeps the pre-V3 derivation, so every key written before typed identifiers existed keeps
 * its meaning. Native preimages are 64 bytes and typed preimages are 96 bytes, so the two can never collide.
 */
library PaymentNullifierLib {
    /// @notice The payment platform's own transaction identifier, the only kind consumed before typed identifiers.
    bytes32 internal constant NATIVE_SCHEME = bytes32(0);

    /**
     * @param _paymentMethod Payment method hash that scopes the identifier.
     * @param _scheme Identifier kind; `NATIVE_SCHEME` for the platform's own transaction identifier.
     * @param _id Hashed identifier.
     */
    function key(bytes32 _paymentMethod, bytes32 _scheme, bytes32 _id) internal pure returns (bytes32) {
        if (_scheme == NATIVE_SCHEME) return keccak256(abi.encodePacked(_paymentMethod, _id));
        return keccak256(abi.encode(_paymentMethod, _scheme, _id));
    }
}
