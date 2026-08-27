import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { basename, dirname, join } from "path";

import { canonicalTransactionHash } from "./safeBatchManifest";

function fsyncPath(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function writeStaged(path: string, contents: string): void {
  const descriptor = openSync(path, "w");
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function removeIfPresent(path: string): void {
  if (existsSync(path)) unlinkSync(path);
}

export function installSafeArtifactPair(input: {
  batchPath: string;
  sidecarPath: string;
  supersededDir: string;
  batchContents: string;
  sidecarContents: string;
  supersededSuffix: string;
}): "installed" | "unchanged" {
  const batchExists = existsSync(input.batchPath);
  const sidecarExists = existsSync(input.sidecarPath);
  if (batchExists !== sidecarExists)
    throw new Error("incomplete artifact pair");

  const stagedBatch = `${input.batchPath}.staged-${process.pid}`;
  const stagedSidecar = `${input.sidecarPath}.staged-${process.pid}`;
  removeIfPresent(stagedBatch);
  removeIfPresent(stagedSidecar);
  writeStaged(stagedBatch, input.batchContents);
  writeStaged(stagedSidecar, input.sidecarContents);

  if (
    batchExists &&
    readFileSync(input.batchPath, "utf8") === input.batchContents &&
    readFileSync(input.sidecarPath, "utf8") === input.sidecarContents
  ) {
    unlinkSync(stagedBatch);
    unlinkSync(stagedSidecar);
    return "unchanged";
  }

  const parentDirectory = dirname(input.batchPath);
  if (dirname(input.sidecarPath) !== parentDirectory) {
    removeIfPresent(stagedBatch);
    removeIfPresent(stagedSidecar);
    throw new Error("Safe artifact pair must share a directory");
  }

  if (batchExists) {
    mkdirSync(input.supersededDir, { recursive: true });
    const batchBase = basename(input.batchPath, ".json");
    const archivedBatch = join(
      input.supersededDir,
      `${batchBase}_${input.supersededSuffix}.json`
    );
    const archivedSidecar = join(
      input.supersededDir,
      `${batchBase}_${input.supersededSuffix}.sha256.json`
    );
    if (existsSync(archivedBatch) || existsSync(archivedSidecar)) {
      removeIfPresent(stagedBatch);
      removeIfPresent(stagedSidecar);
      throw new Error("Superseded artifact pair already exists");
    }
    renameSync(input.sidecarPath, archivedSidecar);
    renameSync(input.batchPath, archivedBatch);
    fsyncPath(input.supersededDir);
    fsyncPath(parentDirectory);
  }

  renameSync(stagedSidecar, input.sidecarPath);
  renameSync(stagedBatch, input.batchPath);
  fsyncPath(parentDirectory);
  return "installed";
}

export function assertSafeArtifactPairConsistent(
  batchPath: string,
  sidecarPath: string
): { batch: unknown; manifest: unknown } {
  try {
    if (!existsSync(batchPath) || !existsSync(sidecarPath)) throw new Error();
    const batch = JSON.parse(readFileSync(batchPath, "utf8")) as {
      transactions?: unknown;
    };
    const manifest = JSON.parse(readFileSync(sidecarPath, "utf8")) as {
      transactionsSha256?: unknown;
    };
    if (
      !Array.isArray(batch.transactions) ||
      typeof manifest.transactionsSha256 !== "string" ||
      canonicalTransactionHash(batch.transactions) !==
        manifest.transactionsSha256
    ) {
      throw new Error();
    }
    return { batch, manifest };
  } catch {
    throw new Error("incomplete artifact pair");
  }
}
