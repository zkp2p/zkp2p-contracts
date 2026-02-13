// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";
import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { AcrossBridgeHookV2 } from "contracts/hooks/AcrossBridgeHookV2.sol";
import { IOrchestrator } from "contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "contracts/interfaces/IPostIntentHook.sol";

interface ISpokePoolPeripheryView {
    function swapProxy() external view returns (address);
}

contract DeterministicSwapExchange {
    function swap(address outputToken, uint256 outputAmount) external {
        IERC20(outputToken).transfer(msg.sender, outputAmount);
    }
}

contract RevertingSwapExchange {
    error ForcedSwapFailure();

    function swap() external pure {
        revert ForcedSwapFailure();
    }
}

contract AcrossBridgeHookV2ForkTest is Test {
    event FallbackTransfer(bytes32 indexed intentHash, address indexed recipient, uint256 amount, uint8 reason);

    address internal constant BASE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant BASE_USDT = 0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2;

    address internal constant BASE_SPOKE_POOL = 0x09aea4b2242abC8bb4BB78D537A67a245A7bEC64;
    address internal constant BASE_SPOKE_POOL_PERIPHERY = 0x767e4c20F521a829dE4Ffc40C25176676878147f;

    address internal constant DEST_USDC_ARBITRUM = 0xaf88d065e77c8cC2239327C5EDb3A432268e5831;
    address internal constant DEST_USDT_ARBITRUM = 0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9;

    uint256 internal constant ARBITRUM_CHAIN_ID = 42161;

    uint256 internal constant INPUT_AMOUNT = 1_000_000; // 1 USDC

    uint256 internal constant BRIDGE_OUTPUT_AMOUNT = 980_000;
    uint256 internal constant BRIDGE_MIN_OUTPUT = 950_000;

    uint256 internal constant SWAP_RETURN_AMOUNT = 970_000;
    uint256 internal constant SWAP_OUTPUT_AMOUNT = 960_000;
    uint256 internal constant SWAP_MIN_OUTPUT = 900_000;

    AcrossBridgeHookV2 internal hook;
    DeterministicSwapExchange internal deterministicExchange;
    RevertingSwapExchange internal revertingExchange;

    function setUp() public {
        vm.createSelectFork(_getRpcUrl());

        hook = new AcrossBridgeHookV2(
            BASE_USDC,
            address(this),
            BASE_SPOKE_POOL,
            BASE_SPOKE_POOL_PERIPHERY
        );

        deterministicExchange = new DeterministicSwapExchange();
        revertingExchange = new RevertingSwapExchange();

        hook.setExchangeAllowed(address(deterministicExchange), true);
        hook.setExchangeAllowed(address(revertingExchange), true);

        _fundToken(BASE_USDC, address(this), INPUT_AMOUNT * 10, "BASE_USDC_WHALE");
        IERC20(BASE_USDC).approve(address(hook), type(uint256).max);
    }

    function testForkV2_BridgeOnly_DepositNow_BaseToArbitrumUSDC() public {
        address recipient = makeAddr("bridgeRecipient");

        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: ARBITRUM_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDC_ARBITRUM),
            recipient: _toBytes32(recipient),
            minOutputAmount: BRIDGE_MIN_OUTPUT
        });

        IOrchestrator.Intent memory intent = _buildIntent(recipient, _encodeCommitment(0, abi.encode(commitment)));

        AcrossBridgeHookV2.AcrossFulfillData memory fulfill = AcrossBridgeHookV2.AcrossFulfillData({
            intentHash: keccak256("across-v2-bridge"),
            outputAmount: BRIDGE_OUTPUT_AMOUNT,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0
        });

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfill));

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeBalanceAfter - spokeBalanceBefore, INPUT_AMOUNT, "spoke pool should receive bridged USDC");
        assertEq(recipientBalanceAfter - recipientBalanceBefore, 0, "no fallback transfer expected");
        assertEq(IERC20(BASE_USDC).balanceOf(address(hook)), 0, "hook should not retain USDC");
    }

    function testForkV2_BridgeOnly_RawLegacyCommitmentPayloadReverts() public {
        address recipient = makeAddr("legacyRecipient");

        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: ARBITRUM_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDC_ARBITRUM),
            recipient: _toBytes32(recipient),
            minOutputAmount: BRIDGE_MIN_OUTPUT
        });

        IOrchestrator.Intent memory intent = _buildIntent(recipient, abi.encode(commitment));

        AcrossBridgeHookV2.AcrossFulfillData memory fulfill = AcrossBridgeHookV2.AcrossFulfillData({
            intentHash: keccak256("across-v2-legacy-reject"),
            outputAmount: BRIDGE_OUTPUT_AMOUNT,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0
        });

        vm.expectRevert();
        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfill));
    }

    function testForkV2_SwapAndBridge_RealPeriphery_DeterministicExchange() public {
        address recipient = makeAddr("swapRecipient");

        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: ARBITRUM_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDT_ARBITRUM),
            recipient: _toBytes32(recipient),
            minOutputAmount: SWAP_MIN_OUTPUT
        });

        IOrchestrator.Intent memory intent = _buildIntent(recipient, _encodeCommitment(1, abi.encode(commitment)));

        bytes memory routerCalldata = abi.encodeCall(
            DeterministicSwapExchange.swap,
            (BASE_USDT, SWAP_RETURN_AMOUNT)
        );

        AcrossBridgeHookV2.SwapAndBridgeFulfillData memory fulfill = AcrossBridgeHookV2.SwapAndBridgeFulfillData({
            intentHash: keccak256("across-v2-swap-success"),
            outputAmount: SWAP_OUTPUT_AMOUNT,
            bridgeInputToken: BASE_USDT,
            exchange: address(deterministicExchange),
            transferType: 1,
            minExpectedInputTokenAmount: SWAP_RETURN_AMOUNT,
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 2 hours),
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0,
            routerCalldata: routerCalldata,
            enableProportionalAdjustment: false,
            message: ""
        });

        _fundToken(BASE_USDT, address(deterministicExchange), SWAP_RETURN_AMOUNT, "BASE_USDT_WHALE");

        address swapProxy = ISpokePoolPeripheryView(BASE_SPOKE_POOL_PERIPHERY).swapProxy();
        uint256 swapProxyUsdtBalanceBefore = IERC20(BASE_USDT).balanceOf(swapProxy);
        uint256 spokeUsdtBalanceBefore = IERC20(BASE_USDT).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientUsdcBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfill));

        uint256 spokeUsdtBalanceAfter = IERC20(BASE_USDT).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientUsdcBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        uint256 expectedDepositAmount = swapProxyUsdtBalanceBefore + SWAP_RETURN_AMOUNT;
        assertEq(
            spokeUsdtBalanceAfter - spokeUsdtBalanceBefore,
            expectedDepositAmount,
            "spoke pool should receive swapped USDT"
        );
        assertEq(recipientUsdcBalanceAfter - recipientUsdcBalanceBefore, 0, "no fallback transfer expected");
        assertEq(IERC20(BASE_USDC).balanceOf(address(hook)), 0, "hook should not retain USDC");
    }

    function testForkV2_SwapAndBridge_FallbackWhenSwapPathReverts() public {
        address recipient = makeAddr("swapFallbackRecipient");
        bytes32 intentHash = keccak256("across-v2-swap-fallback");

        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: ARBITRUM_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDT_ARBITRUM),
            recipient: _toBytes32(recipient),
            minOutputAmount: SWAP_MIN_OUTPUT
        });

        IOrchestrator.Intent memory intent = _buildIntent(recipient, _encodeCommitment(1, abi.encode(commitment)));

        bytes memory routerCalldata = abi.encodeCall(RevertingSwapExchange.swap, ());

        AcrossBridgeHookV2.SwapAndBridgeFulfillData memory fulfill = AcrossBridgeHookV2.SwapAndBridgeFulfillData({
            intentHash: intentHash,
            outputAmount: SWAP_OUTPUT_AMOUNT,
            bridgeInputToken: BASE_USDT,
            exchange: address(revertingExchange),
            transferType: 1,
            minExpectedInputTokenAmount: SWAP_RETURN_AMOUNT,
            quoteTimestamp: uint32(block.timestamp),
            fillDeadline: uint32(block.timestamp + 2 hours),
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0,
            routerCalldata: routerCalldata,
            enableProportionalAdjustment: false,
            message: ""
        });

        uint256 spokeUsdtBalanceBefore = IERC20(BASE_USDT).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientUsdcBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(intentHash, recipient, INPUT_AMOUNT, 2);

        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfill));

        uint256 spokeUsdtBalanceAfter = IERC20(BASE_USDT).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientUsdcBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeUsdtBalanceAfter, spokeUsdtBalanceBefore, "spoke pool should not receive USDT on fallback");
        assertEq(
            recipientUsdcBalanceAfter - recipientUsdcBalanceBefore,
            INPUT_AMOUNT,
            "recipient should receive fallback USDC"
        );
        assertEq(IERC20(BASE_USDC).balanceOf(address(hook)), 0, "hook should not retain USDC");
    }

    function testForkV2_BridgeOnly_FallbackWhenOutputBelowMinimum() public {
        address recipient = makeAddr("bridgeFallbackRecipient");
        bytes32 intentHash = keccak256("across-v2-min-output-fallback");

        AcrossBridgeHookV2.BridgeCommitment memory commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: ARBITRUM_CHAIN_ID,
            outputToken: _toBytes32(DEST_USDC_ARBITRUM),
            recipient: _toBytes32(recipient),
            minOutputAmount: BRIDGE_OUTPUT_AMOUNT
        });

        IOrchestrator.Intent memory intent = _buildIntent(recipient, _encodeCommitment(0, abi.encode(commitment)));

        AcrossBridgeHookV2.AcrossFulfillData memory fulfill = AcrossBridgeHookV2.AcrossFulfillData({
            intentHash: intentHash,
            outputAmount: BRIDGE_OUTPUT_AMOUNT - 1,
            fillDeadlineOffset: 3600,
            exclusiveRelayer: bytes32(0),
            exclusivityParameter: 0
        });

        uint256 spokeBalanceBefore = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceBefore = IERC20(BASE_USDC).balanceOf(recipient);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(intentHash, recipient, INPUT_AMOUNT, 0);

        hook.execute(intent, INPUT_AMOUNT, abi.encode(fulfill));

        uint256 spokeBalanceAfter = IERC20(BASE_USDC).balanceOf(BASE_SPOKE_POOL);
        uint256 recipientBalanceAfter = IERC20(BASE_USDC).balanceOf(recipient);

        assertEq(spokeBalanceAfter, spokeBalanceBefore, "spoke pool should not receive USDC when output below minimum");
        assertEq(recipientBalanceAfter - recipientBalanceBefore, INPUT_AMOUNT, "recipient should receive fallback USDC");
        assertEq(IERC20(BASE_USDC).balanceOf(address(hook)), 0, "hook should not retain USDC");
    }

    function _buildIntent(address recipient, bytes memory commitmentData)
        internal
        view
        returns (IOrchestrator.Intent memory intent)
    {
        intent = IOrchestrator.Intent({
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

    function _encodeCommitment(uint8 mode, bytes memory modeData) internal pure returns (bytes memory) {
        AcrossBridgeHookV2.HookCommitment memory envelope = AcrossBridgeHookV2.HookCommitment({
            mode: AcrossBridgeHookV2.RouteMode(mode),
            modeData: modeData
        });
        return abi.encode(envelope);
    }

    function _fundToken(address token, address recipient, uint256 amount, string memory whaleEnvKey) internal {
        deal(token, recipient, amount);
        if (IERC20(token).balanceOf(recipient) >= amount) return;

        (address whale, bool ok) = _tryEnvAddress(whaleEnvKey);
        require(ok && whale != address(0), "whale env var required if deal() fails");

        vm.deal(whale, 1 ether);
        vm.startPrank(whale);
        IERC20(token).transfer(recipient, amount);
        vm.stopPrank();
    }

    function _getRpcUrl() internal view returns (string memory) {
        (string memory apiKey, bool ok) = _tryEnvString("ALCHEMY_API_KEY");
        if (ok && bytes(apiKey).length > 0) {
            return string(abi.encodePacked("https://base-mainnet.g.alchemy.com/v2/", apiKey));
        }

        (string memory rpcUrl, bool hasUrl) = _tryEnvString("BASE_RPC_URL");
        if (hasUrl && bytes(rpcUrl).length > 0) {
            return rpcUrl;
        }

        return "https://mainnet.base.org";
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
