import { execFileSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';

const publishEnvironment = 'npm-publish';
const coreSemverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const stableChannel = Object.freeze({
  channel: 'stable',
  distTag: 'latest',
  environment: publishEnvironment,
});
const rcChannel = Object.freeze({
  channel: 'rc',
  distTag: 'rc',
  environment: publishEnvironment,
});

export function resolveReleasePolicy({ release, packageVersion }) {
  if (packageVersion !== release) {
    throw new Error(`release input ${release} does not match package version ${packageVersion}`);
  }

  if (coreSemverPattern.test(release)) return { ...stableChannel };
  if (/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-rc\.(0|[1-9]\d*)$/.test(release)) {
    return { ...rcChannel };
  }
  throw new Error('release must be core SemVer or core SemVer-rc.N');
}

export function assertExpectedDistTags(actual, expected) {
  for (const tag of ['latest', 'rc']) {
    if (!expected[tag]) throw new Error(`expected ${tag} baseline is missing`);
    if (actual[tag] !== expected[tag]) {
      throw new Error(`${tag} points to ${actual[tag] || '<missing>'}, expected ${expected[tag]}`);
    }
  }
}

export function assertSuppliedDistTags(actual, expected) {
  for (const tag of ['latest', 'rc']) {
    if (!expected[tag]) continue;
    if (actual?.[tag] !== expected[tag]) {
      throw new Error(`${tag} moved from ${expected[tag]} to ${actual?.[tag] || '<missing>'}`);
    }
  }
}

export function postPublishDistTags(channel, release, baselines) {
  if (channel === 'stable') return { ...baselines, latest: release };
  if (channel === 'rc') return { ...baselines, rc: release };
  throw new Error(`unsupported release channel ${channel}`);
}

export function releaseRegistryExpectations({ channel, release, recovery, baselines }) {
  const verify = postPublishDistTags(channel, release, baselines);
  return { guard: recovery ? verify : { ...baselines }, verify };
}

const allowedRecoveryChanges = new Set([
  '.agents/skills/zkp2p-contracts-publish/SKILL.md',
  '.github/workflows/publish-contracts-v2.yml',
  'NPM_RELEASE.md',
  'scripts/npm-release.mjs',
  'scripts/lib/npm-pack-result.mjs',
  'scripts/lib/npm-release-policy.mjs',
  'scripts/npm-release.spec.mjs',
  'scripts/lib/release-environment-policy.mjs',
  'scripts/verify-github-environment.mjs',
  'scripts/verify-github-environment.spec.mjs',
  'packages/contracts/scripts/verify-release.mjs',
  'packages/contracts/scripts/smoke-installed.mjs',
]);

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

export function assertCanonicalReleaseSource({
  cwd,
  githubRepository,
  githubEventName,
  githubRef,
  githubSha,
  releaseTag,
  recovery,
}) {
  if (githubRepository !== 'zkp2p/zkp2p-contracts') {
    throw new Error('release repository must be zkp2p/zkp2p-contracts');
  }
  if (githubEventName !== 'workflow_dispatch') {
    throw new Error('release event must be workflow_dispatch');
  }
  if (githubRef !== 'refs/heads/main') throw new Error('release ref must be refs/heads/main');

  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (head !== githubSha) throw new Error(`checked-out HEAD ${head} does not match workflow SHA ${githubSha}`);
  const canonicalMain = git(cwd, ['rev-parse', 'refs/remotes/zkp2p-canonical/main']);
  if (canonicalMain !== githubSha) {
    throw new Error(`canonical main is ${canonicalMain}, not workflow SHA ${githubSha}`);
  }
  if (git(cwd, ['cat-file', '-t', releaseTag]) !== 'tag') {
    throw new Error(`release tag ${releaseTag} must be an annotated tag object`);
  }
  const tagCommit = git(cwd, ['rev-parse', `${releaseTag}^{commit}`]);
  if (!recovery) {
    if (tagCommit !== githubSha) {
      throw new Error(`release tag ${releaseTag} points to ${tagCommit}, not workflow SHA ${githubSha}`);
    }
    return;
  }

  try {
    git(cwd, ['merge-base', '--is-ancestor', tagCommit, head]);
  } catch {
    throw new Error(`recovery requires release tag ${releaseTag} to be an ancestor of canonical main`);
  }
  const changedFiles = git(cwd, ['diff', '--no-renames', '--name-only', `${tagCommit}..${head}`])
    .split('\n')
    .filter(Boolean);
  const unexpected = changedFiles.filter((file) => !allowedRecoveryChanges.has(file));
  if (unexpected.length > 0) {
    throw new Error(`recovery main differs from the release tag outside recovery code: ${unexpected.join(', ')}`);
  }
}

function readLength(bytes, offset) {
  if (offset >= bytes.length) throw new Error('DER length exceeds input');
  const first = bytes[offset];
  if (first === 0x80) throw new Error('indefinite DER length is not allowed');
  if ((first & 0x80) === 0) return { length: first, bytesRead: 1 };
  const count = first & 0x7f;
  if (count === 0 || count > 4 || offset + 1 + count > bytes.length) {
    throw new Error('DER length exceeds input');
  }
  if (bytes[offset + 1] === 0) throw new Error('non-minimal DER length');
  let length = 0;
  for (let index = 0; index < count; index += 1) length = (length * 256) + bytes[offset + 1 + index];
  if (length < 128) throw new Error('non-minimal DER length');
  return { length, bytesRead: count + 1 };
}

function readElement(bytes, offset) {
  if (offset >= bytes.length) throw new Error('DER element exceeds input');
  const tag = bytes[offset];
  const lengthInfo = readLength(bytes, offset + 1);
  const start = offset + 1 + lengthInfo.bytesRead;
  const end = start + lengthInfo.length;
  if (end > bytes.length) throw new Error('DER length exceeds input');
  return { tag, start, end, next: end };
}

function decodeOid(bytes) {
  if (bytes.length === 0) throw new Error('empty DER OID');
  const parts = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let value = 0;
  for (const byte of bytes.subarray(1)) {
    value = (value * 128) + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(value);
      value = 0;
    }
  }
  if ((bytes.at(-1) & 0x80) !== 0) throw new Error('truncated DER OID');
  return parts.join('.');
}

