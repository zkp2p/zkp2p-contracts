// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {Test} from "forge-std/Test.sol";

import {IIntentRiskHook} from "contracts/interfaces/IIntentRiskHook.sol";
import {IOrchestratorV2} from "contracts/interfaces/IOrchestratorV2.sol";
import {IPostIntentHookV2} from "contracts/interfaces/IPostIntentHookV2.sol";
import {IReferralFee} from "contracts/interfaces/IReferralFee.sol";
import {BoundedCall} from "contracts/lib/BoundedCall.sol";
import {PostIntentHookExecutor} from "contracts/lib/PostIntentHookExecutor.sol";
import {RiskSettlementExecutor} from "contracts/lib/RiskSettlementExecutor.sol";
import {IntentRiskHookMock} from "contracts/mocks/IntentRiskHookMock.sol";
import {USDCMock} from "contracts/mocks/USDCMock.sol";

contract ExactPullPostIntentHook is IPostIntentHookV2 {
    uint256 internal pullAmount;
    uint256 internal transferAmount;

    function configure(uint256 _pullAmount, uint256 _transferAmount) external {
        pullAmount = _pullAmount;
        transferAmount = _transferAmount;
    }

    function execute(HookExecutionContext calldata _context, bytes calldata) external override {
        if (pullAmount != 0) {
            USDCMock(_context.token).transferFrom(msg.sender, address(this), pullAmount);
        }
        if (transferAmount != 0) {
            USDCMock(_context.token).transfer(msg.sender, transferAmount);
        }
    }
}

