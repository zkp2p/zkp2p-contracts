import * as fs from "fs";
import * as path from "path";

describe("active orchestrator package ABI", () => {
  it("publishes the relayer-free OrchestratorV3 constructor and surface", () => {
    const abi = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, "../abis/contracts/OrchestratorV3.json"), "utf8")
    );
    const constructor = abi.find((entry: { type: string }) => entry.type === "constructor");
    const retiredNames = new Set([
      "AccountHasActiveIntent",
      "AllowMultipleIntentsUpdated",
      ["DepositRisk", "HookSet"].join(""),
      "DepositWhitelistHookSet",
      "RelayerRegistryUpdated",
      "allowMultipleIntents",
      ["defaultRisk", "Hook"].join(""),
      ["getDepositRisk", "Hook"].join(""),
      "getDepositWhitelistHook",
      ["makerRisk", "Hooks"].join(""),
      ["migrateMakerRisk", "Hooks"].join(""),
      "relayerRegistry",
      "setAllowMultipleIntents",
      ["setDefaultRisk", "Hook"].join(""),
      ["setDepositRisk", "Hook"].join(""),
      "setDepositWhitelistHook",
      ["setMakerRisk", "Hook"].join(""),
      "setRelayerRegistry",
    ]);

    expect(constructor.inputs.map((input: { name: string }) => input.name)).toEqual([
      "_owner",
      "_chainId",
      "_escrowRegistry",
      "_paymentVerifierRegistry",
      "_protocolFee",
      "_protocolFeeRecipient",
      "_callbackGasLimit",
    ]);
    expect(abi.filter((entry: { name?: string }) => entry.name && retiredNames.has(entry.name))).toEqual([]);
    expect(abi.some((entry: { name?: string }) => entry.name === "lifecycleHook")).toBe(true);
    expect(abi.some((entry: { name?: string }) => entry.name === "setLifecycleHook")).toBe(true);
  });
});
