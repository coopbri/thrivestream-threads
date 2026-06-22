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

interface ThreadsErrorPayload {
  message?: string;
  code?: number;
  error_subcode?: number;
  is_transient?: boolean;
  error_user_title?: string;
  error_user_msg?: string;
}

/**
 * A non-2xx response from the Threads Graph API. Carries the HTTP status plus
 * the parsed Graph error fields (code/subcode/is_transient) so callers can log
 * the real reason and decide whether retrying is pointless. The message keeps
 * the `threads <op> failed: <status>` prefix and appends the human detail.
 */
export class ThreadsApiError extends Error {
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly isTransient?: boolean;

  constructor(operation: string, status: number, body: string, payload?: ThreadsErrorPayload) {
    const detail = payload?.error_user_msg ?? payload?.message ?? body;
    super(`threads ${operation} failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "ThreadsApiError";
    this.status = status;
    this.code = payload?.code;
    this.subcode = payload?.error_subcode;
    this.isTransient = payload?.is_transient;
  }
}

/**
 * True when a Threads failure will never succeed on retry because the target
 * media is gone (e.g. the creator deleted the go-live post a chat reply anchors
 * to). Media Not Found surfaces as subcode 4279009 on a reply write and subcode
 * 33 on a read. Retrying these just burns attempts.
 */
export function isPermanentThreadsError(err: unknown): boolean {
  if (!(err instanceof ThreadsApiError)) return false;
  return err.subcode === 4279009 || err.subcode === 33;
}

async function threadsFailure(operation: string, res: Response): Promise<ThreadsApiError> {
  const body = await res.text().catch(() => "");
  let payload: ThreadsErrorPayload | undefined;
  try {
    payload = (JSON.parse(body) as { error?: ThreadsErrorPayload }).error;
  } catch {
    // Non-JSON body: keep the raw text as the message detail.
  }
  return new ThreadsApiError(operation, res.status, body, payload);
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
      if (!res.ok) throw await threadsFailure("/me", res);
      return meSchema.parse(await res.json());
    },

    async createPost(text: string): Promise<{ id: string }> {
      const idSchema = z.object({ id: z.string() });
      const res = await f(`${base}/me/threads`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, media_type: "TEXT" }),
      });
      if (!res.ok) throw await threadsFailure("createPost draft", res);
      const { id: creationId } = idSchema.parse(await res.json());
      const pub = await f(`${base}/me/threads_publish`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId }),
      });
      if (!pub.ok) throw await threadsFailure("createPost publish", pub);
      return idSchema.parse(await pub.json());
    },

    async createReply(postId: string, text: string): Promise<{ id: string }> {
      const idSchema = z.object({ id: z.string() });
      const res = await f(`${base}/me/threads`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ text, media_type: "TEXT", reply_to_id: postId }),
      });
      if (!res.ok) throw await threadsFailure("createReply draft", res);
      const { id: creationId } = idSchema.parse(await res.json());
      const pub = await f(`${base}/me/threads_publish`, {
        method: "POST",
        headers: { ...auth, "Content-Type": "application/json" },
        body: JSON.stringify({ creation_id: creationId }),
      });
      if (!pub.ok) throw await threadsFailure("createReply publish", pub);
      return idSchema.parse(await pub.json());
    },
  };
}

export type ThreadsClient = ReturnType<typeof createThreadsClient>;