function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('invalid UTF-8 in DER extension');
  }
}

export function readDerExtensions(input) {
  const bytes = Buffer.from(input);
  const root = readElement(bytes, 0);
  if (root.tag !== 0x30) throw new Error('DER extensions must be a sequence');
  if (root.next !== bytes.length) throw new Error('trailing DER bytes');
  const extensions = new Map();
  let offset = root.start;
  while (offset < root.end) {
    const extension = readElement(bytes, offset);
    if (extension.tag !== 0x30) throw new Error('DER extension must be a sequence');
    let childOffset = extension.start;
    const oidElement = readElement(bytes, childOffset);
    if (oidElement.tag !== 0x06) throw new Error('DER extension must begin with an OID');
    const oid = decodeOid(bytes.subarray(oidElement.start, oidElement.end));
    childOffset = oidElement.next;
    const valueElement = readElement(bytes, childOffset);
    if (valueElement.tag !== 0x0c) throw new Error('DER extension value must be a UTF8String');
    childOffset = valueElement.next;
    if (childOffset !== extension.end) throw new Error('trailing DER bytes in extension');
    if (extensions.has(oid)) throw new Error(`duplicate DER OID ${oid}`);
    decodeUtf8(bytes.subarray(valueElement.start, valueElement.end));
    extensions.set(oid, bytes.subarray(valueElement.start, valueElement.end));
    offset = extension.next;
  }
  return extensions;
}

function collectCertificateExtensions(rawCertificate) {
  const bytes = Buffer.from(rawCertificate);
  const found = new Map();
  function visit(start, end) {
    let offset = start;
    while (offset < end) {
      const element = readElement(bytes, offset);
      if (element.next > end) throw new Error('DER length exceeds containing element');
      if (element.tag === 0x30) {
        const first = readElement(bytes, element.start);
        if (first.tag === 0x06) {
          let valueOffset = first.next;
          if (valueOffset < element.end && bytes[valueOffset] === 0x01) {
            valueOffset = readElement(bytes, valueOffset).next;
          }
          if (valueOffset < element.end) {
            const value = readElement(bytes, valueOffset);
            if (value.tag === 0x04 && value.next === element.end) {
              const oid = decodeOid(bytes.subarray(first.start, first.end));
              if (found.has(oid)) throw new Error(`duplicate certificate extension ${oid}`);
              found.set(oid, bytes.subarray(value.start, value.end));
            }
          }
        }
        visit(element.start, element.end);
      } else if ((element.tag & 0x20) !== 0 || (element.tag & 0xc0) === 0x80) {
        visit(element.start, element.end);
      }
      offset = element.next;
    }
  }
  const root = readElement(bytes, 0);
  if (root.next !== bytes.length) throw new Error('trailing certificate DER bytes');
  visit(root.start, root.end);
  return found;
}

