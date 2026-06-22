import { describe, expect, it, mock } from "bun:test";
import { ThreadsApiError, createThreadsClient, isPermanentThreadsError } from "./client";

describe("threads client", () => {
  it("fetches /me with bearer token", async () => {
    const fetcher = mock(async (url: string, init: RequestInit) => {
      expect(url).toBe(
        "https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url",
      );
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-token");
      return new Response(
        JSON.stringify({ id: "123", username: "coop", threads_profile_picture_url: "x" }),
        { status: 200 },
      );
    });
    const client = createThreadsClient({ accessToken: "test-token", fetch: fetcher });
    const me = await client.me();
    expect(me.id).toBe("123");
    expect(me.username).toBe("coop");
  });

  // The real Threads body for replying to a deleted post (captured from prod).
  const MEDIA_NOT_FOUND = JSON.stringify({
    error: {
      message: "The requested resource does not exist",
      type: "OAuthException",
      code: 24,
      error_subcode: 4279009,
      is_transient: false,
      error_user_title: "Media Not Found",
      error_user_msg: "The media with id 18002364578939674 cannot be found.",
    },
  });

  it("createReply throws ThreadsApiError carrying status, code, subcode and body detail", async () => {
    const fetcher = mock(async () => new Response(MEDIA_NOT_FOUND, { status: 400 }));
    const client = createThreadsClient({ accessToken: "t", fetch: fetcher });
    const err = await client.createReply("18002364578939674", "x: hi").catch((e) => e);
    expect(err).toBeInstanceOf(ThreadsApiError);
    expect(err.status).toBe(400);
    expect(err.code).toBe(24);
    expect(err.subcode).toBe(4279009);
    expect(err.isTransient).toBe(false);
    expect(err.message).toContain("createReply draft failed: 400");
    expect(err.message).toContain("cannot be found");
  });

  it("isPermanentThreadsError is true for a deleted anchor at the draft step only", () => {
    // Draft-step media-not-found = the reply anchor (go-live post) is gone.
    const deletedAnchor = new ThreadsApiError("createReply draft", 400, MEDIA_NOT_FOUND, {
      code: 24,
      error_subcode: 4279009,
      is_transient: false,
    });
    expect(isPermanentThreadsError(deletedAnchor)).toBe(true);
    // Publish-step media-not-found = the container still processing: transient,
    // must NOT be permanent or we'd wrongly drop the stream's post id.
    const containerNotReady = new ThreadsApiError("createReply publish", 400, "", {
      code: 24,
      error_subcode: 4279009,
      is_transient: false,
    });
    expect(isPermanentThreadsError(containerNotReady)).toBe(false);
    // A generic transient 500 should still be retried.
    const transient = new ThreadsApiError("createReply draft", 500, "", { is_transient: true });
    expect(isPermanentThreadsError(transient)).toBe(false);
    // Non-Threads errors are never treated as permanent.
    expect(isPermanentThreadsError(new Error("network down"))).toBe(false);
  });

  it("createReply waits for the container to finish before publishing", async () => {
    let statusCalls = 0;
    const fetcher = mock(async (url: string, init: RequestInit) => {
      if (url.endsWith("/me/threads") && init.method === "POST") {
        return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
      }
      if (url.includes("/container-1?fields=status")) {
        statusCalls++;
        // IN_PROGRESS on the first poll, FINISHED on the second.
        return new Response(JSON.stringify({ status: statusCalls === 1 ? "IN_PROGRESS" : "FINISHED" }), {
          status: 200,
        });
      }
      if (url.endsWith("/me/threads_publish") && init.method === "POST") {
        return new Response(JSON.stringify({ id: "published-1" }), { status: 200 });
      }
      throw new Error(`unexpected url ${url}`);
    });
    const client = createThreadsClient({ accessToken: "t", fetch: fetcher, pollIntervalMs: 0 });
    const result = await client.createReply("anchor-1", "x: hi");
    expect(result.id).toBe("published-1");
    expect(statusCalls).toBeGreaterThanOrEqual(2);
  });
});
