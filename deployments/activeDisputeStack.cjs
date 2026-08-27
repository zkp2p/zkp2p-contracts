// @ts-check

const { createHash } = require("crypto");

/** @typedef {"StakeVault" | "DisputeProtectionPolicy" | "IntentLifecycleHookV1"} CanonicalName */
/** @typedef {"base" | "base_staging" | "localhost" | "hardhat"} DisputeNetwork */
/** @typedef {{ abi?: unknown[], address?: string, [key: string]: unknown }} DeploymentEntry */

/** @type {{ version: number, networks: Record<DisputeNetwork, Record<CanonicalName, string>> }} */
const manifest = require("./active-dispute-stack.json");

/** @type {CanonicalName[]} */
const CANONICAL_NAMES = [
  "StakeVault",
  "DisputeProtectionPolicy",
  "IntentLifecycleHookV1",
];
/** @type {Set<DisputeNetwork>} */
const SUPPORTED_NETWORKS = new Set(["base", "base_staging", "localhost", "hardhat"]);

function validateManifest() {
  if (manifest.version !== 1 || !manifest.networks || typeof manifest.networks !== "object") {
    throw new Error("Unsupported active dispute stack manifest");
  }

  for (const network of SUPPORTED_NETWORKS) {
    const selection = manifest.networks[network];
    if (!selection || typeof selection !== "object") {
      throw new Error(`Missing active dispute stack network ${network}`);
    }
    const keys = Object.keys(selection);
    if (
      keys.length !== CANONICAL_NAMES.length ||
      keys.some((name) => !CANONICAL_NAMES.includes(/** @type {CanonicalName} */ (name)))
    ) {
      throw new Error(`Unknown canonical dispute deployment in ${network}`);
    }
    const internalNames = CANONICAL_NAMES.map((name) => selection[name]);
    if (internalNames.some((name) => typeof name !== "string" || name.length === 0)) {
      throw new Error(`Invalid active dispute deployment name in ${network}`);
    }
    if (new Set(internalNames).size !== internalNames.length) {
      throw new Error(`Active dispute deployment is exposed more than once in ${network}`);
    }
  }
}

validateManifest();

/** @type {Set<string>} */
const SELECTED_INTERNAL_NAMES = new Set();
for (const selection of Object.values(manifest.networks)) {
  for (const canonicalName of CANONICAL_NAMES) {
    const internalName = selection[canonicalName];
    if (internalName !== canonicalName) SELECTED_INTERNAL_NAMES.add(internalName);
  }
}

/**
 * @param {string} network
 * @returns {DisputeNetwork}
 */
function normalizeDisputeNetworkName(network) {
  const normalized = network === "baseStaging" ? "base_staging" : network;
  if (!SUPPORTED_NETWORKS.has(/** @type {DisputeNetwork} */ (normalized))) {
    throw new Error(`Unsupported dispute stack network ${network}`);
  }
  return /** @type {DisputeNetwork} */ (normalized);
}

/**
 * @param {string} network
 * @param {string} canonicalName
 * @returns {string}
 */
function getActiveDisputeDeploymentName(network, canonicalName) {
  const normalized = normalizeDisputeNetworkName(network);
  if (!CANONICAL_NAMES.includes(/** @type {CanonicalName} */ (canonicalName))) {
    throw new Error(`Unknown canonical dispute deployment ${canonicalName}`);
  }
  return manifest.networks[normalized][/** @type {CanonicalName} */ (canonicalName)];
}

/**
 * @param {string} network
 * @returns {{ version: number, selectionHash: string }}
 */
function getActiveDisputeSelectionStamp(network) {
  const normalized = normalizeDisputeNetworkName(network);
  const selectionHash = createHash("sha256")
    .update(
      JSON.stringify({
        version: manifest.version,
        network: normalized,
        selection: manifest.networks[normalized],
      }),
      "utf8"
    )
    .digest("hex");
  return { version: manifest.version, selectionHash };
}

/**
 * @param {string} network
 * @param {{ version?: unknown, selectionHash?: unknown } | undefined} stamp
 * @returns {boolean}
 */
function hasCurrentDisputeSelectionStamp(network, stamp) {
  if (!stamp || typeof stamp !== "object") return false;
  const expected = getActiveDisputeSelectionStamp(network);
  return (
    stamp.version === expected.version &&
    stamp.selectionHash === expected.selectionHash &&
    Object.keys(stamp).length === 2
  );
}

/**
 * @param {unknown[] | undefined} left
 * @param {unknown[] | undefined} right
 * @returns {boolean}
 */
function sameAbi(left, right) {
  return JSON.stringify(left || []) === JSON.stringify(right || []);
}

/**
 * @param {string} network
 * @param {Record<string, DeploymentEntry>} contracts
 * @param {{ version?: unknown, selectionHash?: unknown } | undefined} [selectionStamp]
 * @returns {Record<string, DeploymentEntry>}
 */
function resolveActiveDisputeAliases(network, contracts, selectionStamp) {
  const stampedCanonicalOutput = hasCurrentDisputeSelectionStamp(
    network,
    selectionStamp
  );
  if (selectionStamp !== undefined && !stampedCanonicalOutput) {
    throw new Error("Canonical dispute deployment selection stamp mismatch");
  }
  const resolved = { ...contracts };

  for (const canonicalName of CANONICAL_NAMES) {
    const internalName = getActiveDisputeDeploymentName(network, canonicalName);
    const selected =
      contracts[internalName] ||
      (stampedCanonicalOutput && internalName !== canonicalName
        ? contracts[canonicalName]
        : undefined);
    if (!selected) {
      throw new Error(`Missing active dispute deployment ${internalName}`);
    }
    const existingPublic = contracts[canonicalName];
    if (internalName !== canonicalName && existingPublic && !sameAbi(existingPublic.abi, selected.abi)) {
      throw new Error(`Active dispute deployment ABI mismatch for ${canonicalName}`);
    }
    resolved[canonicalName] = selected;
  }

  for (const name of Object.keys(resolved)) {
    if (name.endsWith("OptIn") || SELECTED_INTERNAL_NAMES.has(name)) delete resolved[name];
  }
  return resolved;
}

module.exports = {
  getActiveDisputeDeploymentName,
  getActiveDisputeSelectionStamp,
  normalizeDisputeNetworkName,
  resolveActiveDisputeAliases,
};
