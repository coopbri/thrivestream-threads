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

  it("isPermanentThreadsError is true for a deleted anchor post, false otherwise", () => {
    const deleted = new ThreadsApiError("createReply draft", 400, MEDIA_NOT_FOUND, {
      code: 24,
      error_subcode: 4279009,
      is_transient: false,
    });
    expect(isPermanentThreadsError(deleted)).toBe(true);
    // A generic transient 500 should still be retried.
    const transient = new ThreadsApiError("createReply draft", 500, "", { is_transient: true });
    expect(isPermanentThreadsError(transient)).toBe(false);
    // Non-Threads errors are never treated as permanent.
    expect(isPermanentThreadsError(new Error("network down"))).toBe(false);
  });
});
