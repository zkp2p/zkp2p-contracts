require('ts-node/register/transpile-only');

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { Wallet } = require('ethers');
const { getDeployerAccounts, RETIRED_DEPLOYERS } = require('../utils/deployerKeys.ts');

// Evaluate the actual config without registering Hardhat plugins or reading .env.
function config(env, retiredDeployers = RETIRED_DEPLOYERS) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hardhat.config.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const requireStub = (name) => name === './utils/deployerKeys'
    ? { getDeployerAccounts: (env) => getDeployerAccounts(env, retiredDeployers) }
    : { config() {} };
  requireStub.extensions = {};
  vm.runInNewContext(output, { exports, require: requireStub, process: { env } });
  return exports.default;
}

test('Base staging never falls back to the production signer', () => {
  const production = '11'.repeat(32);
  const result = config({ BASE_DEPLOYER_KEY: production });
  assert.equal(result.networks.base_staging.accounts.length, 0);
  assert.equal(result.networks.base.accounts[0], `0x${production}`);
});

test('Base staging accepts only its scoped setting, with or without a prefix', () => {
  const staging = '22'.repeat(32);
  for (const key of [staging, `0x${staging}`]) {
    const result = config({ BASE_DEPLOYER_KEY: '11'.repeat(32), STAGING_DEPLOYER_KEY: key });
    assert.equal(result.networks.base_staging.accounts.length, 1);
    assert.equal(result.networks.base_staging.accounts[0], `0x${staging}`);
    assert.equal(result.networks.base.accounts[0], `0x${'11'.repeat(32)}`);
  }
});

test('release Hardhat configs load from a clean directory without remote signing keys', () => {
  const root = path.resolve(__dirname, '..');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'o4-keyless-'));
  try {
    const env = {
      PATH: process.env.PATH,
      TS_NODE_PROJECT: path.join(root, 'tsconfig.json'),
      HARDHAT_NETWORK: 'base_staging',
      ALCHEMY_API_KEY: 'read-only-test',
    };
    const args = ['-r', require.resolve('ts-node/register/transpile-only'), '-e',
      `const h=require(${JSON.stringify(require.resolve('hardhat'))});process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(h.config.networks).map(([n,c])=>[n,c.accounts]))))`];
    const original = spawnSync(process.execPath, args, {
      cwd: directory, env: { ...env, HARDHAT_CONFIG: path.join(root, 'hardhat.config.ts') }, encoding: 'utf8',
    });
    assert.equal(original.status, 0, original.stderr);
    const originalAccounts = JSON.parse(original.stdout);
    for (const network of ['base_staging', 'goerli', 'base']) {
      assert.deepEqual(originalAccounts[network], []);
    }
    for (const configName of ['hardhat.readonly.config.ts', 'hardhat.canonical.config.ts']) {
      const readonly = spawnSync(process.execPath, args, {
        cwd: directory, env: { ...env, HARDHAT_CONFIG: path.join(root, configName) }, encoding: 'utf8',
      });
      assert.equal(readonly.status, 0, readonly.stderr);
      for (const [network, accounts] of Object.entries(JSON.parse(readonly.stdout))) {
        if (configName === 'hardhat.canonical.config.ts' && network === 'hardhat') continue;
        assert.deepEqual(accounts, []);
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('Base accepts its scoped setting with or without a prefix and preserves vanity account order', () => {
  const production = '11'.repeat(32);
  const escrow = '33'.repeat(32);
  const orchestrator = '44'.repeat(32);
  for (const key of [production, `0x${production}`]) {
    const prefix = key.startsWith('0x') ? '0x' : '';
    const result = config({
      BASE_DEPLOYER_KEY: key,
      VANITY_ESCROW_V2_PROD_PRIVATE_KEY: `${prefix}${escrow}`,
      VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY: `${prefix}${orchestrator}`,
    });
    assert.deepEqual(Array.from(result.networks.base.accounts), [
      `0x${production}`, `0x${escrow}`, `0x${orchestrator}`,
    ]);
  }
});

test('Base skips absent vanity keys without changing the deployer', () => {
  const production = '11'.repeat(32);
  const vanity = '33'.repeat(32);
  for (const envVar of ['VANITY_ESCROW_V2_PROD_PRIVATE_KEY', 'VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY']) {
    const result = config({ BASE_DEPLOYER_KEY: production, [envVar]: vanity });
    assert.deepEqual(Array.from(result.networks.base.accounts), [`0x${production}`, `0x${vanity}`]);
  }
});

test('Goerli normalizes its key prefix and has no accounts when unset or empty', () => {
  const testnet = '55'.repeat(32);
  for (const key of [testnet, `0x${testnet}`, undefined, '']) {
    const result = config({ TESTNET_DEPLOY_PRIVATE_KEY: key });
    assert.deepEqual(Array.from(result.networks.goerli.accounts), key ? [`0x${testnet}`] : []);
  }
});

test('Base has no deployer when its setting is unset or empty, even with a staging key', () => {
  for (const key of [undefined, '']) {
    const result = config({ BASE_DEPLOYER_KEY: key, STAGING_DEPLOYER_KEY: '22'.repeat(32) });
    assert.equal(result.networks.base.accounts.length, 0);
    const withVanity = config({
      BASE_DEPLOYER_KEY: key,
      VANITY_ESCROW_V2_PROD_PRIVATE_KEY: '33'.repeat(32),
      VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY: '44'.repeat(32),
    });
    assert.deepEqual(Array.from(withVanity.networks.base.accounts), []);
  }
});

test('the legacy production variable is rejected without inspecting or exposing its value', () => {
  for (const legacy of ['11'.repeat(32), 'not-a-private-key', ' ', '']) {
    assert.throws(
      () => config({ BASE_DEPLOY_PRIVATE_KEY: legacy, BASE_DEPLOYER_KEY: '22'.repeat(32) }),
      { message: 'BASE_DEPLOY_PRIVATE_KEY is retired; delete it and use BASE_DEPLOYER_KEY' }
    );
  }
});

const deployerKeyVariables = [
  'BASE_DEPLOYER_KEY',
  'STAGING_DEPLOYER_KEY',
  'VANITY_ESCROW_V2_PROD_PRIVATE_KEY',
  'VANITY_ORCHESTRATOR_V2_PROD_PRIVATE_KEY',
  'TESTNET_DEPLOY_PRIVATE_KEY',
];

test('every configured key rejects a retired signer even when excluded from the account list', () => {
  const key = '11'.repeat(32);
  const address = new Wallet(`0x${key}`).address;
  for (const envVar of deployerKeyVariables) {
    for (const privateKey of [key, `0x${key}`]) {
      for (const retired of [address.toLowerCase(), address.toUpperCase()]) {
        for (const baseKey of [undefined, '', '22'.repeat(32)]) {
          assert.throws(
            () => config({ BASE_DEPLOYER_KEY: baseKey, [envVar]: privateKey }, [retired]),
            { message: `${envVar} signer is retired` }
          );
        }
      }
    }
  }
});

test('invalid deployer keys fail without exposing their value', () => {
  for (const envVar of deployerKeyVariables) {
    for (const baseKey of [undefined, '', '22'.repeat(32)]) {
      assert.throws(
        () => config({ BASE_DEPLOYER_KEY: baseKey, [envVar]: 'not-a-private-key' }),
        { message: `${envVar} private key is invalid` }
      );
    }
  }
});

test('the compromised production signer remains retired', () => {
  assert.ok(RETIRED_DEPLOYERS.includes('0x84e113087C97Cd80eA9D78983D4B8Ff61ECa1929'));
});
