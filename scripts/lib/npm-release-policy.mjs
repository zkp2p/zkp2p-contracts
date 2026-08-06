const stableChannel = Object.freeze({
  channel: 'stable',
  distTag: 'latest',
  environment: 'npm-publish-stable',
});
const rcChannel = Object.freeze({
  channel: 'rc',
  distTag: 'rc',
  environment: 'npm-publish-rc',
});

export function resolveReleasePolicy({ release, packageVersion, releaseLine }) {
  if (packageVersion !== release) {
    throw new Error(`release input ${release} does not match package version ${packageVersion}`);
  }
  if (release === releaseLine) return { ...stableChannel };

  const escapedLine = releaseLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (new RegExp(`^${escapedLine}-rc\\.(0|[1-9]\\d*)$`).test(release)) {
    return { ...rcChannel };
  }
  throw new Error(`release must be exactly ${releaseLine} or ${releaseLine}-rc.N`);
}

export function assertExpectedDistTags(actual, expected) {
  for (const tag of ['latest', 'rc']) {
    if (!expected[tag]) throw new Error(`expected ${tag} baseline is missing`);
    if (actual[tag] !== expected[tag]) {
      throw new Error(`${tag} points to ${actual[tag] || '<missing>'}, expected ${expected[tag]}`);
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
