import { z } from "zod";

const meSchema = z.object({
  id: z.string(),
  username: z.string(),
  threads_profile_picture_url: z.string().optional(),
});
export type ThreadsMe = z.infer<typeof meSchema>;

export interface ThreadsClientOptions {
  accessToken: string;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
  baseUrl?: string;
}

export function createThreadsClient(opts: ThreadsClientOptions) {
  const f = opts.fetch ?? fetch;
  const base = opts.baseUrl ?? "https://graph.threads.net/v1.0";
  const auth = { Authorization: `Bearer ${opts.accessToken}` };
  return {
    async me(): Promise<ThreadsMe> {
      const res = await f(`${base}/me?fields=id,username,threads_profile_picture_url`, {
        headers: auth,
      });
      if (!res.ok) throw new Error(`threads /me failed: ${res.status}`);
      return meSchema.parse(await res.json());
    },

    async createPost(text: string): Promise<{ id: string }> {
      const idSchema = z.object({ id: z.string() });
      const res = await f(`${base}/me/threads`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, media_type: "TEXT" }),
      });
      if (!res.ok) throw new Error(`threads createPost draft failed: ${res.status}`);
      const { id: creationId } = idSchema.parse(await res.json());
      const pub = await f(`${base}/me/threads_publish`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId }),
      });
      if (!pub.ok) throw new Error(`threads createPost publish failed: ${pub.status}`);
      return idSchema.parse(await pub.json());
    },

    async createReply(postId: string, text: string): Promise<{ id: string }> {
      const idSchema = z.object({ id: z.string() });
      const res = await f(`${base}/me/threads`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, media_type: "TEXT", reply_to_id: postId }),
      });
      if (!res.ok) throw new Error(`threads createReply draft failed: ${res.status}`);
      const { id: creationId } = idSchema.parse(await res.json());
      const pub = await f(`${base}/me/threads_publish`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId }),
      });
      if (!pub.ok) throw new Error(`threads createReply publish failed: ${pub.status}`);
      return idSchema.parse(await pub.json());
    },
  };
}

export type ThreadsClient = ReturnType<typeof createThreadsClient>;
