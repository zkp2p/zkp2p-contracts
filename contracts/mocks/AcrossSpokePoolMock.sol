// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/**
 * @title AcrossSpokePoolMock
 * @notice Minimal mock for Across SpokePool used in unit tests.
 */
contract AcrossSpokePoolMock {
    error TransferFailed();

    address public lastRecipient;
    address public lastInputToken;
    uint256 public lastInputAmount;
    uint256 public lastDestinationChainId;
    uint256 public mockCurrentTime;
    uint256 public mockQuoteTimeBuffer;
    uint256 public mockFillDeadlineBuffer;

    function setCurrentTime(uint256 _currentTime) external {
        mockCurrentTime = _currentTime;
    }

    function setBuffers(uint256 _quoteBuffer, uint256 _fillBuffer) external {
        mockQuoteTimeBuffer = _quoteBuffer;
        mockFillDeadlineBuffer = _fillBuffer;
    }

    function depositV3(
        address,
        address recipient,
        address inputToken,
        address,
        uint256 inputAmount,
        uint256,
        uint256 destinationChainId,
        address,
        uint32,
        uint32,
        uint32,
        bytes calldata
    ) external payable {
        lastRecipient = recipient;
        lastInputToken = inputToken;
        lastInputAmount = inputAmount;
        lastDestinationChainId = destinationChainId;

        if (!IERC20(inputToken).transferFrom(msg.sender, address(this), inputAmount)) {
            revert TransferFailed();
        }
    }

    function getCurrentTime() external view returns (uint256) {
        return mockCurrentTime;
    }

    function depositQuoteTimeBuffer() external view returns (uint256) {
        return mockQuoteTimeBuffer;
    }

    function fillDeadlineBuffer() external view returns (uint256) {
        return mockFillDeadlineBuffer;
    }
}
