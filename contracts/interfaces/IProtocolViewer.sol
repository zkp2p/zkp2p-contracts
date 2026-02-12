// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "./IEscrow.sol";
import { IOrchestrator } from "./IOrchestrator.sol";

interface IProtocolViewer {

    /* ============ Structs ============ */

    struct PaymentMethodDataView {
        bytes32 paymentMethod;
        IEscrow.DepositPaymentMethodData verificationData;
        IEscrow.Currency[] currencies;
    }

    struct DepositView {
        uint256 depositId;
        IEscrow.Deposit deposit;
        uint256 availableLiquidity;                 // Amount of liquidity available to signal intents (net of expired intents)
        PaymentMethodDataView[] paymentMethods;
        bytes32[] intentHashes;
    }

    struct IntentView {
        bytes32 intentHash;
        IOrchestrator.Intent intent;
        DepositView deposit;
    }

    /* ============ Functions ============ */

    function getDepositFromIds(
        uint256[] memory _depositIds
    ) external view returns (DepositView[] memory);

    function getAccountIntents(
        address _account
    ) external view returns (IntentView[] memory intentViews);

    function setEscrowContract(address _escrow) external;

    function setOrchestrator(address _orchestrator) external;
}
