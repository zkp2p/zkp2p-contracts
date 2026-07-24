#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const coverageDirectory = path.join(repositoryRoot, "coverage");
const shardDirectory = path.join(coverageDirectory, "shards");
const exceptionsPath = path.join(repositoryRoot, "test-foundry/coverage-exceptions.json");
const mergePartitions = process.argv.includes("--merge-partitions");
const laneArgument = process.argv.find((argument) => argument.startsWith("--lane="));
const lane = laneArgument?.slice("--lane=".length);
const coverageSeed = "0x0000000000000000000000000000000000000000000000000000000000000001";
const deterministicTestRoot = "test-foundry/deterministic";
const coverageFloors = {
    lines: 99.42,
    statements: 98.7,
    branches: 94.74,
    functions: 100,
};
const excludedProductionDirectories = new Set([
    "contracts/external",
    "contracts/interfaces",
    "contracts/mocks",
]);

const legacyOrchestratorTests = [
    "OrchestratorCancel.t.sol",
    "OrchestratorFulfillAccounting.t.sol",
    "OrchestratorFulfillCore.t.sol",
    "OrchestratorFulfillHook.t.sol",
    "OrchestratorFulfillPartialReentry.t.sol",
    "OrchestratorGovernance.t.sol",
    "OrchestratorManualRelease.t.sol",
    "OrchestratorPrune.t.sol",
    "OrchestratorSignal.t.sol",
    "OrchestratorViews.t.sol",
].map((file) => `test-foundry/deterministic/orchestrator/${file}`);

const monolithicCoverageRun = {
    name: "full-ir",
    irMinimum: true,
    test: deterministicTestRoot,
};

const deterministicCoverageRuns = [
    {
        name: "deterministic-deployment",
        irMinimum: true,
        test: "test-foundry/deterministic/deployment",
    },
    {
        name: "deterministic-escrow",
        irMinimum: true,
        test: "test-foundry/deterministic/escrow",
    },
    {
        name: "deterministic-hooks",
        irMinimum: true,
        test: "test-foundry/deterministic/hooks",
    },
    {
        name: "deterministic-guardian",
        irMinimum: true,
        test: "test-foundry/deterministic/guardian",
    },
    {
        name: "deterministic-integration",
        irMinimum: true,
        test: "test-foundry/deterministic/integration",
    },
    {
        name: "deterministic-libs",
        irMinimum: true,
        test: "test-foundry/deterministic/libs",
    },
    {
        name: "deterministic-oracles",
        irMinimum: true,
        test: "test-foundry/deterministic/oracles",
    },
    {
        name: "deterministic-orchestrator",
        irMinimum: true,
        test: "test-foundry/deterministic/orchestrator",
    },
    {
        name: "deterministic-periphery",
        irMinimum: true,
        test: "test-foundry/deterministic/periphery",
    },
    {
        name: "deterministic-rate-manager",
        irMinimum: true,
        test: "test-foundry/deterministic/rateManager",
    },
    {
        name: "deterministic-registries",
        irMinimum: true,
        test: "test-foundry/deterministic/registries",
    },
    {
        name: "deterministic-risk",
        irMinimum: true,
        test: "test-foundry/deterministic/risk",
    },
    {
        name: "deterministic-staking",
        irMinimum: true,
        test: "test-foundry/deterministic/staking",
    },
    {
        name: "deterministic-verifiers",
        irMinimum: true,
        test: "test-foundry/deterministic/verifiers",
    },
].map((run) => ({ ...run, debugStatements: true }));

const exactSourceCoverageRuns = [
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
        test: "test-foundry/deterministic/periphery/ProtocolViewer.t.sol",
    },
    {
        name: "risk-libraries",
        source: "contracts/lib/BoundedCall.sol",
        test: "test-foundry/deterministic/libs",
    },
    {
        name: "intent-guardian",
        source: "contracts/IntentGuardian.sol",
        test: "test-foundry/deterministic/guardian",
    },
    ...legacyOrchestratorTests.map((test, index) => ({
        name: `legacy-orchestrator-${index}`,
        source: "contracts/Orchestrator.sol",
        test,
    })),
];

const coverageLanes = new Map([
    ["escrow", ["deterministic-escrow", "deterministic-integration"]],
    ["staking", ["deterministic-staking", "deterministic-verifiers"]],
    ["orchestrator", ["deterministic-orchestrator", "deterministic-rate-manager", "deterministic-libs"]],
    [
        "remaining",
        [
            "deterministic-deployment",
            "deterministic-guardian",
            "deterministic-hooks",
            "deterministic-oracles",
            "deterministic-periphery",
            "deterministic-registries",
            "deterministic-risk",
        ],
    ],
]);

function fail(message) {
    console.error(message);
    process.exit(1);
}

