// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { IPostIntentHookV2 } from "../../contracts/interfaces/IPostIntentHookV2.sol";
import { OrchestratorRegistry } from "../../contracts/registries/OrchestratorRegistry.sol";
import { AcrossBridgeHookV2 } from "../../contracts/hooks/AcrossBridgeHookV2.sol";
import { AcrossSpokePoolMock } from "../../contracts/mocks/AcrossSpokePoolMock.sol";
import { RejectEtherMock } from "../../contracts/mocks/RejectEtherMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract AcrossBridgeHookV2Test is Test {
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
    event FallbackTransfer(bytes32 indexed intentHash, address indexed recipient, uint256 amount, uint8 reason);
    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    uint256 internal constant USDC_UNIT = 1e6;
    uint256 internal constant ONE_ETHER = 1 ether;
    bytes32 internal constant VENMO = keccak256("venmo");
    bytes32 internal constant USD = keccak256("USD");
    address internal constant DEFAULT_RELAYER = 0x1562a70707d62EDbf3a90317E46E1df075E2D924;

    address internal owner;
    address internal orchestrator;
    address internal recipient;
    address internal attacker;

    USDCMock internal usdcToken;
    AcrossSpokePoolMock internal spokePool;
    OrchestratorRegistry internal orchestratorRegistry;
    AcrossBridgeHookV2 internal hook;

    function setUp() public {
        owner = makeAddr("owner");
        orchestrator = makeAddr("orchestrator");
        recipient = makeAddr("recipient");
        attacker = makeAddr("attacker");

        vm.deal(owner, 10 ether);

        vm.startPrank(owner);
        usdcToken = new USDCMock(_usdc(1_000_000), "USDC", "USDC");
        spokePool = new AcrossSpokePoolMock();
        orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(orchestrator);
        hook = new AcrossBridgeHookV2(address(usdcToken), address(orchestratorRegistry), address(spokePool));
        usdcToken.transfer(orchestrator, _usdc(1_000));
        vm.stopPrank();
    }

    function test_constructorSetsInitialVariables() public view {
        assertEq(address(hook.inputToken()), address(usdcToken));
        assertEq(address(hook.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(hook.spokePool()), address(spokePool));
        assertEq(hook.owner(), owner);
    }

    function test_constructorRevertsWhenAnyAddressIsZero() public {
        vm.startPrank(owner);
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(0), address(orchestratorRegistry), address(spokePool));

        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(usdcToken), address(0), address(spokePool));

        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(usdcToken), address(orchestratorRegistry), address(0));
        vm.stopPrank();
    }

    function test_executeBridgesSuccessfullyWithValidParameters() public {
        (
            IPostIntentHookV2.HookExecutionContext memory ctx,
            bytes memory fulfillHookData,
            AcrossBridgeHookV2.BridgeCommitment memory commitment
        ) = _buildExecutionFixture(700_000);

        uint256 orchestratorBalanceBefore = usdcToken.balanceOf(orchestrator);

        vm.expectEmit(true, false, false, true, address(hook));
        emit AcrossBridgeInitiated(
            ctx.intentHash,
            commitment.destinationChainId,
            commitment.outputToken,
            commitment.recipient,
            _usdc(50),
            700_000,
            21_600,
            _toBytes32(DEFAULT_RELAYER),
            5
        );

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(orchestratorBalanceBefore - usdcToken.balanceOf(orchestrator), _usdc(50));
        assertEq(usdcToken.balanceOf(address(hook)), 0);
        assertEq(usdcToken.balanceOf(address(spokePool)), _usdc(50));
        assertEq(spokePool.lastRecipient(), commitment.recipient);
        assertEq(spokePool.lastInputToken(), _toBytes32(address(usdcToken)));
        assertEq(spokePool.lastOutputToken(), commitment.outputToken);
        assertEq(spokePool.lastInputAmount(), _usdc(50));
        assertEq(spokePool.lastOutputAmount(), 700_000);
        assertEq(spokePool.lastDestinationChainId(), commitment.destinationChainId);
        assertEq(spokePool.lastFillDeadlineOffset(), 21_600);
        assertEq(spokePool.lastExclusiveRelayer(), _toBytes32(DEFAULT_RELAYER));
        assertEq(spokePool.lastExclusivityParameter(), 5);
        assertEq(spokePool.lastDepositor(), _toBytes32(address(hook)));
    }

    function test_executeRevertsWhenCallerIsNotRegisteredOrchestrator() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) = _buildExecutionFixture(700_000);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.UnauthorizedOrchestratorCaller.selector, attacker));
        hook.execute(ctx, fulfillHookData);
    }

    function test_executeRevertsWhenFulfillHookDataLengthIsInvalid() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx,,) = _buildExecutionFixture(700_000);
        bytes memory malformedData = abi.encode(uint256(700_000), uint32(21_600), _toBytes32(recipient));

        vm.prank(orchestrator);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidFulfillHookDataLength.selector, malformedData.length));
        hook.execute(ctx, malformedData);

        vm.prank(orchestrator);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidFulfillHookDataLength.selector, 0));
        hook.execute(ctx, "");
    }

    function test_executeFallsBackWhenOutputAmountIsBelowMinimum() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _defaultCommitment();
        IPostIntentHookV2.HookExecutionContext memory ctx = _buildContext(abi.encode(commitment), keccak256("intentHash"));
        bytes memory fulfillHookData = abi.encode(
            AcrossBridgeHookV2.AcrossFulfillData({
                outputAmount: commitment.minOutputAmount - 1,
                fillDeadlineOffset: 21_600,
                exclusiveRelayer: _toBytes32(DEFAULT_RELAYER),
                exclusivityParameter: 5
            })
        );

        uint256 orchestratorBalanceBefore = usdcToken.balanceOf(orchestrator);
        uint256 recipientBalanceBefore = usdcToken.balanceOf(recipient);

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(ctx.intentHash, recipient, _usdc(50), 0);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(orchestratorBalanceBefore - usdcToken.balanceOf(orchestrator), _usdc(50));
        assertEq(usdcToken.balanceOf(recipient) - recipientBalanceBefore, _usdc(50));
        assertEq(usdcToken.balanceOf(address(hook)), 0);
        assertEq(usdcToken.balanceOf(address(spokePool)), 0);
    }

    function test_executeFallsBackWhenBridgeCallReverts() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) = _buildExecutionFixture(700_000);
        uint256 recipientBalanceBefore = usdcToken.balanceOf(recipient);

        spokePool.setShouldRevert(true);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(ctx.intentHash, recipient, _usdc(50), 1);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(usdcToken.balanceOf(recipient) - recipientBalanceBefore, _usdc(50));
        assertEq(usdcToken.balanceOf(address(spokePool)), 0);
        assertEq(usdcToken.allowance(address(hook), address(spokePool)), 0);
    }

    function test_executeRevertsWhenDestinationChainIdIsZero() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.destinationChainId = 0;

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHookV2.InvalidDestinationChainId.selector, 0)
        );
    }

    function test_executeRevertsWhenRecipientIsZeroBytes32() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.recipient = bytes32(0);

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHookV2.InvalidRecipient.selector, bytes32(0))
        );
    }

    function test_executeRevertsWhenOutputTokenIsZeroBytes32() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.outputToken = bytes32(0);

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHookV2.InvalidOutputToken.selector, bytes32(0))
        );
    }

    function test_executeSucceedsWhenOutputAmountEqualsMinimumExactly() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) =
            _buildExecutionFixture(_defaultCommitment().minOutputAmount);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(usdcToken.balanceOf(address(spokePool)), _usdc(50));
    }

    function test_executeSupportsDifferentFillDeadlineOffsets() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) =
            _buildExecutionFixture(700_000, 1_800, _toBytes32(DEFAULT_RELAYER), 5);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(spokePool.lastFillDeadlineOffset(), 1_800);
    }

    function test_executePassesExclusiveRelayerAndExclusivityParameters() public {
        bytes32 customRelayer = _toBytes32(makeAddr("customRelayer"));
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) =
            _buildExecutionFixture(700_000, 21_600, customRelayer, 10);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(spokePool.lastExclusiveRelayer(), customRelayer);
        assertEq(spokePool.lastExclusivityParameter(), 10);
    }

    function test_executeSupportsOpenRelayWithZeroExclusivity() public {
        (IPostIntentHookV2.HookExecutionContext memory ctx, bytes memory fulfillHookData,) =
            _buildExecutionFixture(700_000, 21_600, bytes32(0), 0);

        vm.prank(orchestrator);
        hook.execute(ctx, fulfillHookData);

        assertEq(spokePool.lastExclusiveRelayer(), bytes32(0));
        assertEq(spokePool.lastExclusivityParameter(), 0);
    }

    function test_rescueERC20TransfersTokensAndEmitsEvent() public {
        USDCMock stuckToken = new USDCMock(_usdc(1_000), "STUCK", "STUCK");
        stuckToken.transfer(address(hook), _usdc(100));

        vm.expectEmit(true, true, false, true, address(hook));
        emit RescueERC20(address(stuckToken), recipient, _usdc(100));

        vm.prank(owner);
        hook.rescueERC20(address(stuckToken), recipient, _usdc(100));

        assertEq(stuckToken.balanceOf(recipient), _usdc(100));
    }

    function test_rescueERC20RevertsForUnauthorizedCallerOrZeroAddresses() public {
        USDCMock stuckToken = new USDCMock(_usdc(1_000), "STUCK", "STUCK");

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        hook.rescueERC20(address(stuckToken), recipient, _usdc(100));

        vm.prank(owner);
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        hook.rescueERC20(address(0), recipient, _usdc(100));

        vm.prank(owner);
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        hook.rescueERC20(address(stuckToken), address(0), _usdc(100));
    }

    function test_rescueNativeTransfersEthAllowsPartialRescueAndEmitsEvent() public {
        _fundHookNative(ONE_ETHER);

        vm.expectEmit(true, false, false, true, address(hook));
        emit RescueNative(recipient, ONE_ETHER / 2);

        vm.prank(owner);
        hook.rescueNative(payable(recipient), ONE_ETHER / 2);

        assertEq(address(hook).balance, ONE_ETHER / 2);
        assertEq(recipient.balance, ONE_ETHER / 2);
    }

    function test_rescueNativeRevertsForUnauthorizedCallerZeroRecipientOrFailedTransfer() public {
        _fundHookNative(ONE_ETHER);
        RejectEtherMock rejectEther = new RejectEtherMock();

        vm.prank(attacker);
        vm.expectRevert("Ownable: caller is not the owner");
        hook.rescueNative(payable(recipient), ONE_ETHER);

        vm.prank(owner);
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        hook.rescueNative(payable(address(0)), ONE_ETHER);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AcrossBridgeHookV2.NativeTransferFailed.selector, address(rejectEther), ONE_ETHER)
        );
        hook.rescueNative(payable(address(rejectEther)), ONE_ETHER);
    }

    function test_receiveAcceptsNativeTransfers() public {
        _fundHookNative(ONE_ETHER);
        assertEq(address(hook).balance, ONE_ETHER);
    }

    function _buildExecutionFixture(uint256 outputAmount)
        internal
        returns (
            IPostIntentHookV2.HookExecutionContext memory ctx,
            bytes memory fulfillHookData,
            AcrossBridgeHookV2.BridgeCommitment memory commitment
        )
    {
        return _buildExecutionFixture(outputAmount, 21_600, _toBytes32(DEFAULT_RELAYER), 5);
    }

    function _buildExecutionFixture(
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    )
        internal
        returns (
            IPostIntentHookV2.HookExecutionContext memory ctx,
            bytes memory fulfillHookData,
            AcrossBridgeHookV2.BridgeCommitment memory commitment
        )
    {
        commitment = _defaultCommitment();
        ctx = _buildContext(abi.encode(commitment), keccak256("intentHash"));
        fulfillHookData = abi.encode(
            AcrossBridgeHookV2.AcrossFulfillData({
                outputAmount: outputAmount,
                fillDeadlineOffset: fillDeadlineOffset,
                exclusiveRelayer: exclusiveRelayer,
                exclusivityParameter: exclusivityParameter
            })
        );

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));
    }

    function _buildContext(bytes memory signalHookData, bytes32 intentHash)
        internal
        view
        returns (IPostIntentHookV2.HookExecutionContext memory ctx)
    {
        ctx = IPostIntentHookV2.HookExecutionContext({
            intentHash: intentHash,
            token: address(usdcToken),
            executableAmount: _usdc(50),
            intent: IPostIntentHookV2.HookIntentContext({
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
                signalHookData: signalHookData
            })
        });
    }

    function _expectInvalidCommitmentRevert(
        AcrossBridgeHookV2.BridgeCommitment memory commitment,
        bytes memory revertData
    ) internal {
        IPostIntentHookV2.HookExecutionContext memory ctx = _buildContext(abi.encode(commitment), keccak256("intentHash"));
        bytes memory fulfillHookData = abi.encode(
            AcrossBridgeHookV2.AcrossFulfillData({
                outputAmount: 700_000,
                fillDeadlineOffset: 21_600,
                exclusiveRelayer: _toBytes32(DEFAULT_RELAYER),
                exclusivityParameter: 5
            })
        );

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));

        vm.prank(orchestrator);
        vm.expectRevert(revertData);
        hook.execute(ctx, fulfillHookData);
    }

    function _defaultCommitment() internal view returns (AcrossBridgeHookV2.BridgeCommitment memory commitment) {
        commitment = AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: 10,
            outputToken: _toBytes32(recipient),
            recipient: _toBytes32(recipient),
            minOutputAmount: 500_000
        });
    }

    function _fundHookNative(uint256 amount) internal {
        vm.prank(owner);
        (bool success,) = payable(address(hook)).call{ value: amount }("");
        require(success, "native funding failed");
    }

    function _toBytes32(address addr) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(addr)));
    }

    function _usdc(uint256 wholeAmount) internal pure returns (uint256) {
        return wholeAmount * USDC_UNIT;
    }
}
