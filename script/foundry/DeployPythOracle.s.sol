// SPDX-License-Identifier: MIT
pragma solidity ^0.8.18;

import { Script } from "forge-std/Script.sol";
import { console2 } from "forge-std/console2.sol";

import { PythOracleAdapter } from "../../contracts/oracles/PythOracleAdapter.sol";
import { PythMock } from "../../contracts/mocks/PythMock.sol";

contract DeployPythOracle is Script {
    struct DeploymentConfig {
        address pyth;
        bool deployMockPyth;
    }

    struct DeploymentResult {
        address pyth;
        address pythOracleAdapter;
    }

    function run() external returns (DeploymentResult memory result) {
        uint256 deployerPrivateKey = vm.envUint("PRIVATE_KEY");
        DeploymentConfig memory config = _loadConfig();

        return deployWithConfig(config, deployerPrivateKey);
    }

    function deployWithConfig(DeploymentConfig memory config, uint256 deployerPrivateKey)
        public
        returns (DeploymentResult memory result)
    {
        vm.startBroadcast(deployerPrivateKey);

        if (config.pyth == address(0)) {
            require(config.deployMockPyth, "PYTH_ADDRESS required unless DEPLOY_PYTH_MOCK=true");
            PythMock pythMock = new PythMock();
            result.pyth = address(pythMock);
        } else {
            result.pyth = config.pyth;
        }

        PythOracleAdapter pythOracleAdapter = new PythOracleAdapter(result.pyth);

        vm.stopBroadcast();

        result.pythOracleAdapter = address(pythOracleAdapter);
        _logResult(result);
        return result;
    }

    function _loadConfig() internal view returns (DeploymentConfig memory config) {
        config.pyth = vm.envOr("PYTH_ADDRESS", address(0));
        config.deployMockPyth = vm.envOr("DEPLOY_PYTH_MOCK", false);
    }

    function _logResult(DeploymentResult memory result) internal pure {
        console2.log("DeployPythOracle complete");
        console2.log("pyth", result.pyth);
        console2.log("pythOracleAdapter", result.pythOracleAdapter);
    }
}
