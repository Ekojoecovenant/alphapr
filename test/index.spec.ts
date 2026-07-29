import { env, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import worker from "../src/index";

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe("AlphaPR worker", () => {
  it("responds to a plain GET with a liveness message", async () => {
    const request = new IncomingRequest("http://example.com");
    const ctx = createExecutionContext();
    const response = await worker.fetch(request, env, ctx);
    await waitOnExecutionContext(ctx);
    expect(await response.text()).toBe("AlphaPR is alive");
  });
});