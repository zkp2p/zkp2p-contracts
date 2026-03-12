// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Test } from "forge-std/Test.sol";

import { IOrchestrator } from "../../contracts/interfaces/IOrchestrator.sol";
import { IPostIntentHook } from "../../contracts/interfaces/IPostIntentHook.sol";
import { AcrossBridgeHook } from "../../contracts/hooks/AcrossBridgeHook.sol";
import { AcrossSpokePoolMock } from "../../contracts/mocks/AcrossSpokePoolMock.sol";
import { RejectEtherMock } from "../../contracts/mocks/RejectEtherMock.sol";
import { USDCMock } from "../../contracts/mocks/USDCMock.sol";

contract AcrossBridgeHookTest is Test {
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
    AcrossBridgeHook internal hook;

    function setUp() public {
        owner = makeAddr("owner");
        orchestrator = makeAddr("orchestrator");
        recipient = makeAddr("recipient");
        attacker = makeAddr("attacker");

        vm.deal(owner, 10 ether);

        vm.startPrank(owner);
        usdcToken = new USDCMock(_usdc(1_000_000), "USDC", "USDC");
        spokePool = new AcrossSpokePoolMock();
        hook = new AcrossBridgeHook(address(usdcToken), orchestrator, address(spokePool));
        usdcToken.transfer(orchestrator, _usdc(1_000));
        vm.stopPrank();
    }

    function test_constructorSetsInitialVariables() public view {
        assertEq(address(hook.inputToken()), address(usdcToken));
        assertEq(hook.orchestrator(), orchestrator);
        assertEq(address(hook.spokePool()), address(spokePool));
        assertEq(hook.owner(), owner);
    }

    function test_constructorRevertsWhenAnyAddressIsZero() public {
        vm.startPrank(owner);
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(0), orchestrator, address(spokePool));

        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(usdcToken), address(0), address(spokePool));

        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(usdcToken), orchestrator, address(0));
        vm.stopPrank();
    }

    function test_executeBridgesSuccessfullyWithValidParameters() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData, bytes32 intentHash,, AcrossBridgeHook.BridgeCommitment memory commitment) =
            _buildExecutionFixture(700_000);

        uint256 orchestratorBalanceBefore = usdcToken.balanceOf(orchestrator);

        vm.expectEmit(true, false, false, true, address(hook));
        emit AcrossBridgeInitiated(
            intentHash,
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
        hook.execute(intent, _usdc(50), fulfillData);

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

    function test_executeRevertsWhenCallerIsNotOrchestrator() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData,,,) = _buildExecutionFixture(700_000);

        vm.prank(attacker);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHook.UnauthorizedCaller.selector, attacker));
        hook.execute(intent, _usdc(50), fulfillData);
    }

    function test_executeFallsBackWhenOutputAmountIsBelowMinimum() public {
        bytes32 intentHash = keccak256("intentHash");
        AcrossBridgeHook.BridgeCommitment memory commitment = _defaultCommitment();
        bytes memory commitmentData = abi.encode(commitment);
        IOrchestrator.Intent memory intent = _buildIntent(commitmentData);
        bytes memory fulfillData = abi.encode(
            AcrossBridgeHook.AcrossFulfillData({
                intentHash: intentHash,
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
        emit FallbackTransfer(intentHash, recipient, _usdc(50), 0);

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(orchestratorBalanceBefore - usdcToken.balanceOf(orchestrator), _usdc(50));
        assertEq(usdcToken.balanceOf(recipient) - recipientBalanceBefore, _usdc(50));
        assertEq(usdcToken.balanceOf(address(hook)), 0);
        assertEq(usdcToken.balanceOf(address(spokePool)), 0);
    }

    function test_executeFallsBackWhenBridgeCallReverts() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData, bytes32 intentHash,,) = _buildExecutionFixture(700_000);
        uint256 recipientBalanceBefore = usdcToken.balanceOf(recipient);

        spokePool.setShouldRevert(true);

        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(intentHash, recipient, _usdc(50), 1);

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(usdcToken.balanceOf(recipient) - recipientBalanceBefore, _usdc(50));
        assertEq(usdcToken.balanceOf(address(spokePool)), 0);
        assertEq(usdcToken.allowance(address(hook), address(spokePool)), 0);
    }

    function test_executeRevertsWhenDestinationChainIdIsZero() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.destinationChainId = 0;

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHook.InvalidDestinationChainId.selector, 0)
        );
    }

    function test_executeRevertsWhenRecipientIsZeroBytes32() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.recipient = bytes32(0);

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHook.InvalidRecipient.selector, bytes32(0))
        );
    }

    function test_executeRevertsWhenOutputTokenIsZeroBytes32() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _defaultCommitment();
        commitment.outputToken = bytes32(0);

        _expectInvalidCommitmentRevert(
            commitment,
            abi.encodeWithSelector(AcrossBridgeHook.InvalidOutputToken.selector, bytes32(0))
        );
    }

    function test_executeSucceedsWhenOutputAmountEqualsMinimumExactly() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData,,,) = _buildExecutionFixture(commitmentMinOutputAmount());

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(usdcToken.balanceOf(address(spokePool)), _usdc(50));
    }

    function test_executeSupportsDifferentFillDeadlineOffsets() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData,,,) =
            _buildExecutionFixture(700_000, 1_800, _toBytes32(DEFAULT_RELAYER), 5);

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(spokePool.lastFillDeadlineOffset(), 1_800);
    }

    function test_executePassesExclusiveRelayerAndExclusivityParameters() public {
        bytes32 customRelayer = _toBytes32(makeAddr("customRelayer"));
        (IOrchestrator.Intent memory intent, bytes memory fulfillData,,,) =
            _buildExecutionFixture(700_000, 21_600, customRelayer, 10);

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

        assertEq(spokePool.lastExclusiveRelayer(), customRelayer);
        assertEq(spokePool.lastExclusivityParameter(), 10);
    }

    function test_executeSupportsOpenRelayWithZeroExclusivity() public {
        (IOrchestrator.Intent memory intent, bytes memory fulfillData,,,) =
            _buildExecutionFixture(700_000, 21_600, bytes32(0), 0);

        vm.prank(orchestrator);
        hook.execute(intent, _usdc(50), fulfillData);

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
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        hook.rescueERC20(address(0), recipient, _usdc(100));

        vm.prank(owner);
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
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
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        hook.rescueNative(payable(address(0)), ONE_ETHER);

        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(AcrossBridgeHook.NativeTransferFailed.selector, address(rejectEther), ONE_ETHER)
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
            IOrchestrator.Intent memory intent,
            bytes memory fulfillData,
            bytes32 intentHash,
            AcrossBridgeHook.AcrossFulfillData memory fulfillStruct,
            AcrossBridgeHook.BridgeCommitment memory commitment
        )
    {
        return _buildExecutionFixture(
            outputAmount,
            21_600,
            _toBytes32(DEFAULT_RELAYER),
            5
        );
    }

    function _buildExecutionFixture(
        uint256 outputAmount,
        uint32 fillDeadlineOffset,
        bytes32 exclusiveRelayer,
        uint32 exclusivityParameter
    )
        internal
        returns (
            IOrchestrator.Intent memory intent,
            bytes memory fulfillData,
            bytes32 intentHash,
            AcrossBridgeHook.AcrossFulfillData memory fulfillStruct,
            AcrossBridgeHook.BridgeCommitment memory commitment
        )
    {
        commitment = _defaultCommitment();
        intentHash = keccak256("intentHash");
        fulfillStruct = AcrossBridgeHook.AcrossFulfillData({
            intentHash: intentHash,
            outputAmount: outputAmount,
            fillDeadlineOffset: fillDeadlineOffset,
            exclusiveRelayer: exclusiveRelayer,
            exclusivityParameter: exclusivityParameter
        });

        fulfillData = abi.encode(fulfillStruct);
        intent = _buildIntent(abi.encode(commitment));

        vm.prank(orchestrator);
        usdcToken.approve(address(hook), _usdc(50));
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

    function _expectInvalidCommitmentRevert(
        AcrossBridgeHook.BridgeCommitment memory commitment,
        bytes memory revertData
    ) internal {
        IOrchestrator.Intent memory intent = _buildIntent(abi.encode(commitment));
        bytes memory fulfillData = abi.encode(
            AcrossBridgeHook.AcrossFulfillData({
                intentHash: keccak256("intentHash"),
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
        hook.execute(intent, _usdc(50), fulfillData);
    }

    function _defaultCommitment() internal view returns (AcrossBridgeHook.BridgeCommitment memory commitment) {
        commitment = AcrossBridgeHook.BridgeCommitment({
            destinationChainId: 10,
            outputToken: _toBytes32(recipient),
            recipient: _toBytes32(recipient),
            minOutputAmount: commitmentMinOutputAmount()
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

    function commitmentMinOutputAmount() internal pure returns (uint256) {
        return 500_000;
    }
}
