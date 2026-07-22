#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const repositoryRoot = path.resolve(__dirname, "..");
const coverageDirectory = path.join(repositoryRoot, "coverage");
const shardDirectory = path.join(coverageDirectory, "shards");
const exceptionsPath = path.join(repositoryRoot, "test-foundry/coverage-exceptions.json");
const resume = process.argv.includes("--resume");
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

function mergeAndCheck(runTimings) {
    const productionFiles = discoverProductionFiles();
    const lcovPaths = coverageRuns.map((run) => path.join(shardDirectory, `${run.name}.lcov`));
    const logPaths = coverageRuns.map((run) => path.join(shardDirectory, `${run.name}.log`));
    for (const file of [...lcovPaths, ...logPaths]) {
        if (!fs.existsSync(file)) fail(`missing coverage input ${path.relative(repositoryRoot, file)}`);
    }

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
    const statementMetrics = mergeStatements(summaries, productionFiles);
    const { files, overall } = coverageMetrics(baseRecords, statementMetrics, productionFiles);

    const summary = {
        schemaVersion: 3,
        source: "Deterministic Foundry coverage with exact-source mapping shards merged onto the complete minimal-IR denominator",
        coverageSeed,
        coverageFloors,
        coverageSelection: {
            included: "all deterministic unit, integration, deployment, and regression tests",
            excluded: "Foundry-native fuzz and invariant tests; these remain mandatory in the separate complete-suite CI job",
            testRoot: deterministicTestRoot,
        },
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

fs.mkdirSync(coverageDirectory, { recursive: true });
if (!resume) fs.rmSync(shardDirectory, { recursive: true, force: true });
fs.mkdirSync(shardDirectory, { recursive: true });
const runTimings = coverageRuns.map((run) => {
    const reportPath = path.join(shardDirectory, `${run.name}.lcov`);
    const logPath = path.join(shardDirectory, `${run.name}.log`);
    if (resume && fs.existsSync(reportPath) && fs.existsSync(logPath)) {
        console.log(`coverage: ${run.name} already passed`);
        return { name: run.name, elapsedSeconds: null, resumed: true };
    }
    return runCoverage(run);
});
mergeAndCheck(runTimings);
