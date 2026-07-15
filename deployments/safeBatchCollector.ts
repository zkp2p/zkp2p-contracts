import * as fs from "fs";
import * as path from "path";

interface SafeTransaction {
  to: string;
  value: string;
  data: string;
  contractMethod: null;
  contractInputsValues: null;
}

interface SafeBatch {
  version: string;
  chainId: string;
  createdAt: number;
  meta: {
    name: string;
    description: string;
    txBuilderVersion: string;
    createdFromSafeAddress: string;
    createdFromOwnerAddress: string;
  };
  transactions: SafeTransaction[];
}

class SafeBatchCollector {
  private transactions: SafeTransaction[] = [];

  add(to: string, data: string, description?: string): void {
    this.transactions.push({
      to,
      value: "0",
      data,
      contractMethod: null,
      contractInputsValues: null,
    });
    if (description) {
      console.log(`  [Safe Batch] ${description}`);
    }
  }

  count(): number {
    return this.transactions.length;
  }

  writeBatchFile(network: string, chainId: string, safeAddress: string): string {
    if (this.transactions.length === 0) {
      return "";
    }

    const batch: SafeBatch = {
      version: "1.0",
      chainId,
      createdAt: Date.now(),
      meta: {
        name: `ZKP2P V2 Deployment - ${network}`,
        description: `Registry wiring and payment method migration for V2 deployment on ${network}`,
        txBuilderVersion: "1.16.5",
        createdFromSafeAddress: safeAddress,
        createdFromOwnerAddress: "",
      },
      transactions: this.transactions,
    };

    const outputDir = path.join(__dirname, "outputs", "safe-batches");
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, -5);
    const filePath = path.join(outputDir, `${network}_${timestamp}.json`);
    fs.writeFileSync(filePath, JSON.stringify(batch, null, 2));

    return filePath;
  }
}

// Singleton — shared across all deploy scripts in a single hardhat deploy run
export const safeBatchCollector = new SafeBatchCollector();
