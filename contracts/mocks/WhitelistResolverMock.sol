// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IWhitelistResolver } from "../interfaces/IWhitelistResolver.sol";

contract WhitelistResolverMock is IWhitelistResolver {
    enum Mode {
        MembershipMap,        // honest resolver backed by memberOf mapping
        ReturnTrue,
        ReturnFalse,
        ReturnTwo,            // 32-byte word == 2
        ReturnMax,            // 32-byte word == type(uint256).max
        ReturnShort,          // fewer than 32 bytes of returndata
        Revert,
        BurnGas,              // consume the entire forwarded gas
        PayloadReturnNotOne,  // `payloadSize` bytes of returndata, first word == 2
        PayloadReturnTrue,    // `payloadSize` bytes of returndata, first word == 1
        PayloadRevert         // revert with `payloadSize` bytes of revert data
    }

    Mode public mode;
    uint256 public payloadSize;
    mapping(uint256 => mapping(address => bool)) public memberOf;

    function setMode(Mode _mode) external {
        mode = _mode;
    }

    function setPayloadSize(uint256 _payloadSize) external {
        payloadSize = _payloadSize;
    }

    function setMemberOf(uint256 _groupId, address _account, bool _isMember) external {
        memberOf[_groupId][_account] = _isMember;
    }

    function isMember(uint256 _groupId, address _account) external view override returns (bool) {
        Mode currentMode = mode;
        if (currentMode == Mode.MembershipMap) return memberOf[_groupId][_account];
        if (currentMode == Mode.ReturnTrue) return true;
        if (currentMode == Mode.ReturnFalse) return false;
        if (currentMode == Mode.ReturnTwo) {
            assembly { mstore(0x00, 2) return(0x00, 0x20) }
        }
        if (currentMode == Mode.ReturnMax) {
            assembly { mstore(0x00, not(0)) return(0x00, 0x20) }
        }
        if (currentMode == Mode.ReturnShort) {
            assembly { mstore(0x00, 1) return(0x00, 0x10) }
        }
        if (currentMode == Mode.Revert) {
            revert("resolver failed");
        }
        if (currentMode == Mode.BurnGas) {
            assembly {
                for { } 1 { } { pop(keccak256(0x00, 0x20)) }
            }
        }
        uint256 size = payloadSize;
        if (currentMode == Mode.PayloadReturnNotOne) {
            assembly { mstore(0x00, 2) return(0x00, size) }
        }
        if (currentMode == Mode.PayloadReturnTrue) {
            assembly { mstore(0x00, 1) return(0x00, size) }
        }
        // Mode.PayloadRevert
        assembly { revert(0x00, size) }
    }
}
