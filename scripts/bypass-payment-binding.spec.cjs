#!/usr/bin/env node
// @ts-check

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
const { test } = require("node:test");
const hardhat = require("hardhat");
const { ethers } = require("ethers");
const {
  BYPASS_EXPECTED_LIVE,
  BYPASS_RECORDED_DEPLOYMENTS,
  BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS,
  expectedPaymentMethodCurrencies,
} = require("../deployments/bypassDisputeStack.ts");
const {
  EXPECTED_LIVE,
} = require("../deploy/37_deploy_method_scoped_dispute_lifecycle_stack.ts");
const {
  bypassPaymentBindingRecorded,
  verifyBypassPaymentBinding,
  verifySupersededStagingBinding,
} = require("../deployments/bypassPaymentBinding.ts");
const hash = ethers.utils.id;
const OTHER = ethers.constants.AddressZero;

function fixture(superseded = false) {
  const pins = BYPASS_EXPECTED_LIVE.base_staging;
  const shared = EXPECTED_LIVE.base_staging;
  const recorded = {
    UnifiedPaymentVerifierV4: {
      ...BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.UnifiedPaymentVerifierV4,
    },
  };
  BYPASS_RECORDED_DEPLOYMENTS.base_staging =
    /** @type {NonNullable<typeof BYPASS_RECORDED_DEPLOYMENTS.base_staging>} */ (
      recorded
    );
  assert.ok(recorded);
  const verifierRecord = {
    ...require("../deployments/base_staging/UnifiedPaymentVerifierV4.json"),
  };
  if (!superseded)
    verifierRecord.address = "0x0000000000000000000000000000000000000001";
  recorded.UnifiedPaymentVerifierV4.address = verifierRecord.address;
  /** @type {Record<string, string>} */
  const addresses = {
    NullifierRegistryV2: shared.nullifierRegistryV2,
    MultiAttestationVerifier: shared.attestationVerifier,
    OrchestratorV3: shared.orchestrator,
    OrchestratorRegistry: shared.orchestratorRegistry,
    PaymentVerifierRegistry: pins.paymentVerifierRegistry.address,
    NullifierRegistry:
      require("../deployments/base_staging/NullifierRegistry.json").address,
    UnifiedPaymentVerifierV4: verifierRecord.address,
  };
  /** @type {Record<string, any>} */
  const records = {};
  /** @type {Record<string, any>} */
  const contracts = {};
  const code = new Map();
  for (const [name, address] of Object.entries(addresses)) {
    records[name] = { address };
    contracts[name] = { owner: async () => pins.governance };
    code.set(address.toLowerCase(), "0x6000");
  }
  records.UnifiedPaymentVerifierV4 = verifierRecord;
  code.set(
    verifierRecord.address.toLowerCase(),
    verifierRecord.deployedBytecode
  );
  const methods = pins.paymentMethods.map(hash);
  Object.assign(contracts.UnifiedPaymentVerifierV4, {
    orchestratorRegistry: async () => shared.orchestratorRegistry,
    nullifierRegistry: async () => shared.nullifierRegistryV2,
    attestationVerifier: async () => shared.attestationVerifier,
    getPaymentMethods: async () => [...methods],
  });
  Object.assign(contracts.NullifierRegistryV2, {
    legacyNullifierRegistry: async () => addresses.NullifierRegistry,
    getWriters: async () => [addresses.UnifiedPaymentVerifierV4],
  });
  Object.assign(contracts.MultiAttestationVerifier, {
    requiredSignatures: async () => ethers.BigNumber.from(1),
    witnesses: async () => [...shared.attestationWitnesses],
  });
  contracts.OrchestratorRegistry.isOrchestrator = async () => true;
  Object.assign(contracts.OrchestratorV3, {
    paused: async () => false,
    chainId: async () => ethers.BigNumber.from(8453),
    paymentVerifierRegistry: async () => addresses.PaymentVerifierRegistry,
  });
  Object.assign(contracts.PaymentVerifierRegistry, {
    getPaymentMethods: async () => [...methods],
    getVerifier: async () => addresses.UnifiedPaymentVerifierV4,
    /** @param {string} method */
    getCurrencies: async (method) => {
      const name = pins.paymentMethods.find((name) => hash(name) === method);
      assert.ok(name);
      return expectedPaymentMethodCurrencies(name).map(hash);
    },
  });
  contracts.NullifierRegistry.getWriters = async () => [];
  const provider = {
    getNetwork: async () => ({ chainId: 8453 }),
    /** @param {string} address */
    getCode: async (address) => code.get(address.toLowerCase()) || "0x",
  };
  const hre = /** @type {any} */ ({
    deployments: {
      /** @param {string} name */
      get: async (name) => {
        assert.ok(records[name], name);
        return records[name];
      },
      getExtendedArtifact: hardhat.deployments.getExtendedArtifact.bind(
        hardhat.deployments
      ),
    },
    ethers: {
      ...ethers,
      provider,
      /** @param {string} name @param {string} address */
      getContractAt: async (name, address) => {
        assert.equal(address.toLowerCase(), addresses[name].toLowerCase());
        return contracts[name];
      },
    },
  });
  /** @type {Array<[Record<string, any>, string, string]>} */
  const hashes = [
    [shared, "nullifierRegistryV2CodeHash", ethers.utils.keccak256("0x6000")],
    [shared, "attestationVerifierCodeHash", ethers.utils.keccak256("0x6000")],
    [shared, "orchestratorCodeHash", ethers.utils.keccak256("0x6000")],
    [shared, "orchestratorRegistryCodeHash", ethers.utils.keccak256("0x6000")],
    [
      pins.paymentVerifierRegistry,
      "runtimeCodeHash",
      ethers.utils.keccak256("0x6000"),
    ],
    [
      recorded.UnifiedPaymentVerifierV4,
      "runtimeCodeHash",
      ethers.utils.keccak256(verifierRecord.deployedBytecode),
    ],
  ];
  const before = hashes.map(([object, key]) => object[key]);
  hashes.forEach(([object, key, value]) => {
    object[key] = value;
  });
  return {
    hre,
    records,
    contracts,
    provider,
    code,
    methods,
    pins,
    recorded,
    restore: () => {
      hashes.forEach(([object, key], index) => {
        object[key] = before[index];
      });
      delete BYPASS_RECORDED_DEPLOYMENTS.base_staging;
    },
  };
}

