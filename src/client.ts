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
  /** Poll interval (ms) while waiting for a media container to finish processing. */
  pollIntervalMs?: number;
  /** Max status polls before giving up on a container (then the publish is retried). */
  pollMaxAttempts?: number;
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
 * A non-2xx response from the Threads Graph API. Carries the operation, HTTP
 * status and parsed Graph error fields (code/subcode/is_transient) so callers
 * can log the real reason and decide whether retrying is pointless. The message
 * keeps the `threads <op> failed: <status>` prefix and appends the human detail.
 */
export class ThreadsApiError extends Error {
  readonly operation: string;
  readonly status: number;
  readonly code?: number;
  readonly subcode?: number;
  readonly isTransient?: boolean;

  constructor(operation: string, status: number, body: string, payload?: ThreadsErrorPayload) {
    const detail = payload?.error_user_msg ?? payload?.message ?? body;
    super(`threads ${operation} failed: ${status}${detail ? ` ${detail}` : ""}`);
    this.name = "ThreadsApiError";
    this.operation = operation;
    this.status = status;
    this.code = payload?.code;
    this.subcode = payload?.error_subcode;
    this.isTransient = payload?.is_transient;
  }
}

/**
 * True when a Threads failure will never succeed on retry because the reply
 * anchor is gone: the creator deleted the go-live post a chat reply points at.
 * Only the DRAFT step validates `reply_to_id`, so a Media Not Found (subcode
 * 4279009, or 33 on a read) there is permanent. A not-found at the publish step
 * is the media container still processing, which is transient (handled by
 * status polling), so it must NOT be classified permanent.
 */
export function isPermanentThreadsError(err: unknown): boolean {
  if (!(err instanceof ThreadsApiError)) return false;
  if (!err.operation.includes("draft")) return false;
  return err.subcode === 4279009 || err.subcode === 33;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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
  const pollIntervalMs = opts.pollIntervalMs ?? 1500;
  const pollMaxAttempts = opts.pollMaxAttempts ?? 10;
  const idSchema = z.object({ id: z.string() });
  const statusSchema = z.object({ status: z.string().optional(), error_message: z.string().optional() });

  // A freshly created media container is IN_PROGRESS for a few seconds; publishing
  // it before it is FINISHED fails with "media cannot be found". Poll its status
  // until FINISHED (the documented Threads two-step publish flow) before publishing.
  async function waitForContainer(creationId: string, operation: string): Promise<void> {
    for (let attempt = 0; attempt < pollMaxAttempts; attempt++) {
      const res = await f(`${base}/${creationId}?fields=status,error_message`, { headers: auth });
      if (res.ok) {
        const { status, error_message } = statusSchema.parse(await res.json());
        if (status === "FINISHED") return;
        if (status === "ERROR" || status === "EXPIRED") {
          throw new Error(`threads ${operation} container ${status}: ${error_message ?? "unknown"}`);
        }
      }
      if (attempt < pollMaxAttempts - 1) await sleep(pollIntervalMs);
    }
    // Still not FINISHED: surface as a transient failure so the caller retries.
    throw new ThreadsApiError(`${operation} container not ready`, 504, "container did not finish");
  }

  async function createContainer(operation: string, payload: Record<string, unknown>): Promise<string> {
    const res = await f(`${base}/me/threads`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw await threadsFailure(`${operation} draft`, res);
    return idSchema.parse(await res.json()).id;
  }

  async function publishContainer(operation: string, creationId: string): Promise<{ id: string }> {
    await waitForContainer(creationId, operation);
    const pub = await f(`${base}/me/threads_publish`, {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ creation_id: creationId }),
    });
    if (!pub.ok) throw await threadsFailure(`${operation} publish`, pub);
    return idSchema.parse(await pub.json());
  }

  return {
    async me(): Promise<ThreadsMe> {
      const res = await f(`${base}/me?fields=id,username,threads_profile_picture_url`, {
        headers: auth,
      });
      if (!res.ok) throw await threadsFailure("/me", res);
      return meSchema.parse(await res.json());
    },

    async createPost(text: string): Promise<{ id: string }> {
      const creationId = await createContainer("createPost", { text, media_type: "TEXT" });
      return publishContainer("createPost", creationId);
    },

    async createReply(postId: string, text: string): Promise<{ id: string }> {
      const creationId = await createContainer("createReply", {
        text,
        media_type: "TEXT",
        reply_to_id: postId,
      });
      return publishContainer("createReply", creationId);
    },
  };
}

export type ThreadsClient = ReturnType<typeof createThreadsClient>;
