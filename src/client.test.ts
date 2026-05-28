import { describe, expect, it, mock } from "bun:test";
import { createThreadsClient } from "./client";

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
});
