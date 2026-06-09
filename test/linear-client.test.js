import assert from "node:assert/strict";
import test from "node:test";
import {
  callLinear,
  getLinearCircuitBreakerState,
  resetLinearCircuitBreaker,
} from "../dist/src/linear-client.js";

function api() {
  return {
    logger: {
      warn() {},
    },
  };
}

test("Linear circuit breaker opens after repeated API failures", async () => {
  resetLinearCircuitBreaker();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return {
      ok: false,
      status: 503,
      text: async () => "unavailable",
    };
  };

  try {
    for (let i = 0; i < 5; i += 1) {
      const result = await callLinear(api(), { linearApiKey: "lin_api_test" }, "viewer", {
        query: "query Viewer { viewer { id } }",
        variables: {},
      });
      assert.equal(result.ok, false);
    }

    assert.equal(getLinearCircuitBreakerState().open, true);

    await callLinear(api(), { linearApiKey: "lin_api_test" }, "viewer", {
      query: "query Viewer { viewer { id } }",
      variables: {},
    });

    assert.equal(calls, 5);
  } finally {
    globalThis.fetch = originalFetch;
    resetLinearCircuitBreaker();
  }
});