function pathsForRun(run) {
    return {
        reportPath: path.join(shardDirectory, `${run.name}.lcov`),
        logPath: path.join(shardDirectory, `${run.name}.log`),
        timingPath: path.join(shardDirectory, `${run.name}.timing.json`),
    };
}

function runCoverage(run) {
    const { reportPath, logPath, timingPath } = pathsForRun(run);
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
    if (run.debugStatements) args.push("--report", "debug");
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
            ? [
                `... coverage output truncated to first and final ${diagnosticLimit / 2} bytes ...`,
                output.slice(0, diagnosticLimit / 2),
                "... middle of coverage output omitted ...",
                output.slice(-diagnosticLimit / 2),
            ].join("\n")
            : output;
        process.stderr.write(diagnostic);
        fail(
            `coverage shard ${run.name} failed after ${elapsedSeconds.toFixed(2)}s (status=${result.status}, signal=${result.signal || "none"}, error=${result.error?.message || "none"})`
        );
    }
    fs.writeFileSync(timingPath, `${JSON.stringify({ name: run.name, elapsedSeconds })}\n`);
    console.log(`coverage: ${run.name} passed in ${elapsedSeconds.toFixed(2)}s`);
    return { name: run.name, elapsedSeconds };
}

function normalizeSource(source) {
    const normalized = source.replaceAll("\\", "/");
    const root = repositoryRoot.replaceAll("\\", "/");
    return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function containsTestFile(directory) {
    return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
        const entryPath = path.join(directory, entry.name);
        return entry.isDirectory() ? containsTestFile(entryPath) : entry.isFile() && entry.name.endsWith(".t.sol");
    });
}

function validateDeterministicPartitions() {
    const deterministicEntries = fs
        .readdirSync(path.join(repositoryRoot, deterministicTestRoot), { withFileTypes: true });
    const rootTestFiles = deterministicEntries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".t.sol"))
        .map((entry) => `${deterministicTestRoot}/${entry.name}`)
        .sort();
    if (rootTestFiles.length > 0) {
        fail(
            `root-level deterministic tests are not assigned to a coverage partition: ${rootTestFiles.join(", ")}`
        );
    }

    const expectedDirectories = deterministicEntries
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join(repositoryRoot, deterministicTestRoot, entry.name))
        .filter(containsTestFile)
        .map(normalizeSource)
        .sort();
    const configuredDirectories = deterministicCoverageRuns.map((run) => run.test).sort();
    if (JSON.stringify(expectedDirectories) !== JSON.stringify(configuredDirectories)) {
        fail(
            `deterministic coverage partition mismatch; expected ${expectedDirectories.join(", ")}, configured ${configuredDirectories.join(", ")}`
        );
    }

    const configuredRunNames = deterministicCoverageRuns.map((run) => run.name).sort();
    const assignedRunNames = [...coverageLanes.values()].flat().sort();
    if (JSON.stringify(configuredRunNames) !== JSON.stringify(assignedRunNames)) {
        fail(
            `coverage lane assignment mismatch; configured ${configuredRunNames.join(", ")}, assigned ${assignedRunNames.join(", ")}`
        );
    }
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

function sortedMapKeys(map) {
    return [...map.keys()].sort();
}

function recordShape(record) {
    return {
        lines: sortedMapKeys(record.lines),
        branches: sortedMapKeys(record.branches),
        functions: sortedMapKeys(record.functions),
        functionDefinitions: record.functionDefinitions
            .map((definition) => `${definition.line}:${definition.name}`)
            .sort(),
    };
}

function validateCompleteProductionRecords(records, productionFiles, runName) {
    const productionFileSet = new Set(productionFiles);
    const actualProduction = [...records.keys()].filter((file) => productionFileSet.has(file)).sort();
    if (JSON.stringify(actualProduction) !== JSON.stringify(productionFiles)) {
        const missing = productionFiles.filter((file) => !records.has(file));
        const extra = actualProduction.filter((file) => !productionFileSet.has(file));
        fail(
            `${runName} production denominator does not match the current source set; missing: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}`
        );
    }
}

function validatePartitionShapes(partitionRecords, productionFiles) {
    const [baseline, ...others] = partitionRecords;
    for (const { run, records } of partitionRecords) {
        validateCompleteProductionRecords(records, productionFiles, run.name);
    }
    for (const { run, records } of others) {
        for (const source of productionFiles) {
            if (JSON.stringify(recordShape(records.get(source))) !== JSON.stringify(recordShape(baseline.records.get(source)))) {
                fail(
                    `coverage anchor shape changed for ${source} between ${baseline.run.name} and ${run.name}`
                );
            }
        }
    }
}

