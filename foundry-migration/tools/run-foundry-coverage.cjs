#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "../..");
const coverageDirectory = path.join(repositoryRoot, "coverage");
const shardDirectory = path.join(coverageDirectory, "shards");
const baselinePath = path.join(
    repositoryRoot,
    "foundry-migration/baseline/hardhat-coverage-summary.json"
);
const manifestPath = path.join(repositoryRoot, "foundry-migration/hardhat-to-foundry-manifest.csv");
const inventoryPath = path.join(
    repositoryRoot,
    "foundry-migration/baseline/hardhat-inventory.json"
);
const upstreamDeltaPath = path.join(repositoryRoot, "foundry-migration/UPSTREAM_DELTA.md");
const exceptionsPath = path.join(repositoryRoot, "foundry-migration/coverage-exceptions.json");
const parityBridgeName = "parity-bridge-ir";
const mergeOnly = process.argv.includes("--merge-only");
const resume = process.argv.includes("--resume");
const groupArgumentIndex = process.argv.indexOf("--group");
const runGroup = groupArgumentIndex === -1 ? null : process.argv[groupArgumentIndex + 1];
const validRunGroups = new Set(["deterministic", "parity-main", "parity-collisions"]);
const coverageSeed = "0x0000000000000000000000000000000000000000000000000000000000000001";
const deterministicTestRoot = "test-foundry/deterministic";
const excludedProductionDirectories = new Set([
    "contracts/external",
    "contracts/interfaces",
    "contracts/mocks",
]);

const legacyOrchestratorTests = [
    "OrchestratorCancelParity.t.sol",
    "OrchestratorFulfillAccountingParity.t.sol",
    "OrchestratorFulfillCoreParity.t.sol",
    "OrchestratorFulfillHookParity.t.sol",
    "OrchestratorFulfillPartialReentryParity.t.sol",
    "OrchestratorGovernanceParity.t.sol",
    "OrchestratorManualReleaseParity.t.sol",
    "OrchestratorPruneParity.t.sol",
    "OrchestratorSignalParity.t.sol",
    "OrchestratorViewsParity.t.sol",
].map((file) => `test-foundry/deterministic/orchestrator/${file}`);

const coverageRuns = [
    {
        name: "full-ir",
        irMinimum: true,
        test: deterministicTestRoot,
    },
    {
        name: "registries",
        source: "contracts/registries",
        test: "test-foundry/deterministic/registries",
    },
    {
        name: "oracles",
        source: "contracts/oracles",
        test: "test-foundry/deterministic/oracles",
    },
    {
        name: "escrows",
        source: "contracts/Escrow.sol",
        test: "test-foundry/deterministic/escrow",
    },
    {
        name: "unified-verifiers",
        source: "contracts/unifiedVerifier",
        test: "test-foundry/deterministic/verifiers",
    },
    {
        name: "protocol-viewer",
        source: "contracts/ProtocolViewer.sol",
        test: "test-foundry/deterministic/periphery/ProtocolViewerParity.t.sol",
    },
    {
        name: "risk-libraries",
        source: "contracts/lib/BoundedCall.sol",
        test: "test-foundry/deterministic/libs",
    },
    ...legacyOrchestratorTests.map((test, index) => ({
        name: `legacy-orchestrator-${index}`,
        source: "contracts/Orchestrator.sol",
        test,
    })),
];

function fail(message) {
    console.error(message);
    process.exit(1);
}

if (groupArgumentIndex !== -1 && !validRunGroups.has(runGroup)) {
    fail(`--group must be one of: ${[...validRunGroups].join(", ")}`);
}
if (mergeOnly && runGroup) fail("--merge-only and --group cannot be combined");
if (resume && runGroup) fail("--resume is supported only by the sequential local workflow");

function parseCsv(input) {
    const rows = [];
    let row = [];
    let field = "";
    let quoted = false;
    for (let index = 0; index < input.length; ++index) {
        const character = input[index];
        if (quoted) {
            if (character === '"' && input[index + 1] === '"') {
                field += '"';
                ++index;
            } else if (character === '"') {
                quoted = false;
            } else {
                field += character;
            }
        } else if (character === '"') {
            quoted = true;
        } else if (character === ",") {
            row.push(field);
            field = "";
        } else if (character === "\n") {
            row.push(field.replace(/\r$/, ""));
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += character;
        }
    }
    if (quoted) fail("manifest ends inside a quoted field");
    if (field.length || row.length) {
        row.push(field.replace(/\r$/, ""));
        rows.push(row);
    }
    const [header, ...values] = rows;
    return values.map((cells, rowIndex) => {
        if (cells.length !== header.length) {
            fail(`manifest row ${rowIndex + 2} has ${cells.length} columns; expected ${header.length}`);
        }
        return Object.fromEntries(header.map((name, columnIndex) => [name, cells[columnIndex]]));
    });
}

