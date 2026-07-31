import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";

// Mock the entire review-handler module so we control handlePREvent's behavior
vi.mock("../src/review-handler", async () => {
  const actual = await vi.importActual<typeof import("../src/review-handler")>(
    "../src/review-handler"
  );
  return {
    ...actual,
    handlePREvent: vi.fn(),
    surfaceFailure: vi.fn().mockResolvedValue(undefined),
  };
});

import worker from "../src/index";
import { handlePREvent, surfaceFailure } from "../src/review-handler";
import { PermanentError } from "../src/errors";

function makeMessage(overrides: Partial<any> = {}) {
  const message = {
    body: {
      installationId: 1,
      owner: "test-owner",
      repo: "test-repo",
      repoFullName: "test-owner/test-repo",
      prNumber: 1,
      headSha: "abc123",
      action: "opened" as const,
      statusCommentId: 42,
      checkRunId: 99,
      ...overrides,
    },
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  };
  return message;
}

function makeBatch(messages: ReturnType<typeof makeMessage>[]) {
  return { messages, queue: "pr-review-jobs" } as any;
}

describe("queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acks the message when handlePREvent succeeds", async () => {
    (handlePREvent as any).mockResolvedValue(undefined);
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a transient failure (plain Error)", async () => {
    (handlePREvent as any).mockRejectedValue(new Error("temporary network blip"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acks (does NOT retry) a PermanentError", async () => {
    (handlePREvent as any).mockRejectedValue(new PermanentError("bad api key, never retry"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("calls surfaceFailure with willRetry=true for a transient error", async () => {
    (handlePREvent as any).mockRejectedValue(new Error("temporary"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(surfaceFailure).toHaveBeenCalledWith(
      message.body,
      env,
      false, // isPermanent
      true // willRetry
    );
  });

  it("calls surfaceFailure with willRetry=false for a PermanentError", async () => {
    (handlePREvent as any).mockRejectedValue(new PermanentError("permanent"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(surfaceFailure).toHaveBeenCalledWith(
      message.body,
      env,
      true, // isPermanent
      false // willRetry
    );
  });

  it("processes multiple messages in a batch independently", async () => {
    (handlePREvent as any)
      .mockResolvedValueOnce(undefined) // first succeeds
      .mockRejectedValueOnce(new Error("second fails")); // second fails transiently

    const messageA = makeMessage({ prNumber: 1 });
    const messageB = makeMessage({ prNumber: 2 });
    const batch = makeBatch([messageA, messageB]);

    await worker.queue(batch, env);

    expect(messageA.ack).toHaveBeenCalledOnce();
    expect(messageB.retry).toHaveBeenCalledOnce();
  });

  it("does not let a failure in one message prevent processing of the next", async () => {
    (handlePREvent as any)
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValueOnce(undefined); // second succeeds

    const messageA = makeMessage({ prNumber: 1 });
    const messageB = makeMessage({ prNumber: 2 });
    const batch = makeBatch([messageA, messageB]);

    await worker.queue(batch, env);

    expect(messageA.retry).toHaveBeenCalledOnce();
    expect(messageB.ack).toHaveBeenCalledOnce();
  });
});