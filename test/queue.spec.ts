// @ts-check
import { describe, it, expect, vi, beforeEach } from "vitest";
import { env } from "cloudflare:test";

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
import { handlePREvent, surfaceFailure, type ReviewJob } from "../src/review-handler";
import { PermanentError } from "../src/errors";

// Mocked queue message shape — matches the subset of Cloudflare's Message<T>
// interface that the queue() handler actually uses.
interface MockMessage {
  body: ReviewJob;
  attempts: number;
  ack: ReturnType<typeof vi.fn>;
  retry: ReturnType<typeof vi.fn>;
}

function makeMessage(overrides: Partial<ReviewJob> = {}, attempts = 1): MockMessage {
  return {
    body: {
      installationId: 1,
      owner: "test-owner",
      repo: "test-repo",
      repoFullName: "test-owner/test-repo",
      prNumber: 1,
      headSha: "abc123",
      action: "opened",
      statusCommentId: 42,
      checkRunId: 99,
      ...overrides,
    },
    attempts,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function makeBatch(messages: MockMessage[]): MessageBatch<ReviewJob> {
  return {
    messages: messages as unknown as MessageBatch<ReviewJob>["messages"],
    queue: "pr-review-jobs",
  } as MessageBatch<ReviewJob>;
}

const mockedHandlePREvent = vi.mocked(handlePREvent);

describe("queue consumer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("acks the message when handlePREvent succeeds", async () => {
    mockedHandlePREvent.mockResolvedValue(undefined);
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("retries a transient failure (plain Error)", async () => {
    mockedHandlePREvent.mockRejectedValue(new Error("temporary network blip"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.retry).toHaveBeenCalledOnce();
    expect(message.ack).not.toHaveBeenCalled();
  });

  it("acks (does NOT retry) a PermanentError", async () => {
    mockedHandlePREvent.mockRejectedValue(new PermanentError("bad api key, never retry"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });

  it("calls surfaceFailure with willRetry=true for a transient error", async () => {
    mockedHandlePREvent.mockRejectedValue(new Error("temporary"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, false, true, 1, 3);
  });

  it("calls surfaceFailure with willRetry=false for a PermanentError", async () => {
    mockedHandlePREvent.mockRejectedValue(new PermanentError("permanent"));
    const message = makeMessage();
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, true, false, 1, 3);
  });

  it("processes multiple messages in a batch independently", async () => {
    mockedHandlePREvent
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("second fails"));

    const messageA = makeMessage({ prNumber: 1 });
    const messageB = makeMessage({ prNumber: 2 });
    const batch = makeBatch([messageA, messageB]);

    await worker.queue(batch, env);

    expect(messageA.ack).toHaveBeenCalledOnce();
    expect(messageB.retry).toHaveBeenCalledOnce();
  });

  it("does not let a failure in one message prevent processing of the next", async () => {
    mockedHandlePREvent
      .mockRejectedValueOnce(new Error("first fails"))
      .mockResolvedValueOnce(undefined);

    const messageA = makeMessage({ prNumber: 1 });
    const messageB = makeMessage({ prNumber: 2 });
    const batch = makeBatch([messageA, messageB]);

    await worker.queue(batch, env);

    expect(messageA.retry).toHaveBeenCalledOnce();
    expect(messageB.ack).toHaveBeenCalledOnce();
  });

  it("acks and reports exhaustion on the final retry attempt", async () => {
    mockedHandlePREvent.mockRejectedValue(new Error("still failing"));
    const message = makeMessage({}, /* attempts */ 3);
    const batch = makeBatch([message]);

    await worker.queue(batch, env);

    expect(surfaceFailure).toHaveBeenCalledWith(message.body, env, false, false, 3, 3);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(message.retry).not.toHaveBeenCalled();
  });
});
