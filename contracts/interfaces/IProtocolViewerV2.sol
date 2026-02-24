// SPDX-License-Identifier: MIT

pragma solidity ^0.8.18;

import { IEscrow } from "./IEscrow.sol";
import { IOrchestratorV2 } from "./IOrchestratorV2.sol";

interface IProtocolViewerV2 {

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
        IOrchestratorV2.Intent intent;
        DepositView deposit;
    }

    /* ============ Functions ============ */

    function getDeposit(address _escrow, uint256 _depositId) external view returns (DepositView memory depositView);

    function getDepositFromIds(
        address _escrow,
        uint256[] calldata _depositIds
    ) external view returns (DepositView[] memory depositArray);

    function getAccountDeposits(
        address _escrow,
        address _account
    ) external view returns (DepositView[] memory depositArray);

    function getIntent(address _orchestrator, bytes32 _intentHash) external view returns (IntentView memory intentView);

    function getIntents(
        address _orchestrator,
        bytes32[] calldata _intentHashes
    ) external view returns (IntentView[] memory intentArray);

    function getAccountIntents(
        address _orchestrator,
        address _account
    ) external view returns (IntentView[] memory intentViews);
}