/** @typedef {ReturnType<typeof fixture>} Fixture */
/** @param {(state: Fixture) => Promise<void>} run */
async function withFixture(run, superseded = false) {
  const state = fixture(superseded);
  try {
    await run(state);
  } finally {
    state.restore();
  }
}

test("binding flag selects UPV4 on staging only, independent of aliases", () => {
  const aliases = require("../deployments/active-dispute-stack.json").networks;
  const before = aliases.base_staging.IntentLifecycleHookV1;
  try {
    for (const hook of [
      "IntentLifecycleHookV1Bypass",
      "IntentLifecycleHookV1MethodScopedStaked",
    ]) {
      aliases.base_staging.IntentLifecycleHookV1 = hook;
      assert.equal(bypassPaymentBindingRecorded("base_staging"), true);
      for (const network of ["base", "localhost", "hardhat", "unknown"])
        assert.equal(bypassPaymentBindingRecorded(network), false);
    }
  } finally {
    aliases.base_staging.IntentLifecycleHookV1 = before;
  }
});

test("staging binding passes with the superseded UPV4 record", async () => {
  await withFixture(async (s) => {
    delete BYPASS_RECORDED_DEPLOYMENTS.base_staging;
    const pin = BYPASS_SUPERSEDED_STAGING_DEPLOYMENTS.UnifiedPaymentVerifierV4;
    const previous = pin.runtimeCodeHash;
    try {
      pin.runtimeCodeHash = ethers.utils.keccak256(
        s.records.UnifiedPaymentVerifierV4.deployedBytecode
      );
      await verifyBypassPaymentBinding(s.hre, "base_staging");
    } finally {
      pin.runtimeCodeHash = previous;
    }
  }, true);
});

test("binding rejects the superseded address with different runtime code", async () => {
  await withFixture(async (s) => {
    delete BYPASS_RECORDED_DEPLOYMENTS.base_staging;
    s.code.set(s.pins.retiredVerifier.address.toLowerCase(), "0x6001");
    await assert.rejects(
      verifyBypassPaymentBinding(s.hre, "base_staging"),
      /runtime bytecode hash mismatch/
    );
  }, true);
});