contract RiskCallbackLibrariesParityTest is Test {
    bytes32 internal constant INTENT_HASH = keccak256("risk-callback-library-intent");
    uint256 internal constant GROSS_AMOUNT = 100e6;
    address internal constant RECIPIENT = address(0xBEEF);

    IntentRiskHookMock internal hook;
    ExactPullPostIntentHook internal postIntentHook;
    USDCMock internal token;

    function setUp() public {
        hook = new IntentRiskHookMock();
        postIntentHook = new ExactPullPostIntentHook();
        token = new USDCMock(1_000e6, "USD Coin", "USDC");
    }

    function test_BoundedAdmissionHandlesAbsentValidAndFailingHooks() public {
        BoundedCall.executeRiskAdmission(IIntentRiskHook(address(0)), INTENT_HASH, 500_000, 64);

        vm.expectPartialRevert(BoundedCall.RiskHookAdmissionFailed.selector);
        BoundedCall.executeRiskAdmission(IIntentRiskHook(address(1)), INTENT_HASH, 500_000, 64);

        BoundedCall.executeRiskAdmission(hook, INTENT_HASH, 500_000, 64);
        assertEq(hook.createdCalls(), 1);
        assertEq(hook.lastIntentHash(), INTENT_HASH);

        hook.setRevertOnCreate(true);
        vm.expectPartialRevert(BoundedCall.RiskHookAdmissionFailed.selector);
        BoundedCall.executeRiskAdmission(hook, INTENT_HASH, 500_000, 64);
    }

    function test_BoundedCancellationIsFailOpenAndRejectsUnforwardableGas() public {
        assertTrue(BoundedCall.executeRiskCancellation(IIntentRiskHook(address(0)), INTENT_HASH, 500_000, 64));
        assertFalse(BoundedCall.executeRiskCancellation(IIntentRiskHook(address(1)), INTENT_HASH, 500_000, 64));

        assertTrue(BoundedCall.executeRiskCancellation(hook, INTENT_HASH, 500_000, 64));
        assertEq(hook.cancelledCalls(), 1);

        hook.setCallbackRevertDataSize(1_024);
        assertFalse(BoundedCall.executeRiskCancellation(hook, INTENT_HASH, 500_000, 64));

        hook.setCallbackRevertDataSize(0);
        vm.expectPartialRevert(BoundedCall.InsufficientGasForRiskCallback.selector);
        BoundedCall.executeRiskCancellation(hook, INTENT_HASH, type(uint256).max, 64);
    }

    function test_BoundedSettlementPropagatesSuccessAndBoundedFailure() public {
        IIntentRiskHook.RiskSettlementContext memory context = _context();
        BoundedCall.executeRiskSettlement(hook, context, 500_000, 64);
        assertEq(hook.settlementCalls(), 1);

        hook.setCallbackRevertDataSize(1_024);
        vm.expectPartialRevert(BoundedCall.RiskHookSettlementFailed.selector);
        BoundedCall.executeRiskSettlement(hook, context, 500_000, 64);
    }

    function test_RiskSettlementExecutorHandlesAbsentAndInvalidHooks() public {
        assertFalse(RiskSettlementExecutor.execute(IIntentRiskHook(address(0)), token, _context(), 500_000, 64));

        vm.expectRevert(abi.encodeWithSelector(RiskSettlementExecutor.InvalidRiskHook.selector, address(1)));
        RiskSettlementExecutor.execute(IIntentRiskHook(address(1)), token, _context(), 500_000, 64);
    }

    function test_RiskSettlementExecutorAcceptsOnlyZeroOrExactConsumption() public {
        assertFalse(RiskSettlementExecutor.execute(hook, token, _context(), 500_000, 64));
        assertEq(token.allowance(address(this), address(hook)), 0);

        hook.setSettlementPullAmount(GROSS_AMOUNT);
        assertTrue(RiskSettlementExecutor.execute(hook, token, _context(), 500_000, 64));
        assertEq(token.balanceOf(address(hook)), GROSS_AMOUNT);
        assertEq(token.allowance(address(this), address(hook)), 0);

        hook.setSettlementPullAmount(1);
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskSettlementExecutor.InvalidRiskHookSettlementConsumption.selector, INTENT_HASH, 1, GROSS_AMOUNT
            )
        );
        RiskSettlementExecutor.execute(hook, token, _context(), 500_000, 64);
    }

    function test_RiskSettlementExecutorRejectsBalanceIncrease() public {
        token.transfer(address(hook), 1);
        hook.setSettlementTransferAmount(1);
        uint256 balanceBefore = token.balanceOf(address(this));
        vm.expectRevert(
            abi.encodeWithSelector(
                RiskSettlementExecutor.RiskHookSettlementBalanceIncreased.selector,
                INTENT_HASH,
                balanceBefore,
                balanceBefore + 1
            )
        );
        RiskSettlementExecutor.execute(hook, token, _context(), 500_000, 64);
    }

    function test_PostIntentExecutorTransfersDirectlyAndThroughExactPullHook() public {
        address recipient = makeAddr("post-hook-recipient");
        IOrchestratorV2.Intent memory intent = _intent(recipient, IPostIntentHookV2(address(0)));
        assertEq(PostIntentHookExecutor.transferOrExecute(token, INTENT_HASH, intent, 10e6, ""), recipient);
        assertEq(token.balanceOf(recipient), 10e6);

        intent.postIntentHook = postIntentHook;
        postIntentHook.configure(10e6, 0);
        assertEq(
            PostIntentHookExecutor.transferOrExecute(token, INTENT_HASH, intent, 10e6, hex"1234"),
            address(postIntentHook)
        );
        assertEq(token.balanceOf(address(postIntentHook)), 10e6);
        assertEq(token.allowance(address(this), address(postIntentHook)), 0);

        PostIntentHookExecutor.transferTo(token, recipient, 1e6);
        assertEq(token.balanceOf(recipient), 11e6);
    }

    function test_PostIntentExecutorRejectsPartialPullAndBalanceIncrease() public {
        IOrchestratorV2.Intent memory intent = _intent(RECIPIENT, postIntentHook);
        postIntentHook.configure(1, 0);
        vm.expectRevert(bytes("PostIntentHook: must pull exact netAmount"));
        PostIntentHookExecutor.transferOrExecute(token, INTENT_HASH, intent, 10e6, "");

        token.transfer(address(postIntentHook), 1);
        postIntentHook.configure(0, 1);
        vm.expectRevert(bytes("PostIntentHook: unexpected balance increase"));
        PostIntentHookExecutor.transferOrExecute(token, INTENT_HASH, intent, 10e6, "");
    }

    function _context() internal view returns (IIntentRiskHook.RiskSettlementContext memory) {
        return IIntentRiskHook.RiskSettlementContext({
            intentHash: INTENT_HASH,
            token: address(token),
            recipient: RECIPIENT,
            grossAmount: GROSS_AMOUNT,
            executableAmount: 98e6,
            isManualRelease: false,
            feeAllocations: new IIntentRiskHook.FeeAllocation[](0)
        });
    }

    function _intent(address recipient, IPostIntentHookV2 intentHook)
        internal
        view
        returns (IOrchestratorV2.Intent memory)
    {
        return IOrchestratorV2.Intent({
            owner: address(this),
            to: recipient,
            escrow: address(0xCAFE),
            depositId: 1,
            amount: GROSS_AMOUNT,
            timestamp: block.timestamp,
            paymentMethod: keccak256("method"),
            fiatCurrency: keccak256("USD"),
            conversionRate: 1e18,
            payeeId: keccak256("payee"),
            referralFees: new IReferralFee.ReferralFee[](0),
            postIntentHook: intentHook,
            data: hex"abcd"
        });
    }
}
