#!/usr/bin/env node

process.env.ALCHEMY_API_KEY ||= "offline";
process.env.BASE_DEPLOY_PRIVATE_KEY ||=
  "1111111111111111111111111111111111111111111111111111111111111111";
process.env.TESTNET_DEPLOY_PRIVATE_KEY ||=
  "2222222222222222222222222222222222222222222222222222222222222222";

require(require.resolve("ts-node/register/transpile-only"));
require(require.resolve("module-alias/register"));
const moduleAlias = require(require.resolve("module-alias"));
moduleAlias.reset();
moduleAlias.addAlias("@utils", process.cwd() + "/utils");

const assert = require("node:assert/strict");
const { readdirSync } = require("node:fs");
const { join } = require("node:path");
const { test } = require("node:test");

const {
  assertSupportedDeploymentTag,
  selectActiveDeploymentScripts,
} = require("../deployments/immutableDeploymentLanes.ts");
const { runActiveDeployment } = require("./deployActive.ts");
const lane38 = require("../deploy/38_activate_method_scoped_dispute_lifecycle_stack.ts");

const lanesFixture = {
  "37_deploy_method_scoped_dispute_lifecycle_stack.ts": {
    activeSource: null,
    retired: true,
    tags: [
      "37_deploy_method_scoped_dispute_lifecycle_stack",
      "V3DisputeMethodScopedStack",
    ],
  },
  "38_activate_method_scoped_dispute_lifecycle_stack.ts": {
    activeSource: undefined,
    retired: false,
    tags: [
      "38_activate_method_scoped_dispute_lifecycle_stack",
      "V3DisputeMethodScopedActivation",
    ],
  },
};

test("runner fixture retires lane 37 and mounts lane 38", () => {
  const filenames = [
    "37_deploy_method_scoped_dispute_lifecycle_stack.ts",
    "38_activate_method_scoped_dispute_lifecycle_stack.ts",
  ];
  const selected = selectActiveDeploymentScripts(
    process.cwd(),
    filenames,
    lanesFixture
  );
  assert.deepEqual(
    selected.map(({ filename }) => filename),
    ["38_activate_method_scoped_dispute_lifecycle_stack.ts"]
  );
  assert.throws(
    () =>
      assertSupportedDeploymentTag(
        "37_deploy_method_scoped_dispute_lifecycle_stack",
        lanesFixture
      ),
    /Refusing retired deployment tag/
  );
  assert.doesNotThrow(() =>
    assertSupportedDeploymentTag(
      "38_activate_method_scoped_dispute_lifecycle_stack",
      lanesFixture
    )
  );
});

test("active runner threads the lane fixture into the mounted set", () => {
  const status = runActiveDeployment("base", undefined, {
    repositoryRoot: process.cwd(),
    hardhatCli: "/virtual/hardhat-cli.js",
    lanes: lanesFixture,
    spawnSync: (_command, args) => {
      const activeDirectory = args[args.indexOf("--deploy-scripts") + 1];
      const filenames = readdirSync(activeDirectory);
      assert.equal(
        filenames.includes(
          "37_deploy_method_scoped_dispute_lifecycle_stack.ts"
        ),
        false
      );
      assert.equal(
        filenames.includes(
          "38_activate_method_scoped_dispute_lifecycle_stack.ts"
        ),
        true
      );
      assert.equal(
        readdirSync(join(process.cwd(), "deploy")).includes(
          "38_activate_method_scoped_dispute_lifecycle_stack.ts"
        ),
        true
      );
      return { status: 0 };
    },
  });
  assert.equal(status, 0);
});

test("lane 38 rejects untagged activation flags on every network and direct execution", async () => {
  const previousTag = process.env.DEPLOY_ACTIVE_TAG;
  const flag = lane38.FLAGS.baseRotationPrepare;
  const previousFlag = process.env[flag];
  delete process.env.DEPLOY_ACTIVE_TAG;
  process.env[flag] = "true";
  const fakeHre = /** @type {any} */ ({
    deployments: { getNetworkName: () => "base" },
  });
  const laneFunction = /** @type {any} */ (lane38.default);
  try {
    await assert.rejects(
      () => laneFunction.skip(fakeHre),
      /Lane 38 flags require DEPLOY_ACTIVE_TAG/
    );
    for (const network of ["localhost", "hardhat", "sepolia"]) {
      fakeHre.deployments.getNetworkName = () => network;
      await assert.rejects(
        () => laneFunction.skip(fakeHre),
        /Lane 38 flags require DEPLOY_ACTIVE_TAG/
      );
    }
    fakeHre.deployments.getNetworkName = () => "base";
    await assert.rejects(
      () => laneFunction(fakeHre),
      /Lane 38 activation requires DEPLOY_ACTIVE_TAG/
    );
  } finally {
    if (previousTag === undefined) delete process.env.DEPLOY_ACTIVE_TAG;
    else process.env.DEPLOY_ACTIVE_TAG = previousTag;
    if (previousFlag === undefined) delete process.env[flag];
    else process.env[flag] = previousFlag;
  }
});