function listLiveFoundryTests(filterArgs = []) {
    const result = spawnSync("forge", ["test", ...filterArgs, "--list", "--json"], {
        cwd: repositoryRoot,
        env: { ...process.env, FOUNDRY_TEST: deterministicTestRoot },
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) fail("could not enumerate live Foundry tests");
    const liveTests = new Set();
    for (const [file, contracts] of Object.entries(JSON.parse(result.stdout))) {
        for (const [contractName, tests] of Object.entries(contracts)) {
            for (const testName of tests) liveTests.add(`${file}:${contractName}::${testName}`);
        }
    }
    return liveTests;
}

function exactTestNamePattern(testNames) {
    // Forge filters parameterized tests by their canonical signature even though
    // `forge test --list --json` reports only the bare function name.
    return `^(${[...testNames].join("|")})(\\(.*\\))?$`;
}

function loadParityDestinations() {
    const liveTests = listLiveFoundryTests();
    const manifest = parseCsv(fs.readFileSync(manifestPath, "utf8"));
    const inventory = JSON.parse(fs.readFileSync(inventoryPath, "utf8"));
    if (manifest.length !== 1517 || inventory.tests.length !== 1517) {
        fail(`unexpected immutable baseline cardinality: ${manifest.length} / ${inventory.tests.length}`);
    }
    const pendingIds = new Set(inventory.tests.filter((test) => test.pending).map((test) => test.id));
    if (pendingIds.size !== 5) fail(`unexpected starting pending count: ${pendingIds.size}`);
    const parityDestinations = new Set(
        manifest.filter((row) => !pendingIds.has(row.id)).map((row) => row.foundry_destination)
    );

    const destinationsByContractAndTest = new Map();
    for (const destination of liveTests) {
        const match = destination.match(/:([^:]+)::([^:]+)$/);
        const key = `${match[1]}.${match[2]}`;
        const candidates = destinationsByContractAndTest.get(key) || [];
        candidates.push(destination);
        destinationsByContractAndTest.set(key, candidates);
    }
    const upstreamDelta = fs.readFileSync(upstreamDeltaPath, "utf8");
    const deltaKeys = [...upstreamDelta.matchAll(/`([A-Za-z0-9_]+\.(?:test_[A-Za-z0-9_]+))`/g)].map(
        (match) => match[1]
    );
    if (deltaKeys.length !== 67 || new Set(deltaKeys).size !== 67) {
        fail(`unexpected upstream parity-delta cardinality: ${deltaKeys.length} / ${new Set(deltaKeys).size}`);
    }
    for (const key of deltaKeys) {
        const candidates = destinationsByContractAndTest.get(key) || [];
        if (candidates.length !== 1) {
            fail(`upstream parity destination ${key} resolves to ${candidates.length} live tests`);
        }
    }
    for (const destination of parityDestinations) {
        if (!liveTests.has(destination)) fail(`parity destination is not live: ${destination}`);
    }

    // Partition the exact starting set into one inverse-name run plus one collision
    // recovery run scoped to the affected contracts. This avoids the cross-contract
    // name collisions exposed by Forge's global test-name selector.
    const additiveTests = [...liveTests].filter((destination) => !parityDestinations.has(destination));
    const additiveTestNames = new Set(
        additiveTests.map((destination) => destination.split("::")[1])
    );
    const mainDestinations = [...liveTests].filter(
        (destination) => !additiveTestNames.has(destination.split("::")[1])
    );
    const collisionParityDestinations = [...parityDestinations].filter((destination) =>
        additiveTestNames.has(destination.split("::")[1])
    );
    const collisionContracts = new Set(
        collisionParityDestinations.map((destination) => destination.match(/:([^:]+)::/)[1])
    );
    const collisionNames = new Set(
        collisionParityDestinations.map((destination) => destination.split("::")[1])
    );
    const collisionDestinations = [...liveTests].filter((destination) => {
        const contractName = destination.match(/:([^:]+)::/)[1];
        const testName = destination.split("::")[1];
        return collisionContracts.has(contractName) && collisionNames.has(testName);
    });
    const selectedLiveTests = new Set([...mainDestinations, ...collisionDestinations]);
    const missingParityDestinations = [...parityDestinations].filter(
        (destination) => !selectedLiveTests.has(destination)
    );
    if (missingParityDestinations.length > 0 || parityDestinations.size === 0) {
        fail(`starting bridge misses mapped tests:\n${missingParityDestinations.join("\n")}`);
    }
    const conservativeAdditions = [...selectedLiveTests].filter(
        (destination) => !parityDestinations.has(destination)
    );
    const mainPattern = exactTestNamePattern(additiveTestNames);
    const collisionPattern = exactTestNamePattern(collisionNames);
    const actualMainDestinations = listLiveFoundryTests(["--no-match-test", mainPattern]);
    const actualCollisionDestinations = listLiveFoundryTests([
        "--match-contract",
        `^(${[...collisionContracts].join("|")})$`,
        "--match-test",
        collisionPattern,
    ]);
    const actualSelectedDestinations = new Set([
        ...actualMainDestinations,
        ...actualCollisionDestinations,
    ]);
    const selectorMissing = [...selectedLiveTests].filter(
        (destination) => !actualSelectedDestinations.has(destination)
    );
    const selectorUnexpected = [...actualSelectedDestinations].filter(
        (destination) => !selectedLiveTests.has(destination)
    );
    if (selectorMissing.length > 0 || selectorUnexpected.length > 0) {
        fail(
            `parity bridge selectors do not match the intended test set:\nmissing:\n${selectorMissing.join("\n") || "none"}\nunexpected:\n${selectorUnexpected.join("\n") || "none"}`
        );
    }
    return {
        manifestRows: manifest.length,
        startingExecutableRows: manifest.length - pendingIds.size,
        startingPendingRowsExcluded: pendingIds.size,
        originalDestinations: parityDestinations.size,
        upstreamDeltaDestinations: deltaKeys.length,
        exactParityDestinations: [...parityDestinations].sort(),
        conservativeAdditions: conservativeAdditions.sort(),
        additiveTestNames: [...additiveTestNames].sort(),
        mainDestinations: mainDestinations.sort(),
        collisionContracts: [...collisionContracts].sort(),
        collisionNames: [...collisionNames].sort(),
        collisionDestinations: collisionDestinations.sort(),
        mainSelectorCount: actualMainDestinations.size,
        collisionSelectorCount: actualCollisionDestinations.size,
        destinations: [...selectedLiveTests].sort(),
    };
}

function runCoverage(run) {
    const reportPath = path.join(shardDirectory, `${run.name}.lcov`);
    const logPath = path.join(shardDirectory, `${run.name}.log`);
    const args = [
        "coverage",
        "--fuzz-seed",
        coverageSeed,
        "--report",
        "lcov",
        "--report",
        "summary",
        "--report-file",
        reportPath,
    ];
    if (run.irMinimum) args.push("--ir-minimum");
    if (run.matchTest) args.push("--match-test", run.matchTest);
    if (run.noMatchTest) args.push("--no-match-test", run.noMatchTest);
    if (run.matchContract) args.push("--match-contract", run.matchContract);

    const environment = { ...process.env };
    if (run.source) environment.FOUNDRY_SRC = run.source;
    if (run.test) environment.FOUNDRY_TEST = run.test;

    const startedAt = process.hrtime.bigint();
    console.log(`coverage: ${run.name}`);
    const result = spawnSync("forge", args, {
        cwd: repositoryRoot,
        env: environment,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
    });
    const elapsedSeconds = Number(process.hrtime.bigint() - startedAt) / 1e9;
    const output = `${result.stdout || ""}${result.stderr || ""}`;
    fs.writeFileSync(logPath, output);
    if (result.error || result.status !== 0) {
        const diagnosticLimit = 64 * 1024;
        const diagnostic = output.length > diagnosticLimit
            ? `... coverage output truncated to final ${diagnosticLimit} bytes ...\n${output.slice(-diagnosticLimit)}`
            : output;
        process.stderr.write(diagnostic);
        fail(
            `coverage shard ${run.name} failed after ${elapsedSeconds.toFixed(2)}s (status=${result.status}, signal=${result.signal || "none"}, error=${result.error?.message || "none"})`
        );
    }
    console.log(`coverage: ${run.name} passed in ${elapsedSeconds.toFixed(2)}s`);
    return { name: run.name, elapsedSeconds };
}

function writeJson(file, value) {
    fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function persistGroupResult(group, runTimings, parityEvidence) {
    fs.mkdirSync(coverageDirectory, { recursive: true });
    writeJson(path.join(coverageDirectory, `run-timings-${group}.json`), runTimings);
    if (parityEvidence) {
        writeJson(
            path.join(coverageDirectory, `parity-evidence-${group}.json`),
            parityEvidence
        );
    }
}

function loadPersistedRunTimings() {
    const sequentialPath = path.join(coverageDirectory, "run-timings-sequential.json");
    if (fs.existsSync(sequentialPath)) return JSON.parse(fs.readFileSync(sequentialPath, "utf8"));

    const paths = [...validRunGroups].map((group) =>
        path.join(coverageDirectory, `run-timings-${group}.json`)
    );
    for (const file of paths) {
        if (!fs.existsSync(file)) fail(`missing coverage timing input ${path.relative(repositoryRoot, file)}`);
    }
    return paths.flatMap((file) => JSON.parse(fs.readFileSync(file, "utf8")));
}

function loadPersistedParityEvidence() {
    const sequentialPath = path.join(coverageDirectory, "parity-evidence-sequential.json");
    if (fs.existsSync(sequentialPath)) {
        return JSON.parse(fs.readFileSync(sequentialPath, "utf8"));
    }

    const mainPath = path.join(coverageDirectory, "parity-evidence-parity-main.json");
    const collisionPath = path.join(
        coverageDirectory,
        "parity-evidence-parity-collisions.json"
    );
    for (const file of [mainPath, collisionPath]) {
        if (!fs.existsSync(file)) fail(`missing parity evidence ${path.relative(repositoryRoot, file)}`);
    }
    const main = JSON.parse(fs.readFileSync(mainPath, "utf8"));
    const collisions = JSON.parse(fs.readFileSync(collisionPath, "utf8"));
    if (JSON.stringify(main) !== JSON.stringify(collisions)) {
        fail("parallel parity producers disagreed on the live test selection");
    }
    return main;
}

function normalizeSource(source) {
    const normalized = source.replaceAll("\\", "/");
    const root = repositoryRoot.replaceAll("\\", "/");
    return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function discoverProductionFiles() {
    const productionFiles = [];
    function walk(directory) {
        for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
            const absolutePath = path.join(directory, entry.name);
            const source = normalizeSource(absolutePath);
            if (entry.isDirectory()) {
                if (!excludedProductionDirectories.has(source)) walk(absolutePath);
            } else if (entry.isFile() && entry.name.endsWith(".sol")) {
                productionFiles.push(source);
            }
        }
    }
    walk(path.join(repositoryRoot, "contracts"));
    return productionFiles.sort();
}

function parseLcov(contents) {
    const records = new Map();
    for (const block of contents.split("end_of_record")) {
        const sourceMatch = block.match(/^SF:(.+)$/m);
        if (!sourceMatch) continue;
        const source = normalizeSource(sourceMatch[1].trim());
        const lines = new Map();
        const branches = new Map();
        const functions = new Map();
        const functionDefinitions = [];

        for (const match of block.matchAll(/^DA:(\d+),(\d+)(.*)$/gm)) {
            lines.set(match[1], { hits: Number(match[2]), suffix: match[3] });
        }
        for (const match of block.matchAll(/^BRDA:(\d+),([^,]+),([^,]+),([^\r\n]+)$/gm)) {
            const key = `${match[1]},${match[2]},${match[3]}`;
            branches.set(key, match[4] === "-" ? 0 : Number(match[4]));
        }
        for (const match of block.matchAll(/^FN:(\d+),(.+)$/gm)) {
            functionDefinitions.push({ line: match[1], name: match[2] });
        }
        for (const match of block.matchAll(/^FNDA:(\d+),(.+)$/gm)) {
            functions.set(match[2], Number(match[1]));
        }
        const existing = records.get(source);
        if (!existing) {
            records.set(source, { source, lines, branches, functions, functionDefinitions });
            continue;
        }

        // Forge can emit more than one LCOV record for the same production source when
        // it is compiled into independently linked test topologies. LCOV defines those
        // records cumulatively; retaining only the last record can turn executed lines
        // into false misses. Merge duplicate records by anchor and retain the maximum
        // hit count observed in any linked topology.
        for (const [line, entry] of lines) {
            const prior = existing.lines.get(line);
            if (!prior || entry.hits > prior.hits) existing.lines.set(line, entry);
        }
        for (const [branch, hits] of branches) {
            existing.branches.set(branch, Math.max(existing.branches.get(branch) || 0, hits));
        }
        for (const [name, hits] of functions) {
            existing.functions.set(name, Math.max(existing.functions.get(name) || 0, hits));
        }
        const knownDefinitions = new Set(
            existing.functionDefinitions.map((definition) => `${definition.line}:${definition.name}`)
        );
        for (const definition of functionDefinitions) {
            const key = `${definition.line}:${definition.name}`;
            if (!knownDefinitions.has(key)) {
                existing.functionDefinitions.push(definition);
                knownDefinitions.add(key);
            }
        }
    }
    return records;
}

function mergeLcov(baseRecords, shardRecords, productionFiles) {
    for (const records of shardRecords) {
        for (const source of productionFiles) {
            const base = baseRecords.get(source);
            const shard = records.get(source);
            if (!shard) continue;
            for (const [line, entry] of base.lines) {
                const candidate = shard.lines.get(line);
                if (candidate) entry.hits = Math.max(entry.hits, candidate.hits);
            }
            for (const [branch, hits] of base.branches) {
                if (shard.branches.has(branch)) {
                    base.branches.set(branch, Math.max(hits, shard.branches.get(branch)));
                }
            }
            for (const [name, hits] of base.functions) {
                if (shard.functions.has(name)) {
                    base.functions.set(name, Math.max(hits, shard.functions.get(name)));
                }
            }
        }
    }
}

function renderLcov(records, productionFiles) {
    const blocks = [];
    for (const source of productionFiles) {
        const record = records.get(source);
        const lines = ["TN:", `SF:${source}`];
        for (const definition of record.functionDefinitions) {
            lines.push(`FN:${definition.line},${definition.name}`);
        }
        for (const [name, hits] of record.functions) lines.push(`FNDA:${hits},${name}`);
        lines.push(`FNF:${record.functions.size}`);
        lines.push(`FNH:${[...record.functions.values()].filter((hits) => hits > 0).length}`);
        for (const [key, hits] of record.branches) lines.push(`BRDA:${key},${hits}`);
        lines.push(`BRF:${record.branches.size}`);
        lines.push(`BRH:${[...record.branches.values()].filter((hits) => hits > 0).length}`);
        for (const [line, entry] of record.lines) lines.push(`DA:${line},${entry.hits}${entry.suffix}`);
        lines.push(`LF:${record.lines.size}`);
        lines.push(`LH:${[...record.lines.values()].filter((entry) => entry.hits > 0).length}`);
        lines.push("end_of_record");
        blocks.push(lines.join("\n"));
    }
    return `${blocks.join("\n")}\n`;
}

function parseMetric(cell) {
    const match = cell.match(/\((\d+)\/(\d+)\)/);
    if (!match) return null;
    return { covered: Number(match[1]), total: Number(match[2]) };
}

function parseSummary(contents) {
    const result = new Map();
    for (const line of contents.split(/\r?\n/)) {
        if (!line.startsWith("|")) continue;
        const fields = line.split("|").map((field) => field.trim());
        if (!fields[1]?.startsWith("contracts/")) continue;
        const metrics = {
            lines: parseMetric(fields[2]),
            statements: parseMetric(fields[3]),
            branches: parseMetric(fields[4]),
            functions: parseMetric(fields[5]),
        };
        if (Object.values(metrics).some((metric) => metric === null)) continue;
        result.set(normalizeSource(fields[1]), metrics);
    }
    return result;
}

function ratio(metric) {
    return metric.total === 0 ? 1 : metric.covered / metric.total;
}

function percentage(metric) {
    return Number((ratio(metric) * 100).toFixed(2));
}

function metricFromValues(values) {
    return {
        covered: values.filter((hits) => hits > 0).length,
        total: values.length,
    };
}

function mergeStatements(summaryReports, productionFiles) {
    const statements = new Map();
    for (const source of productionFiles) {
        const candidates = summaryReports.map((report) => report.get(source)).filter(Boolean);
        if (candidates.length === 0) fail(`missing summary metrics for ${source}`);
        const totals = new Set(candidates.map((metrics) => metrics.statements.total));
        if (totals.size !== 1) {
            fail(`statement denominator changed across coverage configurations for ${source}`);
        }
        statements.set(source, {
            covered: Math.max(...candidates.map((metrics) => metrics.statements.covered)),
            total: candidates[0].statements.total,
        });
    }
    return statements;
}

function sumMetrics(metrics) {
    return [...metrics.values()].reduce(
        (total, metric) => ({ covered: total.covered + metric.covered, total: total.total + metric.total }),
        { covered: 0, total: 0 }
    );
}

function coverageMetrics(records, statementMetrics, productionFiles) {
    const files = productionFiles.map((source) => {
        const record = records.get(source);
        if (!record) fail(`missing coverage record for ${source}`);
        const metrics = {
            file: source,
            lines: metricFromValues([...record.lines.values()].map((entry) => entry.hits)),
            statements: statementMetrics.get(source),
            branches: metricFromValues([...record.branches.values()]),
            functions: metricFromValues([...record.functions.values()]),
        };
        for (const metric of ["lines", "statements", "branches", "functions"]) {
            metrics[metric].pct = percentage(metrics[metric]);
        }
        return metrics;
    });
    const overall = {};
    for (const metric of ["lines", "statements", "branches", "functions"]) {
        overall[metric] = sumMetrics(new Map(files.map((file) => [file.file, file[metric]])));
        overall[metric].pct = percentage(overall[metric]);
    }
    return { files, overall };
}

function checkCoverage(summary, exceptions) {
    const failures = [];
    const bridgeFiles = new Map(summary.parityBridge.files.map((file) => [file.file, file]));
    for (const metric of ["lines", "branches"]) {
        if (summary.completeFullIr.overall[metric].total !== summary.parityBridge.overall[metric].total) {
            failures.push(`overall ${metric} denominator differs across the Foundry parity bridge`);
        } else if (ratio(summary.completeFullIr.overall[metric]) <= ratio(summary.parityBridge.overall[metric])) {
            failures.push(
                `overall ${metric} must strictly improve from the starting-behavior bridge: ${percentage(summary.completeFullIr.overall[metric])}% <= ${percentage(summary.parityBridge.overall[metric])}%`
            );
        }
    }
    for (const metric of ["statements", "functions"]) {
        if (summary.completeFullIr.overall[metric].total !== summary.parityBridge.overall[metric].total) {
            failures.push(`overall ${metric} denominator differs across the Foundry parity bridge`);
        } else if (ratio(summary.completeFullIr.overall[metric]) < ratio(summary.parityBridge.overall[metric])) {
            failures.push(
                `overall ${metric} regressed from the starting-behavior bridge: ${percentage(summary.completeFullIr.overall[metric])}% < ${percentage(summary.parityBridge.overall[metric])}%`
            );
        }
    }

    for (const current of summary.completeFullIr.files) {
        const bridge = bridgeFiles.get(current.file);
        if (!bridge) {
            failures.push(`missing parity-bridge production coverage file ${current.file}`);
            continue;
        }
        for (const metric of ["lines", "statements", "branches", "functions"]) {
            const key = `${current.file}:${metric}`;
            if (current[metric].total !== bridge[metric].total) {
                failures.push(`per-file denominator differs across the Foundry parity bridge: ${key}`);
            } else if (ratio(current[metric]) < ratio(bridge[metric])) {
                failures.push(
                    `per-file coverage regressed from the starting-behavior bridge ${key}: ${percentage(current[metric])}% < ${percentage(bridge[metric])}%`
                );
            }
        }
    }

    const currentFiles = new Map(summary.files.map((file) => [file.file, file]));
    for (const exception of exceptions) {
        const key = `${exception.file}:${exception.metric}`;
        if (typeof exception.reason !== "string" || exception.reason.length < 40) {
            failures.push(`coverage exception ${key} lacks a specific technical justification`);
        }
        const current = currentFiles.get(exception.file)?.[exception.metric];
        if (!current) failures.push(`coverage exception ${key} does not identify a current metric`);
        else if (current.covered === current.total) failures.push(`coverage exception ${key} is stale or unnecessary`);
    }
    if (failures.length > 0) fail(`Foundry coverage gate failed:\n- ${failures.join("\n- ")}`);
}

function mergeAndCheck(runTimings, parityEvidence) {
    const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const productionFiles = discoverProductionFiles();
    const lcovPaths = coverageRuns.map((run) => path.join(shardDirectory, `${run.name}.lcov`));
    const logPaths = coverageRuns.map((run) => path.join(shardDirectory, `${run.name}.log`));
    for (const file of [...lcovPaths, ...logPaths]) {
        if (!fs.existsSync(file)) fail(`missing coverage input ${path.relative(repositoryRoot, file)}`);
    }

    const completeIrRecords = parseLcov(fs.readFileSync(lcovPaths[0], "utf8"));
    const baseRecords = parseLcov(fs.readFileSync(lcovPaths[0], "utf8"));
    const productionFileSet = new Set(productionFiles);
    const actualProduction = [...baseRecords.keys()].filter((file) => productionFileSet.has(file)).sort();
    if (JSON.stringify(actualProduction) !== JSON.stringify(productionFiles)) {
        const missing = productionFiles.filter((file) => !baseRecords.has(file));
        fail(
            `full Foundry coverage denominator does not match the current production source set; missing records: ${missing.join(", ") || "none"}`
        );
    }
    const shardRecords = lcovPaths.slice(1).map((file) => parseLcov(fs.readFileSync(file, "utf8")));
    mergeLcov(baseRecords, shardRecords, productionFiles);
    fs.writeFileSync(path.join(coverageDirectory, "lcov.info"), renderLcov(baseRecords, productionFiles));

    const summaries = logPaths.map((file) => parseSummary(fs.readFileSync(file, "utf8")));
    const completeIrStatements = mergeStatements([summaries[0]], productionFiles);
    const completeFullIr = coverageMetrics(completeIrRecords, completeIrStatements, productionFiles);
    const statementMetrics = mergeStatements(summaries, productionFiles);
    const { files, overall } = coverageMetrics(baseRecords, statementMetrics, productionFiles);

    const parityRunNames = [`${parityBridgeName}-main`, `${parityBridgeName}-collisions`];
    const parityLcovPaths = parityRunNames.map((name) => path.join(shardDirectory, `${name}.lcov`));
    const parityLogPaths = parityRunNames.map((name) => path.join(shardDirectory, `${name}.log`));
    for (const file of [...parityLcovPaths, ...parityLogPaths]) {
        if (!fs.existsSync(file)) fail(`missing parity-bridge input ${path.relative(repositoryRoot, file)}`);
    }
    const parityRecords = parseLcov(fs.readFileSync(parityLcovPaths[0], "utf8"));
    const parityShardRecords = parityLcovPaths
        .slice(1)
        .map((file) => parseLcov(fs.readFileSync(file, "utf8")));
    mergeLcov(parityRecords, parityShardRecords, productionFiles);
    const paritySummaryReports = parityLogPaths.map((file) =>
        parseSummary(fs.readFileSync(file, "utf8"))
    );
    const parityStatements = mergeStatements(paritySummaryReports, productionFiles);
    const parityMetrics = coverageMetrics(parityRecords, parityStatements, productionFiles);
    const summary = {
        schemaVersion: 2,
        source: "Foundry coverage: starting executable Hardhat behaviors re-instrumented through mapped Foundry destinations and compared with the complete deterministic suite using an identical minimal-IR denominator; final LCOV then receives exact-source mapping shards",
        coverageSeed,
        coverageSelection: {
            included: "all deterministic unit, integration, deployment, and Hardhat-parity tests",
            excluded: "Foundry-native fuzz and invariant tests; these remain mandatory in the separate complete-suite CI job",
            testRoot: deterministicTestRoot,
        },
        productionFileCount: productionFiles.length,
        historicalHardhatBaseline: {
            role: "historical absolute evidence only; strict improvement is enforced by the same-denominator starting-behavior bridge below",
            overall: baseline.overall,
        },
        completeFullIr,
        parityBridge: {
            selection: "the 1,512 behaviors executable in the authoritative starting Hardhat run, mapped to exact Foundry destinations; five starting pending behaviors and all later upstream/native additions are excluded when uniquely named, while same-named additions remain conservatively included",
            manifestRows: parityEvidence.manifestRows,
            startingExecutableRows: parityEvidence.startingExecutableRows,
            startingPendingRowsExcluded: parityEvidence.startingPendingRowsExcluded,
            originalDestinations: parityEvidence.originalDestinations,
            upstreamDeltaDestinations: parityEvidence.upstreamDeltaDestinations,
            exactParityDestinationCount: parityEvidence.exactParityDestinations.length,
            excludedAdditiveTestNameCount: parityEvidence.additiveTestNames.length,
            conservativeAdditionCount: parityEvidence.conservativeAdditions.length,
            conservativeAdditionalDestinations: parityEvidence.conservativeAdditions,
            destinationCount: parityEvidence.destinations.length,
            mainSelectorCount: parityEvidence.mainSelectorCount,
            collisionSelectorCount: parityEvidence.collisionSelectorCount,
            testResult: {
                passing: parityEvidence.destinations.length,
                failing: 0,
                skipped: 0,
                evidence: "live Forge enumeration fixed both selector partitions; the inverse-name main run plus contract-scoped collision recovery contain every starting destination; both minimal-IR bridge runs exited successfully",
            },
            statementAggregation: "the two bridge partitions expose statement totals but not stable statement IDs; the reported covered value is their conservative maximum, while non-regression is additionally guaranteed because the complete run is a strict test superset",
            overall: parityMetrics.overall,
            files: parityMetrics.files,
        },
        overall,
        files,
        runTimings,
    };
    const exceptions = fs.existsSync(exceptionsPath)
        ? JSON.parse(fs.readFileSync(exceptionsPath, "utf8")).exceptions
        : [];
    fs.writeFileSync(
        path.join(coverageDirectory, "foundry-coverage-summary.json"),
        `${JSON.stringify(summary, null, 2)}\n`
    );
    fs.writeFileSync(
        path.join(coverageDirectory, "foundry-coverage-by-file.csv"),
        [
            "file,lines_covered,lines_total,lines_pct,statements_covered,statements_total,statements_pct,branches_covered,branches_total,branches_pct,functions_covered,functions_total,functions_pct",
            ...files.map((file) =>
                [
                    file.file,
                    file.lines.covered,
                    file.lines.total,
                    file.lines.pct,
                    file.statements.covered,
                    file.statements.total,
                    file.statements.pct,
                    file.branches.covered,
                    file.branches.total,
                    file.branches.pct,
                    file.functions.covered,
                    file.functions.total,
                    file.functions.pct,
                ].join(",")
            ),
        ].join("\n") + "\n"
    );
    checkCoverage(summary, exceptions);
    console.log(
        `coverage passed on identical minimal-IR denominators: starting behaviors -> complete deterministic suite lines ${parityMetrics.overall.lines.pct}% -> ${completeFullIr.overall.lines.pct}%, statements ${parityMetrics.overall.statements.pct}% -> ${completeFullIr.overall.statements.pct}%, branches ${parityMetrics.overall.branches.pct}% -> ${completeFullIr.overall.branches.pct}%, functions ${parityMetrics.overall.functions.pct}% -> ${completeFullIr.overall.functions.pct}%; final mapped LCOV lines ${overall.lines.pct}%, branches ${overall.branches.pct}%`
    );
}

fs.mkdirSync(coverageDirectory, { recursive: true });
if (mergeOnly) {
    if (!fs.existsSync(shardDirectory)) {
        fail("coverage/shards does not exist; run coverage producers first");
    }
    mergeAndCheck(loadPersistedRunTimings(), loadPersistedParityEvidence());
} else if (runGroup === "deterministic") {
    fs.mkdirSync(shardDirectory, { recursive: true });
    const runTimings = coverageRuns.map(runCoverage);
    persistGroupResult(runGroup, runTimings);
} else if (runGroup === "parity-main" || runGroup === "parity-collisions") {
    fs.mkdirSync(shardDirectory, { recursive: true });
    const parityEvidence = loadParityDestinations();
    console.log(
        `coverage bridge: ${parityEvidence.startingExecutableRows} starting executable behaviors -> ${parityEvidence.exactParityDestinations.length} exact destinations + ${parityEvidence.conservativeAdditions.length} conservative collision-recovery additions = ${parityEvidence.destinations.length} selected tests`
    );
    const run = runGroup === "parity-main"
        ? {
            name: `${parityBridgeName}-main`,
            irMinimum: true,
            test: deterministicTestRoot,
            noMatchTest: exactTestNamePattern(parityEvidence.additiveTestNames),
        }
        : {
            name: `${parityBridgeName}-collisions`,
            irMinimum: true,
            test: deterministicTestRoot,
            matchContract: `^(${parityEvidence.collisionContracts.join("|")})$`,
            matchTest: exactTestNamePattern(parityEvidence.collisionNames),
        };
    persistGroupResult(runGroup, [runCoverage(run)], parityEvidence);
} else {
    const parityEvidence = loadParityDestinations();
    console.log(
        `coverage bridge: ${parityEvidence.startingExecutableRows} starting executable behaviors -> ${parityEvidence.exactParityDestinations.length} exact destinations + ${parityEvidence.conservativeAdditions.length} conservative collision-recovery additions = ${parityEvidence.destinations.length} selected tests`
    );
    const parityRuns = [
        {
            name: `${parityBridgeName}-main`,
            irMinimum: true,
            test: deterministicTestRoot,
            noMatchTest: exactTestNamePattern(parityEvidence.additiveTestNames),
        },
        {
            name: `${parityBridgeName}-collisions`,
            irMinimum: true,
            test: deterministicTestRoot,
            matchContract: `^(${parityEvidence.collisionContracts.join("|")})$`,
            matchTest: exactTestNamePattern(parityEvidence.collisionNames),
        },
    ];
    if (!resume) fs.rmSync(shardDirectory, { recursive: true, force: true });
    fs.mkdirSync(shardDirectory, { recursive: true });
    const runTimings = [...coverageRuns, ...parityRuns].map((run) => {
        const reportPath = path.join(shardDirectory, `${run.name}.lcov`);
        const logPath = path.join(shardDirectory, `${run.name}.log`);
        if (resume && fs.existsSync(reportPath) && fs.existsSync(logPath)) {
            console.log(`coverage: ${run.name} already passed`);
            return { name: run.name, elapsedSeconds: null, resumed: true };
        }
        return runCoverage(run);
    });
    persistGroupResult("sequential", runTimings, parityEvidence);
    mergeAndCheck(runTimings, parityEvidence);
}