test("superseded staging binding never reads deployment records", async () => {
  await withFixture(async (s) => {
    const pin = s.pins.retiredVerifier;
    const previous = pin.runtimeCodeHash;
    try {
      pin.runtimeCodeHash = ethers.utils.keccak256(
        s.records.UnifiedPaymentVerifierV4.deployedBytecode
      );
      s.hre.deployments.get = async () => {
        throw new Error("deployment record read");
      };
      for (const record of [
        s.records.UnifiedPaymentVerifierV4,
        undefined,
        { address: OTHER },
      ]) {
        s.records.UnifiedPaymentVerifierV4 = record;
        await verifySupersededStagingBinding(s.hre, pin);
      }
      s.contracts.NullifierRegistryV2.getWriters = async () => [
        pin.address,
        OTHER,
      ];
      await assert.rejects(
        verifySupersededStagingBinding(s.hre, pin),
        /writers mismatch/
      );
      s.contracts.NullifierRegistryV2.getWriters = async () => [pin.address];
      s.contracts.UnifiedPaymentVerifierV4.getPaymentMethods = async () =>
        s.methods.slice(1);
      await assert.rejects(
        verifySupersededStagingBinding(s.hre, pin),
        /method order mismatch/
      );
      s.code.set(pin.address.toLowerCase(), "0x6001");
      await assert.rejects(
        verifySupersededStagingBinding(s.hre, pin),
        /runtime bytecode hash mismatch/
      );
    } finally {
      pin.runtimeCodeHash = previous;
    }
  }, true);
});

test("unrecorded canonical fresh verifier binding passes", async () => {
  await withFixture(async (s) => {
    delete BYPASS_RECORDED_DEPLOYMENTS.base_staging;
    const record = s.records.UnifiedPaymentVerifierV4;
    record.solcInputHash = "canonical-test-cache";
    s.hre.deployments.getExtendedArtifact = async () => ({
      solcInputHash: record.solcInputHash,
      deployedBytecode: record.deployedBytecode,
    });
    await verifyBypassPaymentBinding(s.hre, "base_staging");
  });
});

