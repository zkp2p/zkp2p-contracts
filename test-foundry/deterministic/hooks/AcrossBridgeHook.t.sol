// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {AcrossBridgeHook} from "contracts/hooks/AcrossBridgeHook.sol";
import {AcrossBridgeHookV2} from "contracts/hooks/AcrossBridgeHookV2.sol";
import {AcrossSpokePoolMock} from "contracts/mocks/AcrossSpokePoolMock.sol";
import {RejectEtherMock} from "contracts/mocks/RejectEtherMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";
import {OrchestratorRegistry} from "contracts/registries/OrchestratorRegistry.sol";
import {IOrchestrator} from "contracts/interfaces/IOrchestrator.sol";
import {IPostIntentHook} from "contracts/interfaces/IPostIntentHook.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";

interface IAcrossBridgeRescue {
    function owner() external view returns (address);
    function rescueERC20(address token, address to, uint256 amount) external;
    function rescueNative(address payable to, uint256 amount) external;
}

abstract contract AcrossBridgeHookShared is Test {
    event RescueERC20(address indexed token, address indexed to, uint256 amount);
    event RescueNative(address indexed to, uint256 amount);

    uint256 internal constant BRIDGE_AMOUNT = 50e6;
    address internal orchestrator;
    address internal recipient;
    address internal attacker;
    USDCMock internal token;
    AcrossSpokePoolMock internal spokePool;
    IAcrossBridgeRescue internal rescueHook;

    function setUp() public virtual {
        orchestrator = makeAddr("orchestrator");
        recipient = makeAddr("recipient");
        attacker = makeAddr("attacker");
        token = new USDCMock(1_000_000e6, "USDC", "USDC");
        spokePool = new AcrossSpokePoolMock();
        _deployHook();
        token.transfer(orchestrator, 1_000e6);
        vm.prank(orchestrator);
        token.approve(address(rescueHook), BRIDGE_AMOUNT);
    }

    function _deployHook() internal virtual;

    function _fundHookWithNative(uint256 amount) internal {
        vm.deal(address(this), amount);
        (bool success,) = payable(address(rescueHook)).call{value: amount}("");
        assertTrue(success);
    }

    function test_OwnerIsDeployer() public view {
        assertEq(rescueHook.owner(), address(this));
    }

    function test_RescueERC20TransfersTokensAndEmits() public {
        USDCMock stuckToken = new USDCMock(1_000e6, "STUCK", "STUCK");
        stuckToken.transfer(address(rescueHook), 100e6);
        vm.expectEmit(true, true, false, true, address(rescueHook));
        emit RescueERC20(address(stuckToken), recipient, 100e6);
        rescueHook.rescueERC20(address(stuckToken), recipient, 100e6);
        assertEq(stuckToken.balanceOf(recipient), 100e6);
        assertEq(stuckToken.balanceOf(address(rescueHook)), 0);
    }

    function test_RescueERC20RejectsNonOwner() public {
        USDCMock stuckToken = new USDCMock(1_000e6, "STUCK", "STUCK");
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(attacker);
        rescueHook.rescueERC20(address(stuckToken), recipient, 100e6);
    }

    function test_RescueERC20RejectsZeroToken() public {
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        rescueHook.rescueERC20(address(0), recipient, 100e6);
    }

    function test_RescueERC20RejectsZeroRecipient() public {
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        rescueHook.rescueERC20(address(token), address(0), 100e6);
    }

    function test_RescueNativeTransfersAndEmits() public {
        _fundHookWithNative(1 ether);
        vm.expectEmit(true, false, false, true, address(rescueHook));
        emit RescueNative(recipient, 1 ether);
        rescueHook.rescueNative(payable(recipient), 1 ether);
        assertEq(recipient.balance, 1 ether);
        assertEq(address(rescueHook).balance, 0);
    }

    function test_RescueNativeRejectsNonOwner() public {
        _fundHookWithNative(1 ether);
        vm.expectRevert(bytes("Ownable: caller is not the owner"));
        vm.prank(attacker);
        rescueHook.rescueNative(payable(recipient), 1 ether);
    }

    function test_RescueNativeRejectsZeroRecipient() public {
        _fundHookWithNative(1 ether);
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        rescueHook.rescueNative(payable(address(0)), 1 ether);
    }

    function test_RescueNativeAllowsPartialAmount() public {
        _fundHookWithNative(1 ether);
        vm.expectEmit(true, false, false, true, address(rescueHook));
        emit RescueNative(recipient, 0.5 ether);
        rescueHook.rescueNative(payable(recipient), 0.5 ether);
        assertEq(recipient.balance, 0.5 ether);
        assertEq(address(rescueHook).balance, 0.5 ether);
    }

    function test_RescueNativeRejectsFailedTransfer() public {
        _fundHookWithNative(1 ether);
        RejectEtherMock rejectEther = new RejectEtherMock();
        vm.expectRevert(
            abi.encodeWithSelector(AcrossBridgeHook.NativeTransferFailed.selector, address(rejectEther), 1 ether)
        );
        rescueHook.rescueNative(payable(address(rejectEther)), 1 ether);
    }

    function test_ReceiveAcceptsNativeTokens() public {
        _fundHookWithNative(1 ether);
        assertEq(address(rescueHook).balance, 1 ether);
    }

    function _toBytes32(address value) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(value)));
    }
}