function requireExactlyOne(values, message) {
  if (values.length !== 1) throw new Error(message);
  return values[0];
}

function requireEqual(actual, expected, claim) {
  if (actual !== expected) throw new Error(`${claim} is ${actual ?? '<missing>'}, expected ${expected}`);
}

function decodePayload(bundle) {
  try {
    return JSON.parse(Buffer.from(bundle.bundle.dsseEnvelope.payload, 'base64').toString('utf8'));
  } catch {
    throw new Error('SLSA DSSE payload is invalid');
  }
}

export function assertVerifiedProvenance({
  auditReport,
  packageName,
  release,
  integrity,
  githubSha,
  runId,
  runAttempt,
  environment,
}) {
  const entry = requireExactlyOne(
    (auditReport?.verified || []).filter((candidate) => candidate.name === packageName && candidate.version === release),
    'expected exactly one verified package entry',
  );
  const slsa = requireExactlyOne(
    (entry.attestationBundles || []).filter((bundle) => bundle.predicateType === 'https://slsa.dev/provenance/v1'),
    'expected exactly one SLSA v1 bundle',
  );
  const statement = decodePayload(slsa);
  const subject = requireExactlyOne(statement.subject || [], 'expected exactly one provenance subject');
  requireEqual(subject.name, `pkg:npm/${packageName.replace('@', '%40')}@${release}`, 'subject PURL');
  const integrityMatch = /^sha512-([A-Za-z0-9+/]+={0,2})$/.exec(integrity);
  if (!integrityMatch) throw new Error('validated integrity must be sha512-base64');
  const expectedDigest = Buffer.from(integrityMatch[1], 'base64').toString('hex');
  requireEqual(subject.digest?.sha512, expectedDigest, 'subject SHA-512');

  const buildDefinition = statement.predicate?.buildDefinition;
  const workflow = buildDefinition?.externalParameters?.workflow;
  requireEqual(workflow?.repository, 'https://github.com/zkp2p/zkp2p-contracts', 'workflow repository');
  requireEqual(workflow?.path, '.github/workflows/publish-contracts-v2.yml', 'workflow path');
  requireEqual(workflow?.ref, 'refs/heads/main', 'workflow ref');
  requireEqual(buildDefinition?.internalParameters?.github?.event_name, 'workflow_dispatch', 'workflow event');
  const dependencies = (buildDefinition?.resolvedDependencies || []).filter(
    (dependency) => dependency.uri === 'git+https://github.com/zkp2p/zkp2p-contracts@refs/heads/main',
  );
  const dependency = requireExactlyOne(dependencies, 'expected exactly one canonical Git dependency');
  requireEqual(dependency.digest?.gitCommit, githubSha, 'resolved Git commit');
  requireEqual(
    statement.predicate?.runDetails?.metadata?.invocationId,
    `https://github.com/zkp2p/zkp2p-contracts/actions/runs/${runId}/attempts/${runAttempt}`,
    'provenance invocation ID',
  );

  const rawBytes = slsa.bundle?.verificationMaterial?.certificate?.rawBytes;
  if (typeof rawBytes !== 'string') throw new Error('provenance certificate is missing');
  const rawCertificate = Buffer.from(rawBytes, 'base64');
  let certificate;
  try {
    certificate = new X509Certificate(rawCertificate);
  } catch {
    throw new Error('provenance certificate is invalid');
  }
  const expectedSan = `URI:https://github.com/zkp2p/zkp2p-contracts/.github/workflows/publish-contracts-v2.yml@refs/heads/main`;
  requireEqual(certificate.subjectAltName, expectedSan, 'certificate SAN');
  const extensions = collectCertificateExtensions(rawCertificate);
  const issuer = extensions.get('1.3.6.1.4.1.57264.1.1');
  if (!issuer) throw new Error('certificate OIDC issuer extension is missing');
  requireEqual(decodeUtf8(issuer), 'https://token.actions.githubusercontent.com', 'certificate OIDC issuer');
  const environmentExtension = extensions.get('1.3.6.1.4.1.57264.1.23');
  if (!environmentExtension) throw new Error('certificate environment extension is missing');
  const environmentValue = readElement(environmentExtension, 0);
  if (environmentValue.tag !== 0x0c) throw new Error('certificate environment must be a DER UTF8String');
  if (environmentValue.next !== environmentExtension.length) throw new Error('certificate environment has trailing DER bytes');
  requireEqual(
    decodeUtf8(environmentExtension.subarray(environmentValue.start, environmentValue.end)),
    environment,
    'certificate environment',
  );
}

