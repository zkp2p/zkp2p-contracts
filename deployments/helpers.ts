import { HardhatRuntimeEnvironment } from "hardhat/types";
import { Address } from "../utils/types";
import { BigNumber } from "ethers";
import * as fs from "fs";
import * as path from "path";
import { DEPLOY_TX_DELAY_MS } from "./parameters";

const ENV_DELAY_OVERRIDE = process.env.DEPLOY_TX_DELAY_MS;

export async function waitForDeploymentDelay(hre: HardhatRuntimeEnvironment): Promise<void> {
  const network = hre.deployments.getNetworkName();
  const overrideDelay = ENV_DELAY_OVERRIDE ? Number(ENV_DELAY_OVERRIDE) : undefined;
  const networkDelay = DEPLOY_TX_DELAY_MS[network] ?? 0;
  const delay = overrideDelay !== undefined && !Number.isNaN(overrideDelay) ? overrideDelay : networkDelay;

  if (delay > 0) {
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function waitForAccountNonceSync(hre: HardhatRuntimeEnvironment, account: string): Promise<void> {
  const provider = hre.ethers.provider;
  const maxIterations = 300;
  for (let i = 0; i < maxIterations; i += 1) {
    const latest = await provider.getTransactionCount(account, "latest");
    const pending = await provider.getTransactionCount(account, "pending");
    if (pending === latest) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Pending transactions for ${account} did not settle in time`);
}

async function sendDeploymentTransaction(
  hre: HardhatRuntimeEnvironment,
  tx: { from: string; to: string; data: string },
): Promise<void> {
  const provider = hre.ethers.provider;
  await waitForAccountNonceSync(hre, tx.from);
  const result = await hre.deployments.rawTx(tx);
  const txHash = typeof result === "string"
    ? result
    : (result as any)?.transactionHash ?? (result as any)?.hash ?? (result as any)?.txHash;
  if (!txHash) {
    throw new Error("Unable to determine transaction hash for deployment transaction");
  }
  await provider.waitForTransaction(txHash);
  await waitForAccountNonceSync(hre, tx.from);
  await waitForDeploymentDelay(hre);
}

export function getDeployedContractAddress(network: string, contractName: string): string {
  return require(`./${network}/${contractName}.json`).address;
}

export async function setNewOwner(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  newOwner: Address
): Promise<void> {
  const currentOwner = await contract.owner();

  if (currentOwner != newOwner) {
    const data = contract.interface.encodeFunctionData("transferOwnership", [newOwner]);
    await sendDeploymentTransaction(hre, {
      from: currentOwner,
      to: contract.address,
      data,
    });
  }
}

export async function setOrchestrator(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  orchestrator: Address
): Promise<void> {
  const currentOwner = await contract.owner();

  if (!(await contract.orchestrator() == orchestrator)) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      const data = contract.interface.encodeFunctionData("setOrchestrator", [orchestrator]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: contract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${contract.interface.encodeFunctionData("setOrchestrator", [orchestrator])}
        `
      );
    }
  }
}

export async function addEscrowToRegistry(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  escrow: Address
): Promise<void> {
  const currentOwner = await contract.owner();

  if (!(await contract.isWhitelistedEscrow(escrow))) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      const data = contract.interface.encodeFunctionData("addEscrow", [escrow]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: contract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${contract.interface.encodeFunctionData("addEscrow", [escrow])}
        `
      );
    }
  }
}


export async function addWritePermission(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  newPermission: Address
): Promise<void> {
  const currentOwner = await contract.owner();
  if (!(await contract.isWriter(newPermission))) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      const data = contract.interface.encodeFunctionData("addWritePermission", [newPermission]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: contract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${contract.interface.encodeFunctionData("addWritePermission", [newPermission])}
        `
      );
    }
  }
}

export async function addPostIntentHook(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  hook: Address
): Promise<void> {
  const currentOwner = await contract.owner();
  if (!(await contract.isWhitelistedHook(hook))) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      const data = contract.interface.encodeFunctionData("addPostIntentHook", [hook]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: contract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${contract.interface.encodeFunctionData("addPostIntentHook", [hook])}
        contract address: ${contract.address}
        `
      );
    }
  }
}

export async function addCurrency(
  hre: HardhatRuntimeEnvironment,
  contract: any,
  currency: string
): Promise<void> {
  const currentOwner = await contract.owner();
  const existingCurrencies = await contract.getCurrencies();
  if (!existingCurrencies.includes(currency)) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      console.log("Adding currency ", currency, "to", contract.address);
      const data = contract.interface.encodeFunctionData("addCurrency", [currency]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: contract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${contract.interface.encodeFunctionData("addCurrency", [currency])}
        contract address: ${contract.address}
        `
      );
    }
  }
}


