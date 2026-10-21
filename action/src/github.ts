import { COMMENT_MARKER } from "@archguard/core";

export interface GitHubClientOptions {
  apiUrl: string; // e.g. https://api.github.com
  token: string;
  owner: string;
  repo: string;
  fetchImpl?: typeof fetch;
}

/**
 * Minimal GitHub REST client: the action only needs to find, create or update
 * one issue comment, so we use fetch directly instead of pulling in Octokit.
 */
export function createGitHubClient(opts: GitHubClientOptions) {
  const doFetch = opts.fetchImpl ?? fetch;
  const base = `${opts.apiUrl.replace(/\/$/, "")}/repos/${opts.owner}/${opts.repo}`;
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${opts.token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "archguard-action",
  };

  const request = async (method: string, url: string, body?: unknown) => {
    const res = await doFetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!res.ok) {
      const text = await res.text();
      const err = new Error(`GitHub API ${method} ${url.replace(base, "")} failed: ${res.status} ${text.slice(0, 200)}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    return res.status === 204 ? null : res.json();
  };

  return {
    /** Creates the ArchGuard comment, or edits the existing one so each PR has exactly one. */
    async upsertComment(issueNumber: number, body: string): Promise<{ action: "created" | "updated"; id: number }> {
      let existing: { id: number } | undefined;
      for (let page = 1; page <= 10 && !existing; page++) {
        const comments = (await request("GET", `${base}/issues/${issueNumber}/comments?per_page=100&page=${page}`)) as {
          id: number;
          body?: string;
        }[];
        existing = comments.find((c) => c.body?.includes(COMMENT_MARKER));
        if (comments.length < 100) break;
      }
      if (existing) {
        await request("PATCH", `${base}/issues/comments/${existing.id}`, { body });
        return { action: "updated", id: existing.id };
      }
      const created = (await request("POST", `${base}/issues/${issueNumber}/comments`, { body })) as { id: number };
      return { action: "created", id: created.id };
    },
  };
}