function requireNumeric(value, label) {
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${label} must be numeric`);
}

export function assertOriginalPublishRun({
  run,
  jobs,
  expectedRepository,
  expectedWorkflowPath,
  expectedHeadSha,
  expectedRunId,
}) {
  requireNumeric(expectedRunId, 'run ID');
  requireEqual(String(run?.id), expectedRunId, 'original run ID');
  requireNumeric(String(run?.run_attempt), 'run attempt');
  requireEqual(run?.repository?.full_name, expectedRepository, 'original run repository');
  requireEqual(run?.path, expectedWorkflowPath, 'original run workflow path');
  requireEqual(run?.event, 'workflow_dispatch', 'original run event');
  requireEqual(run?.head_sha, expectedHeadSha, 'original run head SHA');

  const allJobs = jobs?.jobs || [];
  const publishJob = requireExactlyOne(
    allJobs.filter(
      (job) => job.name === 'Publish with npm OIDC' && job.conclusion === 'success',
    ),
    'expected exactly one successful Publish with npm OIDC job',
  );
  const publishAttempt = String(publishJob.run_attempt);
  requireNumeric(publishAttempt, 'publish job run attempt');
  const allVerificationJobs = allJobs.filter((job) => job.name === 'Verify published package');
  const verificationJobs = allVerificationJobs.filter(
    (job) => String(job.run_attempt) === publishAttempt,
  );
  if (allVerificationJobs.length > 0 && verificationJobs.length === 0) {
    throw new Error(`verification job must match publish attempt ${publishAttempt}`);
  }
  if (verificationJobs.length > 1) throw new Error('expected at most one Verify published package job');
  if (verificationJobs.length === 1) {
    const verification = verificationJobs[0];
    if (!['success', 'failure'].includes(verification.conclusion)) {
      throw new Error('verification job must be successful or failed');
    }
    const publishCompletedAt = Date.parse(publishJob.completed_at);
    const verificationStartedAt = Date.parse(verification.started_at);
    if (!Number.isFinite(publishCompletedAt) || !Number.isFinite(verificationStartedAt)) {
      throw new Error('publish and verification job timestamps must be valid');
    }
    if (verificationStartedAt <= publishCompletedAt) {
      throw new Error('verification job must start after publication completed');
    }
  }
  const allRecoveryJobs = allJobs.filter((job) => /recovery/i.test(job.name));
  const recoveryJobs = allRecoveryJobs.filter((job) => String(job.run_attempt) === publishAttempt);
  if (allRecoveryJobs.length > 0 && recoveryJobs.length === 0) {
    throw new Error(`recovery job must match publish attempt ${publishAttempt}`);
  }
  if (recoveryJobs.some((job) => job.conclusion !== 'skipped')) {
    throw new Error('original recovery job must be skipped');
  }
  return publishAttempt;
}

export async function fetchAllRunJobs(apiBase, headers, fetchImpl = fetch) {
  const allJobs = [];
  let totalCount;
  for (let page = 1; ; page += 1) {
    const url = `${apiBase}/jobs?filter=all&per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`GitHub Actions jobs API returned HTTP ${response.status}`);
    const payload = await response.json();
    if (!Number.isSafeInteger(payload?.total_count) || payload.total_count < 0) {
      throw new Error('GitHub Actions jobs API returned an invalid total_count');
    }
    if (!Array.isArray(payload.jobs)) {
      throw new Error('GitHub Actions jobs API returned an invalid jobs page');
    }
    if (totalCount === undefined) totalCount = payload.total_count;
    if (payload.total_count !== totalCount) {
      throw new Error('GitHub Actions jobs total_count changed during pagination');
    }
    allJobs.push(...payload.jobs);
    if (allJobs.length === totalCount) return { total_count: totalCount, jobs: allJobs };
    if (allJobs.length > totalCount || payload.jobs.length === 0) {
      throw new Error(`GitHub Actions jobs pagination returned ${allJobs.length} of ${totalCount} jobs`);
    }
  }
}
