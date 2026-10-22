const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const ts = require('typescript');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

// Evaluate the actual config without registering Hardhat plugins or reading .env.
function config(env) {
  const source = fs.readFileSync(path.join(__dirname, '..', 'hardhat.config.ts'), 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  const requireStub = () => ({ config() {} });
  requireStub.extensions = {};
  vm.runInNewContext(output, { exports, require: requireStub, process: { env } });
  return exports.default;
}

test('Base staging never falls back to the production signer', () => {
  const production = '11'.repeat(32);
  const result = config({ BASE_DEPLOY_PRIVATE_KEY: production });
  assert.equal(result.networks.base_staging.accounts.length, 0);
  assert.equal(result.networks.base.accounts[0], `0x${production}`);
});

test('Base staging accepts only its scoped setting, with or without a prefix', () => {
  const staging = '22'.repeat(32);
  for (const key of [staging, `0x${staging}`]) {
    const result = config({ BASE_DEPLOY_PRIVATE_KEY: '11'.repeat(32), STAGING_DEPLOYER_KEY: key });
    assert.equal(result.networks.base_staging.accounts.length, 1);
    assert.equal(result.networks.base_staging.accounts[0], `0x${staging}`);
    assert.equal(result.networks.base.accounts[0], `0x${'11'.repeat(32)}`);
  }
});

test('read-only Hardhat loads from a clean directory without any network signing key', () => {
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
    assert.notEqual(original.status, 0);
    assert.match(original.stderr, /Invalid account: #0 for network: (goerli|base)/);
    const readonly = spawnSync(process.execPath, args, {
      cwd: directory, env: { ...env, HARDHAT_CONFIG: path.join(root, 'hardhat.readonly.config.ts') }, encoding: 'utf8',
    });
    assert.equal(readonly.status, 0, readonly.stderr);
    for (const accounts of Object.values(JSON.parse(readonly.stdout))) assert.deepEqual(accounts, []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
