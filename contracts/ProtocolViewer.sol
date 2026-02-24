// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IProtocolViewer } from "./interfaces/IProtocolViewer.sol";
import { IOrchestrator } from "./interfaces/IOrchestrator.sol";

contract ProtocolViewer is IProtocolViewer {

    /* ============ State Variables ============ */
    IEscrow public immutable escrowContract;
    IOrchestrator public immutable orchestrator;

    /* ============ Constructor ============ */

    constructor(address _escrow, address _orchestrator) {
        escrowContract = IEscrow(_escrow);
        orchestrator = IOrchestrator(_orchestrator);
    }

    /* ============ View Functions ============ */

    /**
     * @notice Gets details for a single deposit.
     * @param _depositId The ID of the deposit.
     * @return depositView The DepositView struct.
     */
    function getDeposit(uint256 _depositId) public view returns (IProtocolViewer.DepositView memory depositView) {
        IEscrow.Deposit memory deposit = escrowContract.getDeposit(_depositId);
        ( , uint256 reclaimableAmount) = escrowContract.getExpiredIntents(_depositId);
        bytes32[] memory intentHashes = escrowContract.getDepositIntentHashes(_depositId);

        bytes32[] memory paymentMethods = escrowContract.getDepositPaymentMethods(_depositId);
        PaymentMethodDataView[] memory paymentMethodViews = new PaymentMethodDataView[](paymentMethods.length);
        for (uint256 i = 0; i < paymentMethods.length; ++i) {
            bytes32 paymentMethod = paymentMethods[i];
            IEscrow.Currency[] memory currencies = new IEscrow.Currency[](escrowContract.getDepositCurrencies(_depositId, paymentMethod).length);
            for (uint256 j = 0; j < currencies.length; ++j) {
                bytes32 code = escrowContract.getDepositCurrencies(_depositId, paymentMethod)[j];
                currencies[j] = IEscrow.Currency({
                    code: code,
                    minConversionRate: escrowContract.getDepositCurrencyMinRate(_depositId, paymentMethod, code)
                });
            }
            paymentMethodViews[i] = PaymentMethodDataView({
                paymentMethod: paymentMethod,
                verificationData: escrowContract.getDepositPaymentMethodData(_depositId, paymentMethod),
                currencies: currencies
            });
        }

        depositView = DepositView({
            depositId: _depositId,
            deposit: deposit,
            availableLiquidity: deposit.remainingDeposits + reclaimableAmount,
            paymentMethods: paymentMethodViews,
            intentHashes: intentHashes
        });
    }

    /**
     * @notice Gets deposit details for a list of deposit IDs.
     * @param _depositIds Array of deposit IDs.
     * @return depositArray Array of DepositView structs.
     */
    function getDepositFromIds(
        uint256[] memory _depositIds
    ) external view override returns (IProtocolViewer.DepositView[] memory depositArray) {
        depositArray = new DepositView[](_depositIds.length);

        for (uint256 i = 0; i < _depositIds.length; ++i) {
            uint256 depositId = _depositIds[i];
            depositArray[i] = getDeposit(depositId);
        }
    }

    /**
     * @notice Gets all deposits for a specific account.
     * @param _account The account address.
     * @return depositArray Array of DepositView structs.
     */
    function getAccountDeposits(address _account) external view returns (IProtocolViewer.DepositView[] memory depositArray) {
        uint256[] memory accountDepositIds = escrowContract.getAccountDeposits(_account);
        depositArray = new DepositView[](accountDepositIds.length);
        
        for (uint256 i = 0; i < accountDepositIds.length; ++i) {
            uint256 depositId = accountDepositIds[i];
            depositArray[i] = getDeposit(depositId);
        }
    }

    /**
     * @notice Gets details for a single intent.
     * @param _intentHash The hash of the intent.
     * @return intentView The IntentView struct.
     */
    function getIntent(bytes32 _intentHash) public view returns (IProtocolViewer.IntentView memory intentView) {
        IOrchestrator.Intent memory intent = orchestrator.getIntent(_intentHash);
        DepositView memory deposit = getDeposit(intent.depositId);
        intentView = IntentView({
            intentHash: _intentHash,
            intent: intent,
            deposit: deposit
        });
    }

    /**
     * @notice Gets details for a list of intent hashes.
     * @param _intentHashes Array of intent hashes.
     * @return intentArray Array of IntentView structs.
     */
    function getIntents(bytes32[] calldata _intentHashes) external view returns (IProtocolViewer.IntentView[] memory intentArray) {
        intentArray = new IntentView[](_intentHashes.length);

        for (uint256 i = 0; i < _intentHashes.length; ++i) {
            intentArray[i] = getIntent(_intentHashes[i]);
        }
    }

    /**
     * @notice Gets the active intents for a specific account.
     * @param _account The account address.
     * @return intentViews Array of IntentView structs.
     */
    function getAccountIntents(address _account) external view returns (IProtocolViewer.IntentView[] memory intentViews) {
        bytes32[] memory intentHashes = orchestrator.getAccountIntents(_account);
        intentViews = new IntentView[](intentHashes.length);
        
        for (uint256 i = 0; i < intentHashes.length; ++i) {
            intentViews[i] = getIntent(intentHashes[i]);
        }
    }
}
