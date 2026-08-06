function fail(message) {
  throw new Error(`invalid npm pack result: ${message}`);
}

export function normalizeNpmPackResult(packResult, expectedPackage) {
  let result;

  if (Array.isArray(packResult)) {
    if (packResult.length !== 1) fail('expected exactly one array entry');
    [result] = packResult;
  } else if (packResult && typeof packResult === 'object') {
    const packageNames = Object.keys(packResult);
    if (packageNames.length !== 1 || packageNames[0] !== expectedPackage) {
      fail(`expected exactly the ${expectedPackage} object key`);
    }
    result = packResult[expectedPackage];
  } else {
    fail('expected a one-element array or package-keyed object');
  }

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    fail('package entry must be an object');
  }
  if (result.name !== expectedPackage) {
    fail(`package name must be ${expectedPackage}`);
  }
  for (const field of ['version', 'filename', 'integrity', 'shasum']) {
    if (typeof result[field] !== 'string' || result[field].length === 0) {
      fail(`${field} must be a non-empty string`);
    }
  }

  return result;
}