function parseTestResult(contents, runName) {
    const matches = [...contents.matchAll(
        /^Ran (\d+) test suites? in .+: (\d+) tests passed, 0 failed, 0 skipped \((\d+) total tests\)$/gm
    )];
    if (matches.length !== 1) {
        fail(`coverage shard ${runName} lacks one unambiguous all-passing test summary`);
    }
    const [, suites, passed, total] = matches[0];
    if (passed !== total) fail(`coverage shard ${runName} did not execute every reported test`);
    return { suites: Number(suites), tests: Number(total) };
}

function parseDebugStatements(contents, productionFiles, runName) {
    const productionFileSet = new Set(productionFiles);
    const statements = new Map(productionFiles.map((source) => [source, new Map()]));
    let currentSource = null;
    for (const line of contents.split(/\r?\n/)) {
        const sourceMatch = line.match(/^(.+\.sol):$/);
        if (sourceMatch) {
            const source = normalizeSource(sourceMatch[1]);
            currentSource = productionFileSet.has(source) ? source : null;
            continue;
        }
        if (!currentSource) continue;
        const statementMatch = line.match(
            /^- Statement \(location: \(source ID: \d+, lines: [^,]+, bytes: (\d+)\.\.(\d+)\), hits: (\d+)\)/
        );
        if (!statementMatch) continue;
        const key = `${statementMatch[1]}:${statementMatch[2]}`;
        const hits = Number(statementMatch[3]);
        const existing = statements.get(currentSource).get(key);
        if (existing !== undefined && existing !== hits) {
            fail(`duplicate statement anchor ${currentSource}:${key} has conflicting hits in ${runName}`);
        }
        statements.get(currentSource).set(key, hits);
    }
    for (const source of productionFiles) {
        if (statements.get(source).size === 0) {
            fail(`coverage shard ${runName} lacks debug statement anchors for ${source}`);
        }
    }
    return statements;
}