contract AcrossBridgeHookLegacyTest is AcrossBridgeHookShared {
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
    event FallbackTransfer(
        bytes32 indexed intentHash, address indexed recipient, uint256 amount, AcrossBridgeHook.FallbackReason reason
    );

    AcrossBridgeHook internal hook;

    function _deployHook() internal override {
        hook = new AcrossBridgeHook(address(token), orchestrator, address(spokePool));
        rescueHook = IAcrossBridgeRescue(address(hook));
    }

    function _commitment() internal view returns (AcrossBridgeHook.BridgeCommitment memory) {
        return AcrossBridgeHook.BridgeCommitment({
            destinationChainId: 10,
            outputToken: _toBytes32(recipient),
            recipient: _toBytes32(recipient),
            minOutputAmount: 500_000
        });
    }

    function _intent(AcrossBridgeHook.BridgeCommitment memory commitment)
        internal
        view
        returns (IOrchestrator.Intent memory)
    {
        return IOrchestrator.Intent({
            owner: address(this),
            to: recipient,
            escrow: address(this),
            depositId: 1,
            amount: 100e6,
            timestamp: block.timestamp,
            paymentMethod: keccak256("venmo"),
            fiatCurrency: keccak256("USD"),
            conversionRate: 1e18,
            payeeId: keccak256("payee"),
            referrer: address(0),
            referrerFee: 0,
            postIntentHook: IPostIntentHook(address(hook)),
            data: abi.encode(commitment)
        });
    }

    function _fulfill(bytes32 intentHash, uint256 outputAmount, uint32 deadline, bytes32 relayer, uint32 exclusivity)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            AcrossBridgeHook.AcrossFulfillData({
                intentHash: intentHash,
                outputAmount: outputAmount,
                fillDeadlineOffset: deadline,
                exclusiveRelayer: relayer,
                exclusivityParameter: exclusivity
            })
        );
    }

    function _execute(AcrossBridgeHook.BridgeCommitment memory commitment, bytes memory fulfillData) internal {
        vm.prank(orchestrator);
        hook.execute(_intent(commitment), BRIDGE_AMOUNT, fulfillData);
    }

    function _validFulfill(bytes32 intentHash, uint256 outputAmount) internal returns (bytes memory) {
        return _fulfill(intentHash, outputAmount, 21_600, _toBytes32(makeAddr("relayer")), 5);
    }

    function test_ConstructorStoresInitialVariables() public view {
        assertEq(address(hook.inputToken()), address(token));
        assertEq(hook.orchestrator(), orchestrator);
        assertEq(address(hook.spokePool()), address(spokePool));
    }

    function test_ConstructorRejectsZeroInputToken() public {
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(0), orchestrator, address(spokePool));
    }

    function test_ConstructorRejectsZeroOrchestrator() public {
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(token), address(0), address(spokePool));
    }

    function test_ConstructorRejectsZeroSpokePool() public {
        vm.expectRevert(AcrossBridgeHook.ZeroAddress.selector);
        new AcrossBridgeHook(address(token), orchestrator, address(0));
    }

    function test_ExecuteBridgesAndForwardsEveryAcrossParameter() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        bytes32 intentHash = keccak256("intent");
        bytes32 relayer = _toBytes32(makeAddr("exclusiveRelayer"));
        uint32 deadline = 21_600;
        uint32 exclusivity = 5;
        uint256 orchestratorBefore = token.balanceOf(orchestrator);
        vm.expectEmit(true, false, false, true, address(hook));
        emit AcrossBridgeInitiated(
            intentHash,
            10,
            commitment.outputToken,
            commitment.recipient,
            BRIDGE_AMOUNT,
            700_000,
            deadline,
            relayer,
            exclusivity
        );
        _execute(commitment, _fulfill(intentHash, 700_000, deadline, relayer, exclusivity));
        assertEq(orchestratorBefore - token.balanceOf(orchestrator), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(token.balanceOf(address(spokePool)), BRIDGE_AMOUNT);
        assertEq(spokePool.lastDepositor(), _toBytes32(address(hook)));
        assertEq(spokePool.lastRecipient(), commitment.recipient);
        assertEq(spokePool.lastInputToken(), _toBytes32(address(token)));
        assertEq(spokePool.lastOutputToken(), commitment.outputToken);
        assertEq(spokePool.lastInputAmount(), BRIDGE_AMOUNT);
        assertEq(spokePool.lastOutputAmount(), 700_000);
        assertEq(spokePool.lastDestinationChainId(), 10);
        assertEq(spokePool.lastFillDeadlineOffset(), deadline);
        assertEq(spokePool.lastExclusiveRelayer(), relayer);
        assertEq(spokePool.lastExclusivityParameter(), exclusivity);
    }

    function test_ExecuteRejectsNonOrchestrator() public {
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHook.UnauthorizedCaller.selector, attacker));
        vm.prank(attacker);
        hook.execute(_intent(_commitment()), BRIDGE_AMOUNT, _validFulfill(keccak256("intent"), 700_000));
    }

    function test_OutputBelowMinimumFallsBackToIntentRecipient() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        bytes32 intentHash = keccak256("below-minimum");
        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(
            intentHash, recipient, BRIDGE_AMOUNT, AcrossBridgeHook.FallbackReason.OUTPUT_BELOW_MINIMUM
        );
        _execute(commitment, _validFulfill(intentHash, commitment.minOutputAmount - 1));
        assertEq(token.balanceOf(recipient), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(spokePool)), 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }

    function test_BridgeRevertFallsBackToIntentRecipient() public {
        spokePool.setShouldRevert(true);
        bytes32 intentHash = keccak256("bridge-failed");
        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(intentHash, recipient, BRIDGE_AMOUNT, AcrossBridgeHook.FallbackReason.BRIDGE_CALL_FAILED);
        _execute(_commitment(), _validFulfill(intentHash, 700_000));
        assertEq(token.balanceOf(recipient), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(spokePool)), 0);
        assertEq(token.allowance(address(hook), address(spokePool)), 0);
    }

    function test_ExecuteRejectsZeroDestinationChainId() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        commitment.destinationChainId = 0;
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHook.InvalidDestinationChainId.selector, 0));
        _execute(commitment, _validFulfill(keccak256("intent"), 700_000));
    }

    function test_ExecuteRejectsZeroRecipient() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        commitment.recipient = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHook.InvalidRecipient.selector, bytes32(0)));
        _execute(commitment, _validFulfill(keccak256("intent"), 700_000));
    }

    function test_ExecuteRejectsZeroOutputToken() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        commitment.outputToken = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHook.InvalidOutputToken.selector, bytes32(0)));
        _execute(commitment, _validFulfill(keccak256("intent"), 700_000));
    }

    function test_OutputEqualToMinimumBridges() public {
        AcrossBridgeHook.BridgeCommitment memory commitment = _commitment();
        _execute(commitment, _validFulfill(keccak256("intent"), commitment.minOutputAmount));
        assertEq(token.balanceOf(address(spokePool)), BRIDGE_AMOUNT);
    }

    function test_CustomFillDeadlineOffsetReachesSpokePool() public {
        _execute(_commitment(), _fulfill(keccak256("intent"), 700_000, 1_800, bytes32(0), 0));
        assertEq(spokePool.lastFillDeadlineOffset(), 1_800);
    }

    function test_CustomExclusiveRelayerAndParameterReachSpokePool() public {
        bytes32 relayer = _toBytes32(makeAddr("customRelayer"));
        _execute(_commitment(), _fulfill(keccak256("intent"), 700_000, 21_600, relayer, 10));
        assertEq(spokePool.lastExclusiveRelayer(), relayer);
        assertEq(spokePool.lastExclusivityParameter(), 10);
    }

    function test_ZeroExclusivityCreatesOpenRelayDeposit() public {
        _execute(_commitment(), _fulfill(keccak256("intent"), 700_000, 21_600, bytes32(0), 0));
        assertEq(spokePool.lastExclusiveRelayer(), bytes32(0));
        assertEq(spokePool.lastExclusivityParameter(), 0);
    }

    function test_HookAddressIsBytes32Depositor() public {
        _execute(_commitment(), _validFulfill(keccak256("intent"), 700_000));
        assertEq(spokePool.lastDepositor(), _toBytes32(address(hook)));
    }
}