// Provider hash helpers removed: enforcement is off-chain now

export async function addPaymentMethodToRegistry(
  hre: HardhatRuntimeEnvironment,
  paymentVerifierRegistryContract: any,
  paymentMethodHash: string,
  verifierAddress: Address,
  currencies: string[]
): Promise<void> {
  const currentOwner = await paymentVerifierRegistryContract.owner();
  const isPaymentMethod = await paymentVerifierRegistryContract.isPaymentMethod(paymentMethodHash);

  if (!isPaymentMethod) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      console.log(`Adding payment method ${paymentMethodHash} to registry with verifier ${verifierAddress}`);
      const data = paymentVerifierRegistryContract.interface.encodeFunctionData("addPaymentMethod", [
        paymentMethodHash,
        verifierAddress,
        currencies
      ]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: paymentVerifierRegistryContract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${paymentVerifierRegistryContract.interface.encodeFunctionData("addPaymentMethod", [
          paymentMethodHash,
          verifierAddress,
          currencies
        ])}
        contract address: ${paymentVerifierRegistryContract.address}
        `
      );
    }
  } else {
    console.log(`Payment method ${paymentMethodHash} already exists in registry`);
  }
}

export async function addPaymentMethodToUnifiedVerifier(
  hre: HardhatRuntimeEnvironment,
  unifiedVerifierContract: any,
  paymentMethodHash: string
): Promise<void> {
  const currentOwner = await unifiedVerifierContract.owner();
  const paymentMethods = await unifiedVerifierContract.getPaymentMethods();

  if (!paymentMethods.includes(paymentMethodHash)) {
    if ((await hre.getUnnamedAccounts()).includes(currentOwner)) {
      console.log(`Adding payment method ${paymentMethodHash} to unified verifier`);
      const data = unifiedVerifierContract.interface.encodeFunctionData("addPaymentMethod", [
        paymentMethodHash
      ]);
      await sendDeploymentTransaction(hre, {
        from: currentOwner,
        to: unifiedVerifierContract.address,
        data,
      });
    } else {
      console.log(
        `Contract owner is not in the list of accounts, must be manually added with the following calldata:
        ${unifiedVerifierContract.interface.encodeFunctionData("addPaymentMethod", [
          paymentMethodHash
        ])}
        contract address: ${unifiedVerifierContract.address}
        `
      );
    }
  } else {
    console.log(`Payment method ${paymentMethodHash} already exists in unified verifier`);
  }
}

// Persist payment method snapshots per network to avoid drift between code and configured on-chain state
export function savePaymentMethodSnapshot(
  network: string,
  methodKey: string,
  data: {
    paymentMethodHash: string;
    currencies: string[];
  }
): void {
  const providersDir = path.join(__dirname, "outputs", "platforms");
  if (!fs.existsSync(providersDir)) fs.mkdirSync(providersDir, { recursive: true });

  const normalizeHex = (h: string) => (h.startsWith("0x") ? h.toLowerCase() : `0x${h.toLowerCase()}`);

  const snapshotData = {
    paymentMethodHash: normalizeHex(data.paymentMethodHash),
    currencies: data.currencies || [],
    updatedAt: new Date().toISOString()
  };

  // For production networks (base_sepolia, base_staging, base), save with timestamp and maintain latest
  const productionNetworks = ['base_sepolia', 'base_staging', 'base'];

  if (productionNetworks.includes(network)) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
    const timestampedDir = path.join(providersDir, 'snapshots', network);
    if (!fs.existsSync(timestampedDir)) fs.mkdirSync(timestampedDir, { recursive: true });

    const timestampedFilePath = path.join(timestampedDir, `${methodKey}_${timestamp}.json`);
    fs.writeFileSync(timestampedFilePath, JSON.stringify(snapshotData, null, 2));
    console.log(`Saved timestamped snapshot to: ${timestampedFilePath}`);

    const mainFilePath = path.join(providersDir, `${network}.json`);
    let current: any = { methods: {} };
    try {
      if (fs.existsSync(mainFilePath)) {
        current = JSON.parse(fs.readFileSync(mainFilePath, "utf8"));
      }
    } catch { }

    current.methods[methodKey] = snapshotData;
    fs.writeFileSync(mainFilePath, JSON.stringify(current, null, 2));
  } else {
    const filePath = path.join(providersDir, `${network}.json`);
    let current: any = { methods: {} };
    try {
      if (fs.existsSync(filePath)) {
        current = JSON.parse(fs.readFileSync(filePath, "utf8"));
      }
    } catch { }

    current.methods[methodKey] = snapshotData;
    fs.writeFileSync(filePath, JSON.stringify(current, null, 2));
  }
}
