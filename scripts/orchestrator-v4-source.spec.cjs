require("ts-node/register/transpile-only");
const assert = require("node:assert/strict");
const { test } = require("node:test");
const hre = require("hardhat");
const { utils } = require("ethers");
const { verifySources, SourceVerificationError } = require("./verify-orchestrator-v4-source.ts");

async function fixture() {
  const artifact = await hre.artifacts.readArtifact("WhitelistPolicyV2");
  const build = await hre.artifacts.getBuildInfo(`${artifact.sourceName}:${artifact.contractName}`);
  const args = ["0x1111111111111111111111111111111111111111"];
  return {
    build,
    manifest: { configuration: { chainId: 8453 }, sourceCommit: "a".repeat(40), contracts: { WhitelistPolicyV2: { artifact: "WhitelistPolicyV2", address: "0x2222222222222222222222222222222222222222", constructorArguments: args } } },
    verified: { SourceCode: JSON.stringify(build.input), ContractName: artifact.contractName, CompilerVersion: `v${build.solcLongVersion}`, ConstructorArguments: new utils.Interface(artifact.abi).encodeDeploy(args).slice(2), SimilarMatch: "" },
  };
}
const response = (data) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });

test("exact explorer source skips submission and records constructor/compiler evidence", async () => {
  const f = await fixture(), original = global.fetch;
  let requests = 0;
  global.fetch = async (url, options) => {
    requests++;
    const query = new URL(url).searchParams;
    assert.equal(query.get("chainid"), "8453"); assert.equal(query.get("action"), "getsourcecode");
    assert.equal(options.method, "GET");
    return response({ status: "1", result: [f.verified] });
  };
  try {
    const [result] = await verifySources(hre, f.manifest, "public-fixture-api-key");
    assert.equal(requests, 1); assert.equal(result.verified, true);
    assert.equal(result.constructorArguments, f.verified.ConstructorArguments);
    assert.equal(result.sourceCommit, f.manifest.sourceCommit);
  } finally { global.fetch = original; }
});

test("unverified deployment submits exact compiler input and retains Base chain selection while polling", async () => {
  const f = await fixture(), original = global.fetch;
  const actions = [];
  global.fetch = async (url, options) => {
    const query = new URL(url).searchParams, action = query.get("action");
    actions.push(action); assert.equal(query.get("chainid"), "8453");
    if (action === "verifysourcecode") {
      assert.equal(options.method, "POST"); const form = new URLSearchParams(options.body);
      assert.deepEqual(JSON.parse(form.get("sourceCode")), f.build.input);
      assert.equal(form.get("constructorArguments"), f.verified.ConstructorArguments);
      assert.equal(form.get("compilerversion"), f.verified.CompilerVersion);
      return response({ status: "1", result: "fixtureGuid" });
    }
    if (action === "checkverifystatus") { assert.equal(query.get("guid"), "fixtureGuid"); return response({ status: "1", result: "Pass - Verified" }); }
    return response({ status: "1", result: [actions.length === 1 ? { SourceCode: "" } : f.verified] });
  };
  try {
    await verifySources(hre, f.manifest, "public-fixture-api-key");
    assert.deepEqual(actions, ["getsourcecode", "verifysourcecode", "checkverifystatus", "getsourcecode"]);
  } finally { global.fetch = original; }
});

test("mismatched constructors and upstream errors cannot be reported as successful verification or leak API text", async () => {
  const f = await fixture(), original = global.fetch;
  global.fetch = async (url) => new URL(url).searchParams.get("action") === "getsourcecode"
    ? response({ status: "1", result: [{ ...f.verified, ConstructorArguments: "" }] })
    : response({ status: "0", result: "rejected public-fixture-api-key" });
  try {
    await assert.rejects(verifySources(hre, f.manifest, "public-fixture-api-key"), (error) => {
      assert.ok(error instanceof SourceVerificationError);
      assert.equal(error.message, "Explorer rejected source submission for WhitelistPolicyV2");
      return true;
    });
  } finally { global.fetch = original; }
});
