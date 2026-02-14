// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AcrossSwapBridgeHook } from "contracts/hooks/AcrossSwapBridgeHook.sol";
import { AcrossSpokePoolPeripheryMock } from "contracts/mocks/AcrossSpokePoolPeripheryMock.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

contract AcrossSwapBridgeHookForkTest is Test {
    event AcrossSwapBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint256 minExpectedInputTokenAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter,
        address exchange
    );

    event FallbackTransfer(
        bytes32 indexed intentHash,
        address indexed recipient,
        uint256 amount,
        uint8 reason
    );

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_SPOKE_POOL = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address internal constant DEST_USDT_POLYGON = 0xc2132D05D31c914a87C6611C10748AEb04B58e8F;

    uint256 internal constant DEST_CHAIN_ID = 137;
    uint256 internal constant INPUT_AMOUNT = 10_000_000; // 10 USDC
    uint256 internal constant OUTPUT_AMOUNT = 9_900_000;
    uint256 internal constant MIN_OUTPUT = 9_900_000;

    AcrossSwapBridgeHook internal hook;
    AcrossSpokePoolPeripheryMock internal spokePoolPeriphery;
    address internal exchange;

    function setUp() public {
        string memory rpcUrl = _getRpcUrl();
        vm.createSelectFork(rpcUrl);

        spokePoolPeriphery = new AcrossSpokePoolPeripheryMock();
        exchange = makeAddr("exchange");

        hook = new AcrossSwapBridgeHook(BASE_USDC, address(this), BASE_SPOKE_POOL, address(spokePoolPeriphery));
        _fundUsdc(INPUT_AMOUNT);
        IERC20(BASE_USDC).approve(address(hook), INPUT_AMOUNT);
    }

    function testFork_SwapAndBridge_AcceptsFulfillIntent() public {
        address recipient = makeAddr("recipient");

        AcrossSwapBridgeHook.AcrossSwapBridgeCommitment memory commitment = AcrossSwapBridgeHook.AcrossSwapBridgeCommitment({
            destinationChainId: DEST_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDT_POLYGON),
            recipient: _toBytes32(recipient),
            minOutputAmount: MIN_OUTPUT,
            exchange: exchange,
            transferType: 0,
            minExpectedInputTokenAmount: INPUT_AMOUNT,
            quoteTimestamp: 0,
            fillDeadline: 21600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0,
            routerCalldata: hex"",
            enableProportionalAdjustment: false,
            message: hex""
        });
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitment);

        AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData memory fulfillData = AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData({
            intentHash: keccak256("across-swap-bridge-fork-intent"),
            outputAmount: OUTPUT_AMOUNT
        });

        uint256 recipientBefore = IERC20(BASE_USDC).balanceOf(recipient);
        uint256 peripheryBefore = IERC20(BASE_USDC).balanceOf(address(spokePoolPeriphery));

        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfillData));

        assertEq(IERC20(BASE_USDC).balanceOf(recipient), recipientBefore, "recipient should not receive fallback" );
        assertEq(spokePoolPeriphery.lastSpokePool(), BASE_SPOKE_POOL, "spoke pool address should be forwarded to periphery");
        assertEq(spokePoolPeriphery.lastExchange(), exchange, "exchange should be forwarded to periphery");
        assertEq(spokePoolPeriphery.lastSwapTokenAmount(), INPUT_AMOUNT, "swap token amount should match input");
        assertEq(spokePoolPeriphery.lastMinExpectedInputTokenAmount(), INPUT_AMOUNT, "min expected input should be committed in signal data");
        assertEq(spokePoolPeriphery.lastDepositOutputAmount(), OUTPUT_AMOUNT, "output amount should come from fulfill data");
        assertEq(spokePoolPeriphery.lastDepositQuoteTimestamp(), commitment.quoteTimestamp, "quote timestamp should be committed in signal data");
        assertEq(spokePoolPeriphery.lastDepositFillDeadline(), commitment.fillDeadline, "fill deadline should be committed in signal data");
        assertEq(spokePoolPeriphery.lastDepositExclusiveRelayer(), commitment.exclusiveRelayer, "exclusive relayer should be committed in signal data");
        assertEq(spokePoolPeriphery.lastDepositExclusivityParameter(), commitment.exclusivityParameter, "exclusivity should be committed in signal data");
        assertEq(IERC20(BASE_USDC).balanceOf(address(spokePoolPeriphery)), peripheryBefore + INPUT_AMOUNT, "periphery should receive transfer in");
    }

    function testFork_SwapAndBridge_FallbackToRecipientWhenOutputBelowMinimum() public {
        address recipient = makeAddr("lowOutputRecipient");

        AcrossSwapBridgeHook.AcrossSwapBridgeCommitment memory commitment = AcrossSwapBridgeHook.AcrossSwapBridgeCommitment({
            destinationChainId: DEST_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDT_POLYGON),
            recipient: _toBytes32(recipient),
            minOutputAmount: MIN_OUTPUT,
            exchange: exchange,
            transferType: 0,
            minExpectedInputTokenAmount: INPUT_AMOUNT,
            quoteTimestamp: 0,
            fillDeadline: 21600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0,
            routerCalldata: hex"",
            enableProportionalAdjustment: false,
            message: hex""
        });
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitment);

        AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData memory fulfillData = AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData({
            intentHash: keccak256("across-swap-bridge-fork-low-output"),
            outputAmount: MIN_OUTPUT - 1
        });

        uint256 recipientBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(fulfillData.intentHash, recipient, INPUT_AMOUNT, 0);
        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfillData));

        assertEq(IERC20(BASE_USDC).balanceOf(recipient), recipientBefore + INPUT_AMOUNT, "recipient should receive fallback");
    }

    function testFork_SwapAndBridge_FallbackToRecipientWhenReverts() public {
        address recipient = makeAddr("fallbackRecipient");

        AcrossSwapBridgeHook.AcrossSwapBridgeCommitment memory commitment = AcrossSwapBridgeHook.AcrossSwapBridgeCommitment({
            destinationChainId: DEST_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDT_POLYGON),
            recipient: _toBytes32(recipient),
            minOutputAmount: MIN_OUTPUT,
            exchange: exchange,
            transferType: 0,
            minExpectedInputTokenAmount: INPUT_AMOUNT,
            quoteTimestamp: 0,
            fillDeadline: 21600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0,
            routerCalldata: hex"",
            enableProportionalAdjustment: false,
            message: hex""
        });
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitment);

        AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData memory fulfillData = AcrossSwapBridgeHook.AcrossSwapBridgeFulfillData({
            intentHash: keccak256("across-swap-bridge-fork-intent-fallback"),
            outputAmount: OUTPUT_AMOUNT
        });

        spokePoolPeriphery.setShouldRevert(true);

        uint256 recipientBefore = IERC20(BASE_USDC).balanceOf(recipient);
        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(fulfillData.intentHash, recipient, INPUT_AMOUNT, 1);
        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfillData));

        assertEq(IERC20(BASE_USDC).balanceOf(recipient), recipientBefore + INPUT_AMOUNT, "recipient should receive fallback" );
    }

    function _buildIntent(
        address recipient,
        AcrossSwapBridgeHook.AcrossSwapBridgeCommitment memory commitment
    ) internal view returns (IOrchestrator.Intent memory) {
        return IOrchestrator.Intent({
            owner: address(this),
            to: recipient,
            escrow: address(0),
            depositId: 0,
            amount: INPUT_AMOUNT,
            timestamp: block.timestamp,
            paymentMethod: bytes32(0),
            fiatCurrency: bytes32(0),
            conversionRate: 0,
            payeeId: bytes32(0),
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(hook)),
            data: abi.encode(commitment)
        });
    }

    function _fundUsdc(uint256 amount) internal {
        deal(BASE_USDC, address(this), amount);
        if (IERC20(BASE_USDC).balanceOf(address(this)) < amount) {
            (address whale, bool ok) = _tryEnvAddress("BASE_USDC_WHALE");
            require(ok && whale != address(0), "BASE_USDC_WHALE env var required if deal() fails");
            vm.deal(whale, 1 ether);
            vm.startPrank(whale);
            IERC20(BASE_USDC).transfer(address(this), amount);
            vm.stopPrank();
        }
    }

    function _getRpcUrl() internal view returns (string memory) {
        (string memory apiKey, bool ok) = _tryEnvString("ALCHEMY_API_KEY");
        if (ok && bytes(apiKey).length > 0) {
            return string(abi.encodePacked("https://base-mainnet.g.alchemy.com/v2/", apiKey));
        }
        (string memory rpcUrl, bool hasUrl) = _tryEnvString("BASE_RPC_URL");
        require(hasUrl && bytes(rpcUrl).length > 0, "Set ALCHEMY_API_KEY or BASE_RPC_URL");
        return rpcUrl;
    }

    function _tryEnvString(string memory key) internal view returns (string memory, bool) {
        try vm.envString(key) returns (string memory value) {
            return (value, true);
        } catch {
            return ("", false);
        }
    }

    function _tryEnvAddress(string memory key) internal view returns (address, bool) {
        try vm.envAddress(key) returns (address value) {
            return (value, true);
        } catch {
            return (address(0), false);
        }
    }

    function _toBytes32(address value) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }
}
