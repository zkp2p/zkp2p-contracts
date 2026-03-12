// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";
import { AcrossBridgeHook } from "../../contracts/hooks/AcrossBridgeHook.sol";
import { AcrossSpokePoolMock } from "../../contracts/mocks/AcrossSpokePoolMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract AcrossBridgeHookFuzzTest is Test {
    uint256 internal constant USDC_UNIT = 1e6;
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");

    address internal owner;
    address internal orchestrator;
    address internal recipient;

    USDCMock internal usdcToken;
    AcrossSpokePoolMock internal spokePool;
    AcrossBridgeHook internal hook;

    function setUp() public {
        owner = makeAddr("owner");
        orchestrator = makeAddr("orchestrator");
        recipient = makeAddr("recipient");

        vm.startPrank(owner);
        usdcToken = new USDCMock(_usdc(1_000_000), "USDC", "USDC");
        spokePool = new AcrossSpokePoolMock();
        hook = new AcrossBridgeHook(address(usdcToken), orchestrator, address(spokePool));
        usdcToken.transfer(orchestrator, _usdc(1_000));
        vm.stopPrank();
    }

    function testFuzz_executeFallsBackWhenQuoteIsBelowCommitmentMinimum(
        uint96 rawMinimumOutput,
        uint96 rawShortfall,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    ) public {
        uint256 minimumOutput = bound(uint256(rawMinimumOutput), 1, type(uint96).max);
        uint256 shortfall = bound(uint256(rawShortfall), 1, minimumOutput);
        uint256 quotedOutput = minimumOutput - shortfall;

        AcrossBridgeHook.BridgeCommitment memory commitment = _buildCommitment(minimumOutput);
        bytes32 intentHash = keccak256("fuzzFallbackIntent");
        IOrchestrator.Intent memory intent = _buildIntent(abi.encode(commitment));
        bytes memory fulfillData = abi.encode(
            AcrossBridgeHook.AcrossFulfillData({
                intentHash: intentHash,
                outputAmount: quotedOutput,
                fillDeadlineOffset: fillDeadlineOffset,
                exclusiveRelayer: exclusiveRelayer,
                exclusivityParameter: exclusivityParameter
            })
        );

        uint256 recipientBalanceBefore = usdcToken.balanceOf(recipient);
        uint256 orchestratorBalanceBefore = usdcToken.balanceOf(orchestrator);

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(usdcToken.balanceOf(recipient) - recipientBalanceBefore, _usdc(50));
        assertEq(orchestratorBalanceBefore - usdcToken.balanceOf(orchestrator), _usdc(50));
        assertEq(usdcToken.balanceOf(address(spokePool)), 0);
        assertEq(usdcToken.balanceOf(address(hook)), 0);
        assertEq(usdcToken.allowance(address(hook), address(spokePool)), 0);
    }

    function testFuzz_executeBridgesAndPreservesAcrossParametersWhenQuoteMeetsMinimum(
        uint96 rawMinimumOutput,
        uint96 rawExcessOutput,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    ) public {
        uint256 minimumOutput = bound(uint256(rawMinimumOutput), 0, type(uint96).max);
        uint256 maxExcess = type(uint96).max - minimumOutput;
        uint256 excessOutput = bound(uint256(rawExcessOutput), 0, maxExcess);
        uint256 quotedOutput = minimumOutput + excessOutput;

        AcrossBridgeHook.BridgeCommitment memory commitment = _buildCommitment(minimumOutput);
        bytes32 intentHash = keccak256("fuzzBridgeIntent");
        IOrchestrator.Intent memory intent = _buildIntent(abi.encode(commitment));
        bytes memory fulfillData = abi.encode(
            AcrossBridgeHook.AcrossFulfillData({
                intentHash: intentHash,
                outputAmount: quotedOutput,
                fillDeadlineOffset: fillDeadlineOffset,
                exclusiveRelayer: exclusiveRelayer,
                exclusivityParameter: exclusivityParameter
            })
        );

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(usdcToken.balanceOf(address(spokePool)), _usdc(50));
        assertEq(usdcToken.balanceOf(address(hook)), 0);
        assertEq(usdcToken.allowance(address(hook), address(spokePool)), 0);
        assertEq(spokePool.lastOutputAmount(), quotedOutput);
        assertEq(spokePool.lastFillDeadlineOffset(), fillDeadlineOffset);
        assertEq(spokePool.lastExclusiveRelayer(), exclusiveRelayer);
        assertEq(spokePool.lastExclusivityParameter(), exclusivityParameter);
    }

    function _buildCommitment(uint256 minimumOutput)
        internal
        view
        returns (AcrossBridgeHook.BridgeCommitment memory commitment)
    {
        commitment = AcrossBridgeHook.BridgeCommitment({
            destinationChainId: 10,
            outputToken: _toBytes32(recipient),
            recipient: _toBytes32(recipient),
            minOutputAmount: minimumOutput
        });
    }

    function _buildIntent(bytes memory commitmentData) internal view returns (IOrchestrator.Intent memory intent) {
        intent = IOrchestrator.Intent({
            owner: owner,
            to: recipient,
            escrow: owner,
            depositId: 1,
            amount: _usdc(100),
            timestamp: block.timestamp,
            paymentMethod: VENMO,
            fiatCurrency: USD,
            conversionRate: 1 ether,
            payeeId: keccak256("payee"),
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(0)),
            data: commitmentData
        });
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function _usdc(uint256 wholeAmount) internal pure returns (uint256) {
        return wholeAmount * USDC_UNIT;
    }
}
