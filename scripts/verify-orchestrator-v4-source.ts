import { utils } from "ethers";
import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Manifest } from "./deploy-orchestrator-v4";

export class SourceVerificationError extends Error {}
const check = (condition: unknown, message: string): void => { if (!condition) throw new SourceVerificationError(message); };

/** Etherscan V2 keeps chain selection on every request; never surface authenticated URLs or API response text. */
export async function verifySources(hre: HardhatRuntimeEnvironment, manifest: Manifest, apiKey: string) {
  check(Boolean(apiKey), "ETHERSCAN_API_KEY is required for source verification");
  const results = [];
  async function request(action: string, values: Record<string, string>, post = false) {
    const query = new URLSearchParams({ chainid: String(manifest.configuration.chainId), apikey: apiKey, module: "contract", action, ...(post ? {} : values) });
    await new Promise((resolve) => setTimeout(resolve, 600));
    const response = await fetch(`https://api.etherscan.io/v2/api?${query}`, {
      method: post ? "POST" : "GET", signal: AbortSignal.timeout(30_000),
      ...(post ? { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values).toString() } : {}),
    });
    check(response.ok, `Explorer ${action} HTTP request failed`);
    const data: unknown = await response.json();
    check(typeof data === "object" && data !== null && "status" in data && "result" in data, `Explorer ${action} response is malformed`);
    return data as { status: string; result: unknown };
  }
  for (const [name, record] of Object.entries(manifest.contracts)) {
    if (!record) throw new SourceVerificationError(`Missing ${name} deployment record`);
    const artifact = await hre.artifacts.readArtifact(record.artifact);
    const contractName = `${artifact.sourceName}:${artifact.contractName}`;
    const build = await hre.artifacts.getBuildInfo(contractName);
    if (!build) throw new SourceVerificationError(`Missing ${name} compiler build information`);
    const compiler = `v${build.solcLongVersion}`;
    const constructorArguments = new utils.Interface(artifact.abi).encodeDeploy(record.constructorArguments).slice(2);
    async function exactSource(): Promise<boolean> {
      const response = await request("getsourcecode", { address: record.address });
      check(response.status === "1" && Array.isArray(response.result) && response.result.length === 1, `Explorer source lookup failed for ${name}`);
      const source = (response.result as Array<Record<string, unknown>>)[0];
      return typeof source.SourceCode === "string" && source.SourceCode.length > 0 &&
        source.ContractName === artifact.contractName && source.CompilerVersion === compiler &&
        typeof source.ConstructorArguments === "string" && source.ConstructorArguments.toLowerCase() === constructorArguments.toLowerCase() &&
        !source.SimilarMatch;
    }
    if (!await exactSource()) {
      const submission = await request("verifysourcecode", {
        contractaddress: record.address, sourceCode: JSON.stringify(build.input), contractname: contractName,
        compilerversion: compiler, codeformat: "solidity-standard-json-input", constructorArguments,
      }, true);
      check(submission.status === "1" && typeof submission.result === "string" && /^[a-zA-Z0-9]+$/.test(submission.result), `Explorer rejected source submission for ${name}`);
      let verified = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        const result = await request("checkverifystatus", { guid: submission.result as string });
        if (result.status === "1" && result.result === "Pass - Verified") { verified = true; break; }
        check(result.result === "Pending in queue", `Explorer source verification failed for ${name}`);
      }
      check(verified && await exactSource(), `Explorer exact source verification is incomplete for ${name}`);
    }
    results.push({ name, address: record.address, compiler, constructorArguments, sourceCommit: manifest.sourceCommit, explorerUrl: `https://basescan.org/address/${record.address}#code`, verified: true });
    console.log(`Verified ${name} source and constructor on Basescan`);
  }
  return results;
}