contract AcrossBridgeHookV2Test is AcrossBridgeHookShared {
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
    event FallbackTransfer(
        bytes32 indexed intentHash, address indexed recipient, uint256 amount, AcrossBridgeHookV2.FallbackReason reason
    );

    AcrossBridgeHookV2 internal hook;
    OrchestratorRegistry internal orchestratorRegistry;

    function _deployHook() internal override {
        orchestratorRegistry = new OrchestratorRegistry();
        orchestratorRegistry.addOrchestrator(orchestrator);
        hook = new AcrossBridgeHookV2(address(token), address(orchestratorRegistry), address(spokePool));
        rescueHook = IAcrossBridgeRescue(address(hook));
    }

    function _commitment() internal view returns (AcrossBridgeHookV2.BridgeCommitment memory) {
        return AcrossBridgeHookV2.BridgeCommitment({
            destinationChainId: 10,
            outputToken: _toBytes32(recipient),
            recipient: _toBytes32(recipient),
            minOutputAmount: 500_000
        });
    }

    function _context(AcrossBridgeHookV2.BridgeCommitment memory commitment, bytes32 intentHash)
        internal
        view
        returns (IPostIntentHookV2.HookExecutionContext memory)
    {
        return IPostIntentHookV2.HookExecutionContext({
            intentHash: intentHash,
            token: address(token),
            executableAmount: BRIDGE_AMOUNT,
            intent: IPostIntentHookV2.HookIntentContext({
                owner: address(this),
                to: recipient,
                escrow: address(this),
                depositId: 1,
                amount: 100e6,
                timestamp: block.timestamp,
                paymentMethod: keccak256("venmo"),
                fiatCurrency: keccak256("USD"),
                conversionRate: 1e18,
                payeeId: keccak256("payee"),
                signalHookData: abi.encode(commitment)
            })
        });
    }

    function _fulfill(uint256 outputAmount, uint32 deadline, bytes32 relayer, uint32 exclusivity)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encode(
            AcrossBridgeHookV2.AcrossFulfillData({
                outputAmount: outputAmount,
                fillDeadlineOffset: deadline,
                exclusiveRelayer: relayer,
                exclusivityParameter: exclusivity
            })
        );
    }

    function _execute(AcrossBridgeHookV2.BridgeCommitment memory commitment, bytes32 intentHash, bytes memory data)
        internal
    {
        vm.prank(orchestrator);
        hook.execute(_context(commitment, intentHash), data);
    }

    function _validFulfill(uint256 outputAmount) internal returns (bytes memory) {
        return _fulfill(outputAmount, 21_600, _toBytes32(makeAddr("relayer")), 5);
    }

    function test_ConstructorStoresInitialVariables() public view {
        assertEq(address(hook.inputToken()), address(token));
        assertEq(address(hook.orchestratorRegistry()), address(orchestratorRegistry));
        assertEq(address(hook.spokePool()), address(spokePool));
    }

    function test_ConstructorRejectsZeroInputToken() public {
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(0), address(orchestratorRegistry), address(spokePool));
    }

    function test_ConstructorRejectsZeroOrchestratorRegistry() public {
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(token), address(0), address(spokePool));
    }

    function test_ConstructorRejectsZeroSpokePool() public {
        vm.expectRevert(AcrossBridgeHookV2.ZeroAddress.selector);
        new AcrossBridgeHookV2(address(token), address(orchestratorRegistry), address(0));
    }

    function test_ExecuteBridgesAndForwardsEveryAcrossParameter() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        bytes32 intentHash = keccak256("intent");
        bytes32 relayer = _toBytes32(makeAddr("exclusiveRelayer"));
        uint32 deadline = 21_600;
        uint32 exclusivity = 5;
        uint256 orchestratorBefore = token.balanceOf(orchestrator);
        vm.expectEmit(true, false, false, true, address(hook));
        emit AcrossBridgeInitiated(
            intentHash,
            10,
            commitment.outputToken,
            commitment.recipient,
            BRIDGE_AMOUNT,
            700_000,
            deadline,
            relayer,
            exclusivity
        );
        _execute(commitment, intentHash, _fulfill(700_000, deadline, relayer, exclusivity));
        assertEq(orchestratorBefore - token.balanceOf(orchestrator), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(hook)), 0);
        assertEq(token.balanceOf(address(spokePool)), BRIDGE_AMOUNT);
        assertEq(spokePool.lastDepositor(), _toBytes32(address(hook)));
        assertEq(spokePool.lastRecipient(), commitment.recipient);
        assertEq(spokePool.lastInputToken(), _toBytes32(address(token)));
        assertEq(spokePool.lastOutputToken(), commitment.outputToken);
        assertEq(spokePool.lastInputAmount(), BRIDGE_AMOUNT);
        assertEq(spokePool.lastOutputAmount(), 700_000);
        assertEq(spokePool.lastDestinationChainId(), 10);
        assertEq(spokePool.lastFillDeadlineOffset(), deadline);
        assertEq(spokePool.lastExclusiveRelayer(), relayer);
        assertEq(spokePool.lastExclusivityParameter(), exclusivity);
    }

    function test_ExecuteRejectsNonRegisteredOrchestrator() public {
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.UnauthorizedOrchestratorCaller.selector, attacker));
        vm.prank(attacker);
        hook.execute(_context(_commitment(), keccak256("intent")), _validFulfill(700_000));
    }

    function test_ExecuteRejectsWrongFulfillDataLength() public {
        bytes memory wrongLength = abi.encode(uint256(700_000), uint32(21_600), _toBytes32(recipient));
        vm.expectRevert(
            abi.encodeWithSelector(AcrossBridgeHookV2.InvalidFulfillHookDataLength.selector, wrongLength.length)
        );
        vm.prank(orchestrator);
        hook.execute(_context(_commitment(), keccak256("intent")), wrongLength);
    }

    function test_ExecuteRejectsEmptyFulfillData() public {
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidFulfillHookDataLength.selector, 0));
        vm.prank(orchestrator);
        hook.execute(_context(_commitment(), keccak256("intent")), "");
    }

    function test_ExecuteRejectsZeroDestinationChainId() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        commitment.destinationChainId = 0;
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidDestinationChainId.selector, 0));
        _execute(commitment, keccak256("intent"), _validFulfill(700_000));
    }

    function test_ExecuteRejectsZeroRecipient() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        commitment.recipient = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidRecipient.selector, bytes32(0)));
        _execute(commitment, keccak256("intent"), _validFulfill(700_000));
    }

    function test_ExecuteRejectsZeroOutputToken() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        commitment.outputToken = bytes32(0);
        vm.expectRevert(abi.encodeWithSelector(AcrossBridgeHookV2.InvalidOutputToken.selector, bytes32(0)));
        _execute(commitment, keccak256("intent"), _validFulfill(700_000));
    }

    function test_OutputBelowMinimumFallsBackToIntentRecipient() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        bytes32 intentHash = keccak256("below-minimum");
        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(
            intentHash, recipient, BRIDGE_AMOUNT, AcrossBridgeHookV2.FallbackReason.OUTPUT_BELOW_MINIMUM
        );
        _execute(commitment, intentHash, _validFulfill(commitment.minOutputAmount - 1));
        assertEq(token.balanceOf(recipient), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(spokePool)), 0);
        assertEq(token.balanceOf(address(hook)), 0);
    }

    function test_BridgeRevertFallsBackToIntentRecipient() public {
        spokePool.setShouldRevert(true);
        bytes32 intentHash = keccak256("bridge-failed");
        vm.expectEmit(true, true, false, true, address(hook));
        emit FallbackTransfer(
            intentHash, recipient, BRIDGE_AMOUNT, AcrossBridgeHookV2.FallbackReason.BRIDGE_CALL_FAILED
        );
        _execute(_commitment(), intentHash, _validFulfill(700_000));
        assertEq(token.balanceOf(recipient), BRIDGE_AMOUNT);
        assertEq(token.balanceOf(address(spokePool)), 0);
        assertEq(token.allowance(address(hook), address(spokePool)), 0);
    }

    function test_OutputEqualToMinimumBridges() public {
        AcrossBridgeHookV2.BridgeCommitment memory commitment = _commitment();
        _execute(commitment, keccak256("intent"), _validFulfill(commitment.minOutputAmount));
        assertEq(token.balanceOf(address(spokePool)), BRIDGE_AMOUNT);
    }

    function test_CustomFillDeadlineOffsetReachesSpokePool() public {
        _execute(_commitment(), keccak256("intent"), _fulfill(700_000, 1_800, bytes32(0), 0));
        assertEq(spokePool.lastFillDeadlineOffset(), 1_800);
    }

    function test_CustomExclusiveRelayerAndParameterReachSpokePool() public {
        bytes32 relayer = _toBytes32(makeAddr("customRelayer"));
        _execute(_commitment(), keccak256("intent"), _fulfill(700_000, 21_600, relayer, 10));
        assertEq(spokePool.lastExclusiveRelayer(), relayer);
        assertEq(spokePool.lastExclusivityParameter(), 10);
    }

    function test_ZeroExclusivityCreatesOpenRelayDeposit() public {
        _execute(_commitment(), keccak256("intent"), _fulfill(700_000, 21_600, bytes32(0), 0));
        assertEq(spokePool.lastExclusiveRelayer(), bytes32(0));
        assertEq(spokePool.lastExclusivityParameter(), 0);
    }

    function test_HookAddressIsBytes32Depositor() public {
        _execute(_commitment(), keccak256("intent"), _validFulfill(700_000));
        assertEq(spokePool.lastDepositor(), _toBytes32(address(hook)));
    }
}
