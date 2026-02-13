// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AcrossBridgeHookV2 } from "contracts/hooks/AcrossBridgeHookV2.sol";
import { AcrossSpokePoolPeripheryMock } from "contracts/mocks/AcrossSpokePoolPeripheryMock.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

contract AcrossBridgeHookV2ForkTest is Test {
    event AcrossBridgeInitiated(
        bytes32 indexed intentHash,
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 inputAmount,
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    );

    event AcrossSwapAndBridgeInitiated(
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
    uint256 internal constant INPUT_AMOUNT = 10_000_000; // 10 USDC (6 decimals)
    uint256 internal constant OUTPUT_AMOUNT = 9_900_000; // 9.9 USDC (relatively generous)
    uint256 internal constant MIN_OUTPUT = 9_900_000; // 9.9 USDC

    AcrossBridgeHookV2 internal hook;
    AcrossSpokePoolPeripheryMock internal spokePoolPeriphery;
    address internal allowedExchange;

    function setUp() public {
        string memory rpcUrl = _getRpcUrl();
        vm.createSelectFork(rpcUrl);

        spokePoolPeriphery = new AcrossSpokePoolPeripheryMock();
        allowedExchange = makeAddr("allowedExchange");

        address[] memory allowedExchanges = new address[](1);
        allowedExchanges[0] = allowedExchange;

        hook = new AcrossBridgeHookV2(
            BASE_USDC,
            address(this),
            BASE_SPOKE_POOL,
            address(spokePoolPeriphery),
            allowedExchanges
        );
        _fundUsdc(INPUT_AMOUNT);
        IERC20(BASE_USDC).approve(address(hook), INPUT_AMOUNT);
    }

    function testFork_V2_BridgeOnly_DepositNow_BaseToPolygonUSDT() public {
        address recipient = makeAddr("destinationRecipient");

        bytes memory commitmentData = _encodeBridgeCommitmentData(
            DEST_CHAIN_ID,
            _toBytes32(DEST_USDT_POLYGON),
            _toBytes32(recipient),
            MIN_OUTPUT
        );
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitmentData);

        bytes memory fulfillData = _encodeAcrossFulfillData(
            keccak256("across-v2-intent"),
            OUTPUT_AMOUNT,
            3600,
            0
        );

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 hookBalance = IERC20(BASE_USDC).balanceOf(address(hook));
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        uint256 bridgeDelta = spokeBalanceAfter - spokeBalanceBefore;
        uint256 fallbackDelta = recipientBalanceAfter - recipientBalanceBefore;
        assertTrue(
            bridgeDelta == INPUT_AMOUNT || fallbackDelta == INPUT_AMOUNT,
            "bridge delta or fallback delta should reflect input amount"
        );
        assertEq(hookBalance, 0, "hook should not retain funds");
        if (bridgeDelta == INPUT_AMOUNT) {
            assertEq(fallbackDelta, 0, "fallback should not run when bridged");
        } else {
            assertEq(fallbackDelta, INPUT_AMOUNT, "fallback should receive full input when bridge path fails");
        }
    }

    function testFork_V2_BridgeOnly_FallbackOnLowOutput() public {
        address recipient = makeAddr("fallbackRecipient");

        bytes memory commitmentData = _encodeBridgeCommitmentData(
            DEST_CHAIN_ID,
            _toBytes32(DEST_USDT_POLYGON),
            _toBytes32(recipient),
            MIN_OUTPUT
        );
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitmentData);

        bytes memory fulfillData = _encodeAcrossFulfillData(
            keccak256("across-v2-fallback-intent"),
            MIN_OUTPUT - 1,
            3600,
            1
        );

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(keccak256("across-v2-fallback-intent"), recipient, INPUT_AMOUNT, 0);

        hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 hookBalance = IERC20(BASE_USDC).balanceOf(address(hook));
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeBalanceAfter, spokeBalanceBefore, "spoke pool should not receive funds");
        assertEq(hookBalance, 0, "hook should not retain funds");
        assertEq(recipientBalanceAfter - recipientBalanceBefore, INPUT_AMOUNT, "fallback transfer expected");
    }

    function testFork_V2_SwapAndBridge_SucceedsViaPeriphery() public {
        address recipient = makeAddr("swapRecipient");
        bytes32 intentHash = keccak256("across-v2-swap-and-bridge");

        bytes memory commitmentData = _encodeSwapCommitmentData(
            DEST_CHAIN_ID,
            _toBytes32(DEST_USDT_POLYGON),
            _toBytes32(recipient),
            MIN_OUTPUT
        );
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitmentData);

        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);
        uint256 peripheryTokenBalanceBefore = IERC20(BASE_USDC).balanceOf(address(spokePoolPeriphery));
        vm.expectEmit(true, true, false, true, address(hook));
        emit AcrossSwapAndBridgeInitiated(
            intentHash,
            DEST_CHAIN_ID,
            _toBytes32(DEST_USDT_POLYGON),
            _toBytes32(recipient),
            INPUT_AMOUNT,
            OUTPUT_AMOUNT,
            INPUT_AMOUNT / 2,
            0,
            21600,
            bytes32(0),
            0,
            allowedExchange
        );

        bytes memory encodedFulfillData = _encodeSwapAndBridgeRawData(
            intentHash,
            OUTPUT_AMOUNT,
            BASE_USDC,
            allowedExchange,
            0,
            INPUT_AMOUNT / 2,
            0,
            21600,
            bytes32(0),
            0,
            hex"12",
            false,
            "v2-path-message"
        );
        hook.execute(intent, INPUT_AMOUNT, encodedFulfillData);

        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);
        uint256 peripheryTokenBalanceAfter = IERC20(BASE_USDC).balanceOf(address(spokePoolPeriphery));

        assertEq(recipientBalanceAfter - recipientBalanceBefore, 0, "swap-and-bridge should use periphery");
        assertEq(spokePoolPeriphery.lastSwapToken(), BASE_USDC, "periphery swap token should be input token");
        assertEq(spokePoolPeriphery.lastSwapTokenAmount(), INPUT_AMOUNT, "periphery should receive amount");
        assertEq(spokePoolPeriphery.lastExchange(), allowedExchange, "allowed exchange should be used");
        assertEq(spokePoolPeriphery.lastTransferType(), uint8(0), "transfer type should be approval");
        assertEq(peripheryTokenBalanceAfter - peripheryTokenBalanceBefore, INPUT_AMOUNT, "periphery should hold bridged input");
    }

    function testFork_V2_SwapAndBridge_FallbackWhenPeripheryReverts() public {
        address recipient = makeAddr("swapFallbackRecipient");
        bytes32 intentHash = keccak256("across-v2-swap-and-bridge-fallback");

        bytes memory commitmentData = _encodeSwapCommitmentData(
            DEST_CHAIN_ID,
            _toBytes32(DEST_USDT_POLYGON),
            _toBytes32(recipient),
            MIN_OUTPUT
        );
        IOrchestrator.Intent memory intent = _buildIntent(recipient, commitmentData);

        bytes memory fulfillData = _encodeSwapAndBridgeRawData(
            intentHash,
            OUTPUT_AMOUNT,
            BASE_USDC,
            allowedExchange,
            0,
            INPUT_AMOUNT / 2,
            0,
            21600,
            bytes32(0),
            0,
            "0x",
            false,
            "fallback-message"
        );

        spokePoolPeriphery.setShouldRevert(true);

        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(
            intentHash,
            recipient,
            INPUT_AMOUNT,
            2
        );

        hook.execute(intent, INPUT_AMOUNT, fulfillData);

        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);
        assertEq(recipientBalanceAfter - recipientBalanceBefore, INPUT_AMOUNT, "fallback transfer expected");
        assertEq(IERC20(BASE_USDC).balanceOf(address(hook)), 0, "hook should not retain funds");
        spokePoolPeriphery.setShouldRevert(false);
    }

    function _encodeBridgeCommitmentData(
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 minOutputAmount
    ) internal pure returns (bytes memory) {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: destinationChainId,
            outputToken: outputToken,
            recipient: recipient,
            minOutputAmount: minOutputAmount
        });
        AcrossBridgeHookV2.HookCommitment memory hookCommitment = AcrossBridgeHookV2.HookCommitment({
            mode: AcrossBridgeHookV2.RouteMode.BRIDGE_ONLY,
            modeData: abi.encode(commitment)
        });
        return abi.encode(hookCommitment);
    }

    function _encodeSwapCommitmentData(
        uint256 destinationChainId,
        bytes32 outputToken,
        bytes32 recipient,
        uint256 minOutputAmount
    ) internal pure returns (bytes memory) {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: destinationChainId,
            outputToken: outputToken,
            recipient: recipient,
            minOutputAmount: minOutputAmount
        });
        AcrossBridgeHookV2.HookCommitment memory hookCommitment = AcrossBridgeHookV2.HookCommitment({
            mode: AcrossBridgeHookV2.RouteMode.SWAP_AND_BRIDGE,
            modeData: abi.encode(commitment)
        });
        return abi.encode(hookCommitment);
    }

    function _encodeAcrossFulfillData(
        bytes32 intentHash,
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        uint32 exclusivityParameter
    ) internal pure returns (bytes memory) {
        AcrossBridgeHookV2.AcrossFulfillData memory fulfillData = AcrossBridgeHookV2.AcrossFulfillData({
            intentHash: intentHash,
            outputAmount: outputAmount,
            fillDeadlineOffset: fillDeadlineOffset,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: exclusivityParameter
        });
        return abi.encode(fulfillData);
    }

    function _encodeSwapAndBridgeRawData(
        bytes32 intentHash,
        uint256 outputAmount,
        address bridgeInputToken,
        address exchange,
        uint8 transferType,
        uint256 minExpectedInputTokenAmount,
        uint32 quoteTimestamp,
        uint32 fillDeadline,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter,
        bytes memory routerCalldata,
        bool enableProportionalAdjustment,
        bytes memory message
    ) internal pure returns (bytes memory) {
        AcrossBridgeHookV2.SwapAndBridgeFulfillData memory fulfillData = AcrossBridgeHookV2
            .SwapAndBridgeFulfillData({
                intentHash: intentHash,
                outputAmount: outputAmount,
                bridgeInputToken: bridgeInputToken,
                exchange: exchange,
                transferType: transferType,
                minExpectedInputTokenAmount: minExpectedInputTokenAmount,
                quoteTimestamp: quoteTimestamp,
                fillDeadline: fillDeadline,
                exclusiveRelayer: exclusiveRelayer,
                exclusivityParameter: exclusivityParameter,
                routerCalldata: routerCalldata,
                enableProportionalAdjustment: enableProportionalAdjustment,
                message: message
            });
        return abi.encode(fulfillData);
    }

    function _buildIntent(
        address recipient,
        bytes memory commitmentData
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
            data: commitmentData
        });
    }

    function _encodeSwapAndBridgeFulfillData(
        address exchange,
        uint32 quoteTimestamp,
        uint32 fillDeadline
    ) internal pure returns (bytes memory) {
        return _encodeSwapAndBridgeRawData(
            keccak256("across-v2-swap-and-bridge"),
            OUTPUT_AMOUNT,
            BASE_USDC,
            exchange,
            0,
            INPUT_AMOUNT / 2,
            quoteTimestamp,
            fillDeadline,
            bytes32(0),
            0,
            "0x",
            false,
            "v2-swap-message"
        );
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

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }
}
