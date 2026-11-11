// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import {DisputeProtectionStackV2Fixture} from "./DisputeProtectionStackV2Fixture.sol";
import {BondedArbitrator} from "contracts/BondedArbitrator.sol";
import {IntentSignalPolicyV2} from "contracts/hooks/IntentSignalPolicyV2.sol";
import {IBondedArbitrator} from "contracts/interfaces/IBondedArbitrator.sol";
import {INonPaymentVerifier} from "contracts/interfaces/INonPaymentVerifier.sol";
import {NonPaymentVerifier} from "contracts/unifiedVerifier/NonPaymentVerifier.sol";

abstract contract BondedArbitratorFixture is DisputeProtectionStackV2Fixture {
    uint64 internal constant WINDOW = 14 days;
    uint256 internal constant BOND = 1_000e6;

    BondedArbitrator internal arbitrator;
    NonPaymentVerifier internal scans;
    address internal treasury;
    address internal operator;

    function setUp() public virtual override {
        super.setUp();
        treasury = makeAddr("treasury");
        operator = makeAddr("operator");
        scans = new NonPaymentVerifier(address(this), witnesses);
        arbitrator = new BondedArbitrator(address(this), orchestrator, vault, nullifiers, scans);
        vault.setController(address(arbitrator), true);
        nullifiers.addWritePermission(address(arbitrator));
        orchestrator.setSignalPolicy(new IntentSignalPolicyV2(gatingService, whitelist, address(arbitrator)));
        arbitrator.setDisputeWindow(METHOD, WINDOW);
        arbitrator.setBondOwner(treasury, true);
        _stake(vault, treasury, BOND);
        vm.prank(treasury);
        arbitrator.setOperator(operator, 500e6);
    }

    function _release() internal returns (bytes32 id) {
        id = _signal(taker, _defaultParams());
        IBondedArbitrator.PaymentClaim memory claim = _claim(_paymentId(id));
        vm.prank(operator);
        arbitrator.release(id, INTENT_AMOUNT, claim);
    }

    function _claim(bytes32 _txIdHash) internal view returns (IBondedArbitrator.PaymentClaim memory) {
        return IBondedArbitrator.PaymentClaim({
            paidAfter: uint64(block.timestamp - 1 hours),
            amount: INTENT_AMOUNT * CONVERSION_RATE / 1e18,
            payerHash: keccak256("@buyer"),
            txIdHash: _txIdHash,
            evidenceHash: keccak256("screenshot")
        });
    }

    function _scan(bytes32 _id, bytes32 _payeeId, uint64 _windowEnd)
        internal
        view
        returns (INonPaymentVerifier.NonPaymentAttestation memory)
    {
        return _scanFull(_id, _payeeId, _windowEnd, 0, new bytes32[](0));
    }

    function _scanExcluding(bytes32 _id, bytes32 _payeeId, uint64 _windowEnd, bytes32[] memory _excluded)
        internal
        view
        returns (INonPaymentVerifier.NonPaymentAttestation memory)
    {
        return _scanFull(_id, _payeeId, _windowEnd, 0, _excluded);
    }

    function _scanFull(bytes32 _id, bytes32 _payeeId, uint64 _windowEnd, uint256 _received, bytes32[] memory _excluded)
        internal
        view
        returns (INonPaymentVerifier.NonPaymentAttestation memory attestation)
    {
        IBondedArbitrator.Release memory released = arbitrator.getRelease(_id);
        bytes memory data = abi.encode(
            INonPaymentVerifier.NonPaymentDetails({
                paymentMethod: released.paymentMethod,
                payeeId: _payeeId,
                fiatCurrency: released.fiatCurrency,
                windowStart: released.claim.paidAfter,
                windowEnd: _windowEnd,
                claimedAmount: released.claim.amount,
                receivedAmount: _received,
                payerHash: released.claim.payerHash,
                txIdHash: released.claim.txIdHash,
                historyHash: keccak256("rows"),
                excludedPaymentIds: _excluded
            })
        );
        attestation.intentHash = _id;
        attestation.dataHash = keccak256(data);
        attestation.data = data;
        attestation.signatures = new bytes[](1);
        attestation.signatures[0] = _sign(WITNESS_KEY, scans.hashNonPaymentAttestation(attestation));
    }

    function _sign(uint256 _key, bytes32 _digest) internal pure returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(_key, _digest);
        return abi.encodePacked(r, s, v);
    }
}
