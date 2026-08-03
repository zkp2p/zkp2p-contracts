type GraphqlResponse<T> = {
  data?: T;
  errors?: unknown[];
};

/**
 * Sends a raw GraphQL request without importing the indexer's schema package.
 * Keeping this boundary HTTP-only avoids a contracts -> indexer package dependency cycle.
 */
export async function postGraphql<T>(
  endpoint: string,
  query: string,
  variables: Record<string, unknown>,
  apiKey?: string,
): Promise<T> {
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 30_000);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({ query, variables }),
      signal: abortController.signal,
    });
    if (!response.ok) {
      throw new Error(`GraphQL request failed with HTTP ${response.status}`);
    }

    const payload = (await response.json()) as GraphqlResponse<T>;
    if (payload.errors?.length || !payload.data) {
      throw new Error(`GraphQL response contained ${payload.errors?.length ?? 0} errors or no data`);
    }
    return payload.data;
  } finally {
    clearTimeout(timeout);
  }
}
