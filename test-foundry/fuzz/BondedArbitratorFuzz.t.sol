// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {BondedArbitratorFixture} from "../deterministic/helpers/BondedArbitratorFixture.sol";
import {IBondedArbitrator} from "contracts/interfaces/IBondedArbitrator.sol";
import {INonPaymentVerifier} from "contracts/interfaces/INonPaymentVerifier.sol";

contract BondedArbitratorFuzz is BondedArbitratorFixture {
    /// @dev A dispute pays exactly the unpaid share of the bond, and the rest returns to the bond owner's free stake;
    /// a shortfall that rounds to nothing cannot be disputed.
    function testFuzz_DisputePaysTheUnpaidShare(uint256 _releaseAmount, uint256 _claimedExtra, uint256 _received)
        public
    {
        uint256 releaseAmount = bound(_releaseAmount, 1, INTENT_AMOUNT);
        uint256 claimed = releaseAmount + bound(_claimedExtra, 0, 1_000e6);
        uint256 received = bound(_received, 0, claimed - 1);
        bytes32 id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));
        claim.amount = claimed;
        vm.prank(operator);
        arbitrator.release(id, releaseAmount, claim);

        INonPaymentVerifier.NonPaymentAttestation memory scan =
            _scanFull(id, PAYEE, uint64(block.timestamp), received, new bytes32[](0));
        uint256 owed = releaseAmount * (claimed - received) / claimed;
        if (owed == 0) {
            vm.expectRevert(abi.encodeWithSelector(IBondedArbitrator.PaymentCovered.selector, received, claimed));
            arbitrator.disputeNonPayment(scan);
            return;
        }
        arbitrator.disputeNonPayment(scan);

        assertEq(vault.claimable(depositor), owed);
        assertEq(vault.stakeBalance(treasury), BOND - owed);
        assertEq(vault.freeStake(treasury), BOND - owed);
        assertEq(arbitrator.operatorLocked(operator), 0);
        assertLe(owed, releaseAmount);
    }
}