/** @type {Array<[string, (state: Fixture) => void, RegExp]>} */
const drifts = [
  [
    "extra NRV2 writer",
    (s) => {
      s.contracts.NullifierRegistryV2.getWriters = async () => [
        s.records.UnifiedPaymentVerifierV4.address,
        OTHER,
      ];
    },
    /NullifierRegistryV2 writers mismatch/,
  ],
  [
    "NRV2 still UPV3",
    (s) => {
      s.contracts.NullifierRegistryV2.getWriters = async () => [
        s.pins.unifiedPaymentVerifierV3.address,
      ];
    },
    /NullifierRegistryV2 writers mismatch/,
  ],
  [
    "one UPV3 route",
    (s) => {
      s.contracts.PaymentVerifierRegistry.getVerifier = async (
        /** @type {string} */ method
      ) =>
        method === s.methods[0]
          ? s.pins.unifiedPaymentVerifierV3.address
          : s.records.UnifiedPaymentVerifierV4.address;
    },
    /Payment verifier route mismatch/,
  ],
  [
    "reordered currencies",
    (s) => {
      const original = s.contracts.PaymentVerifierRegistry.getCurrencies;
      s.contracts.PaymentVerifierRegistry.getCurrencies = async (
        /** @type {string} */ method
      ) => {
        const currencies = await original(method);
        return method === hash("paypal") ? currencies.reverse() : currencies;
      };
    },
    /Payment currencies mismatch/,
  ],
  [
    "swapped registry order",
    (s) => {
      const methods = [...s.methods];
      [methods[0], methods[1]] = [methods[1], methods[0]];
      s.contracts.PaymentVerifierRegistry.getPaymentMethods = async () =>
        methods;
    },
    /Payment registry method order mismatch/,
  ],
  [
    "missing UPV4 method",
    (s) => {
      s.contracts.UnifiedPaymentVerifierV4.getPaymentMethods = async () =>
        s.methods.slice(1);
    },
    /UPV4 method order mismatch/,
  ],
  [
    "UPV4 owner",
    (s) => {
      s.contracts.UnifiedPaymentVerifierV4.owner = async () => OTHER;
    },
    /UPV4 owner mismatch/,
  ],
  [
    "UPV4 orchestrator registry",
    (s) => {
      s.contracts.UnifiedPaymentVerifierV4.orchestratorRegistry = async () =>
        OTHER;
    },
    /UPV4 orchestrator registry mismatch/,
  ],
  [
    "UPV4 nullifier registry",
    (s) => {
      s.contracts.UnifiedPaymentVerifierV4.nullifierRegistry = async () =>
        OTHER;
    },
    /UPV4 nullifier registry mismatch/,
  ],
  [
    "UPV4 attestation verifier",
    (s) => {
      s.contracts.UnifiedPaymentVerifierV4.attestationVerifier = async () =>
        OTHER;
    },
    /UPV4 attestation verifier mismatch/,
  ],
  [
    "attestation threshold",
    (s) => {
      s.contracts.MultiAttestationVerifier.requiredSignatures = async () =>
        ethers.BigNumber.from(2);
    },
    /Attestation threshold mismatch/,
  ],
  [
    "attestation witnesses",
    (s) => {
      s.contracts.MultiAttestationVerifier.witnesses = async () => [OTHER];
    },
    /Attestation witnesses mismatch/,
  ],
  [
    "legacy registry target",
    (s) => {
      s.contracts.NullifierRegistryV2.legacyNullifierRegistry = async () =>
        OTHER;
    },
    /Legacy nullifier registry mismatch/,
  ],
  [
    "unregistered orchestrator",
    (s) => {
      s.contracts.OrchestratorRegistry.isOrchestrator = async () => false;
    },
    /Orchestrator is not registered/,
  ],
  [
    "orchestrator chain id",
    (s) => {
      s.contracts.OrchestratorV3.chainId = async () => ethers.BigNumber.from(1);
    },
    /Orchestrator chain id mismatch/,
  ],
  [
    "orchestrator payment registry",
    (s) => {
      s.contracts.OrchestratorV3.paymentVerifierRegistry = async () => OTHER;
    },
    /Payment registry target mismatch/,
  ],
  [
    "legacy writer",
    (s) => {
      s.contracts.NullifierRegistry.getWriters = async () => [OTHER];
    },
    /legacy nullifier writers remain/,
  ],
  [
    "paused orchestrator",
    (s) => {
      s.contracts.OrchestratorV3.paused = async () => true;
    },
    /Orchestrator is paused/,
  ],
  [
    "wrong chain",
    (s) => {
      s.provider.getNetwork = async () => ({ chainId: 1 });
    },
    /chain id mismatch/,
  ],
  [
    "UPV4 record address",
    (s) => {
      s.code.set(OTHER, s.records.UnifiedPaymentVerifierV4.deployedBytecode);
      s.records.UnifiedPaymentVerifierV4.address = OTHER;
    },
    /UnifiedPaymentVerifierV4 deployment address mismatch/,
  ],
  [
    "UPV4 runtime hash",
    (s) => {
      s.recorded.UnifiedPaymentVerifierV4.runtimeCodeHash =
        ethers.utils.keccak256("0x6001");
    },
    /UnifiedPaymentVerifierV4 runtime bytecode hash mismatch/,
  ],
  [
    "missing recorded pin with noncanonical record",
    () => {
      delete BYPASS_RECORDED_DEPLOYMENTS.base_staging;
    },
    /lacks canonical deployment evidence/,
  ],
];
for (const name of [
  "NullifierRegistryV2",
  "MultiAttestationVerifier",
  "OrchestratorV3",
  "OrchestratorRegistry",
  "PaymentVerifierRegistry",
]) {
  drifts.push(
    [
      `${name} record address`,
      (s) => {
        s.records[name].address = OTHER;
      },
      new RegExp(`${name} deployment address mismatch`),
    ],
    [
      `${name} runtime hash`,
      (s) => {
        s.code.set(s.records[name].address.toLowerCase(), "0x6001");
      },
      new RegExp(`${name} runtime bytecode hash mismatch`),
    ]
  );
}
for (const name of [
  "NullifierRegistryV2",
  "MultiAttestationVerifier",
  "OrchestratorV3",
  "PaymentVerifierRegistry",
  "NullifierRegistry",
]) {
  drifts.push([
    `${name} owner`,
    (s) => {
      s.contracts[name].owner = async () => OTHER;
    },
    new RegExp(`${name} owner mismatch`),
  ]);
}
for (const [name, mutate, message] of drifts) {
  test(`payment binding rejects ${name}`, async () => {
    await withFixture(async (state) => {
      mutate(state);
      await assert.rejects(
        verifyBypassPaymentBinding(state.hre, "base_staging"),
        message
      );
    });
  });
}
