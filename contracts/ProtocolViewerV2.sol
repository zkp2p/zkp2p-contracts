// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { IEscrow } from "./interfaces/IEscrow.sol";
import { IProtocolViewerV2 } from "./interfaces/IProtocolViewerV2.sol";
import { IOrchestratorV2 } from "./interfaces/IOrchestratorV2.sol";

contract ProtocolViewerV2 is IProtocolViewerV2 {
    error InvalidEscrow(address escrow);
    error InvalidOrchestrator(address orchestrator);

    function getDeposit(
        address _escrow,
        uint256 _depositId
    ) external view returns (IProtocolViewerV2.DepositView memory depositView) {
        depositView = _getDeposit(_escrow, _depositId);
    }

    function getDepositFromIds(
        address _escrow,
        uint256[] calldata _depositIds
    ) external view returns (IProtocolViewerV2.DepositView[] memory depositArray) {
        _escrowContract(_escrow);
        depositArray = new DepositView[](_depositIds.length);

        for (uint256 i = 0; i < _depositIds.length; ++i) {
            depositArray[i] = _getDeposit(_escrow, _depositIds[i]);
        }
    }

    function getIntent(
        address _orchestrator,
        bytes32 _intentHash
    ) external view returns (IProtocolViewerV2.IntentView memory intentView) {
        IOrchestratorV2.Intent memory intent = _orchestratorContract(_orchestrator).getIntent(_intentHash);
        intentView = IntentView({
            intentHash: _intentHash,
            intent: intent,
            deposit: _getDeposit(intent.escrow, intent.depositId)
        });
    }

    function getIntents(
        address _orchestrator,
        bytes32[] calldata _intentHashes
    ) external view returns (IProtocolViewerV2.IntentView[] memory intentArray) {
        IOrchestratorV2 orchestrator = _orchestratorContract(_orchestrator);
        intentArray = new IntentView[](_intentHashes.length);

        for (uint256 i = 0; i < _intentHashes.length; ++i) {
            bytes32 intentHash = _intentHashes[i];
            IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);
            intentArray[i] = IntentView({
                intentHash: intentHash,
                intent: intent,
                deposit: _getDeposit(intent.escrow, intent.depositId)
            });
        }
    }

    function getAccountIntents(
        address _orchestrator,
        address _account
    ) external view returns (IProtocolViewerV2.IntentView[] memory intentViews) {
        IOrchestratorV2 orchestrator = _orchestratorContract(_orchestrator);
        bytes32[] memory intentHashes = orchestrator.getAccountIntents(_account);
        intentViews = new IntentView[](intentHashes.length);

        for (uint256 i = 0; i < intentHashes.length; ++i) {
            bytes32 intentHash = intentHashes[i];
            IOrchestratorV2.Intent memory intent = orchestrator.getIntent(intentHash);
            intentViews[i] = IntentView({
                intentHash: intentHash,
                intent: intent,
                deposit: _getDeposit(intent.escrow, intent.depositId)
            });
        }
    }

    function _getDeposit(
        address _escrow,
        uint256 _depositId
    ) internal view returns (IProtocolViewerV2.DepositView memory depositView) {
        IEscrow escrowContract = _escrowContract(_escrow);
        IEscrow.Deposit memory deposit = escrowContract.getDeposit(_depositId);
        (, uint256 reclaimableAmount) = escrowContract.getExpiredIntents(_depositId);
        bytes32[] memory intentHashes = escrowContract.getDepositIntentHashes(_depositId);

        bytes32[] memory paymentMethods = escrowContract.getDepositPaymentMethods(_depositId);
        PaymentMethodDataView[] memory paymentMethodViews = new PaymentMethodDataView[](paymentMethods.length);
        for (uint256 i = 0; i < paymentMethods.length; ++i) {
            bytes32 paymentMethod = paymentMethods[i];
            bytes32[] memory currencyCodes = escrowContract.getDepositCurrencies(_depositId, paymentMethod);
            IEscrow.Currency[] memory currencies = new IEscrow.Currency[](currencyCodes.length);

            for (uint256 j = 0; j < currencyCodes.length; ++j) {
                bytes32 code = currencyCodes[j];
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

    function _escrowContract(address _escrow) internal pure returns (IEscrow escrowContract) {
        if (_escrow == address(0)) {
            revert InvalidEscrow(_escrow);
        }
        escrowContract = IEscrow(_escrow);
    }

    function _orchestratorContract(address _orchestrator) internal pure returns (IOrchestratorV2 orchestrator) {
        if (_orchestrator == address(0)) {
            revert InvalidOrchestrator(_orchestrator);
        }
        orchestrator = IOrchestratorV2(_orchestrator);
    }
}