function reconstructPartitionStatements(partitionRuns, productionFiles) {
    const parsed = partitionRuns.map(({ run, log }) => ({
        run,
        statements: parseDebugStatements(log, productionFiles, run.name),
    }));
    const reconstructed = new Map();
    for (const source of productionFiles) {
        const baselineKeys = sortedMapKeys(parsed[0].statements.get(source));
        for (const { run, statements } of parsed.slice(1)) {
            const keys = sortedMapKeys(statements.get(source));
            if (JSON.stringify(keys) !== JSON.stringify(baselineKeys)) {
                fail(`statement anchor shape changed for ${source} in ${run.name}`);
            }
        }
        const hits = baselineKeys.map((key) =>
            Math.max(...parsed.map(({ statements }) => statements.get(source).get(key)))
        );
        reconstructed.set(source, metricFromValues(hits));
    }
    return reconstructed;
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

function mergeStatements(summaryReports, productionFiles, reconstructedStatements = null) {
    const statements = new Map();
    for (const source of productionFiles) {
        const candidates = summaryReports.map((report) => report.get(source)).filter(Boolean);
        if (candidates.length === 0) fail(`missing summary metrics for ${source}`);
        const totals = new Set(candidates.map((metrics) => metrics.statements.total));
        if (totals.size !== 1) {
            fail(`statement denominator changed across coverage configurations for ${source}`);
        }
        const reconstructed = reconstructedStatements?.get(source);
        if (reconstructed && reconstructed.total !== candidates[0].statements.total) {
            fail(
                `debug statement denominator ${reconstructed.total} does not match summary denominator ${candidates[0].statements.total} for ${source}`
            );
        }
        statements.set(source, {
            covered: Math.max(
                reconstructed?.covered || 0,
                ...candidates.map((metrics) => metrics.statements.covered)
            ),
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
    for (const [metric, floor] of Object.entries(coverageFloors)) {
        const actual = summary.overall[metric].pct;
        if (actual < floor) {
            failures.push(`overall ${metric} coverage ${actual}% is below the ${floor}% Foundry baseline`);
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

function mergeAndCheck(runs, runTimings) {
    const productionFiles = discoverProductionFiles();
    const runFiles = runs.map((run) => ({ run, ...pathsForRun(run) }));
    for (const file of runFiles.flatMap(({ reportPath, logPath }) => [reportPath, logPath])) {
        if (!fs.existsSync(file)) fail(`missing coverage input ${path.relative(repositoryRoot, file)}`);
    }

    const parsedRuns = runFiles.map(({ run, reportPath, logPath }) => ({
        run,
        records: parseLcov(fs.readFileSync(reportPath, "utf8")),
        log: fs.readFileSync(logPath, "utf8"),
    }));
    const partitioned = deterministicCoverageRuns.every((partition) =>
        runs.some((run) => run.name === partition.name)
    );
    const denominatorRuns = partitioned
        ? deterministicCoverageRuns.map((partition) =>
            parsedRuns.find(({ run }) => run.name === partition.name)
        )
        : [parsedRuns[0]];
    if (partitioned) {
        validatePartitionShapes(denominatorRuns, productionFiles);
    } else {
        validateCompleteProductionRecords(denominatorRuns[0].records, productionFiles, denominatorRuns[0].run.name);
    }

    const baseRecords = denominatorRuns[0].records;
    const shardRecords = parsedRuns
        .filter(({ run }) => run.name !== denominatorRuns[0].run.name)
        .map(({ records }) => records);
    mergeLcov(baseRecords, shardRecords, productionFiles);
    fs.writeFileSync(path.join(coverageDirectory, "lcov.info"), renderLcov(baseRecords, productionFiles));

    const summaries = parsedRuns.map(({ log }) => parseSummary(log));
    const reconstructedStatements = partitioned
        ? reconstructPartitionStatements(denominatorRuns, productionFiles)
        : null;
    const statementMetrics = mergeStatements(summaries, productionFiles, reconstructedStatements);
    const { files, overall } = coverageMetrics(baseRecords, statementMetrics, productionFiles);
    const testResults = partitioned
        ? denominatorRuns.map(({ run, log }) => ({ name: run.name, ...parseTestResult(log, run.name) }))
        : [{ name: denominatorRuns[0].run.name, ...parseTestResult(denominatorRuns[0].log, denominatorRuns[0].run.name) }];
    const testExecution = testResults.reduce(
        (total, result) => ({
            suites: total.suites + result.suites,
            tests: total.tests + result.tests,
        }),
        { suites: 0, tests: 0 }
    );

    const summary = {
        schemaVersion: 4,
        source: partitioned
            ? "Partitioned deterministic Foundry coverage with exact-source mapping shards merged onto identical complete minimal-IR denominators"
            : "Deterministic Foundry coverage with exact-source mapping shards merged onto the complete minimal-IR denominator",
        coverageSeed,
        coverageFloors,
        coverageSelection: {
            included: "all deterministic unit, integration, deployment, and regression tests",
            excluded: "Foundry-native fuzz and invariant tests; these remain mandatory in the separate complete-suite CI job",
            testRoot: deterministicTestRoot,
            partitions: partitioned ? deterministicCoverageRuns.map((run) => run.test) : [deterministicTestRoot],
        },
        testExecution,
        productionFileCount: productionFiles.length,
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
        `deterministic Foundry coverage passed: lines ${overall.lines.pct}%, statements ${overall.statements.pct}%, branches ${overall.branches.pct}%, functions ${overall.functions.pct}%`
    );
}

function clearRunOutputs(runs) {
    for (const run of runs) {
        for (const file of Object.values(pathsForRun(run))) fs.rmSync(file, { force: true });
    }
}

function executeRuns(runs) {
    return runs.map(runCoverage);
}

function readRunTiming(run) {
    const { timingPath } = pathsForRun(run);
    if (!fs.existsSync(timingPath)) {
        fail(`missing coverage timing ${path.relative(repositoryRoot, timingPath)}`);
    }
    let timing;
    try {
        timing = JSON.parse(fs.readFileSync(timingPath, "utf8"));
    } catch (error) {
        fail(`invalid coverage timing ${path.relative(repositoryRoot, timingPath)}: ${error.message}`);
    }
    if (
        timing.name !== run.name
        || typeof timing.elapsedSeconds !== "number"
        || !Number.isFinite(timing.elapsedSeconds)
        || timing.elapsedSeconds < 0
    ) {
        fail(`invalid coverage timing contents for ${run.name}`);
    }
    return timing;
}

validateDeterministicPartitions();
fs.mkdirSync(coverageDirectory, { recursive: true });
fs.mkdirSync(shardDirectory, { recursive: true });

if (lane) {
    if (mergePartitions) fail("--lane and --merge-partitions cannot be combined");
    const laneRunNames = coverageLanes.get(lane);
    if (!laneRunNames) fail(`unknown coverage lane ${lane}`);
    const laneRuns = laneRunNames.map((name) => deterministicCoverageRuns.find((run) => run.name === name));
    clearRunOutputs(laneRuns);
    executeRuns(laneRuns);
} else if (mergePartitions) {
    clearRunOutputs(exactSourceCoverageRuns);
    executeRuns(exactSourceCoverageRuns);
    const runs = [...deterministicCoverageRuns, ...exactSourceCoverageRuns];
    mergeAndCheck(runs, runs.map(readRunTiming));
} else {
    const runs = [monolithicCoverageRun, ...exactSourceCoverageRuns];
    fs.rmSync(shardDirectory, { recursive: true, force: true });
    fs.mkdirSync(shardDirectory, { recursive: true });
    const runTimings = executeRuns(runs);
    mergeAndCheck(runs, runTimings);
}
