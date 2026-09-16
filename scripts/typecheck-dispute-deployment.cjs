#!/usr/bin/env node

require("ts-node/register/transpile-only");
const { resolve } = require("node:path");
const ts = require("typescript");
const {
  IMMUTABLE_DEPLOYMENT_LANES,
  assertImmutableDeploymentLanes,
} = require("../deployments/immutableDeploymentLanes.ts");

// Executed lanes are frozen source, checked by digest and historical-artifact
// rehearsals. Their old ABI calls must not be typed against today's TypeChain.
const root = resolve(__dirname, "..");
assertImmutableDeploymentLanes(root);
const historicalFiles = new Set(
  Object.keys(IMMUTABLE_DEPLOYMENT_LANES).map((file) => resolve(root, "deploy", file))
);
const configPath = resolve(root, "tsconfig.dispute-deployment.json");
const read = ts.readConfigFile(configPath, ts.sys.readFile);
const config = ts.parseJsonConfigFileContent(read.config, ts.sys, root);
const program = ts.createProgram(config.fileNames, config.options);
const diagnostics = [
  ...(read.error ? [read.error] : []),
  ...config.errors,
  ...ts.getPreEmitDiagnostics(program).filter(
    (diagnostic) => !diagnostic.file || !historicalFiles.has(resolve(diagnostic.file.fileName))
  ),
];
if (diagnostics.length) {
  process.stderr.write(ts.formatDiagnosticsWithColorAndContext(diagnostics, {
    getCanonicalFileName: (file) => file,
    getCurrentDirectory: () => root,
    getNewLine: () => "\n",
  }));
  process.exitCode = 1;
} else {
  console.log("Current dispute deployment types and immutable source hashes verified.");
}
