const IG_BASE = "https://www.instagram.com";

const HEADERS_BASE = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "X-IG-App-ID": "936619743392459",
  "X-ASBD-ID": "198387",
  "Accept-Language": "en-US,en;q=0.9",
  Origin: IG_BASE,
  Referer: `${IG_BASE}/`,
};

export interface Comment {
  id: string;
  text: string;
  timestamp: number;
  user: {
    id: string;
    username: string;
    profilePicUrl: string;
  };
}

export interface CommentsResponse {
  comments: Comment[];
  nextMinId: string | null;
}

export async function getComments(
  sessionId: string,
  csrfToken: string,
  mediaId: string,
  minId?: string,
  dsUserId?: string
): Promise<CommentsResponse> {
  const url = new URL(`${IG_BASE}/api/v1/media/${mediaId}/comments/`);
  if (minId) url.searchParams.set("min_id", minId);
  url.searchParams.set("can_support_threading", "true");

  const cookieParts = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    ...(dsUserId ? [`ds_user_id=${dsUserId}`] : []),
  ];

  const res = await fetch(url.toString(), {
    redirect: "manual",
    headers: {
      ...HEADERS_BASE,
      Accept: "*/*",
      "X-CSRFToken": csrfToken,
      Cookie: cookieParts.join("; "),
    },
  });

  if (res.status >= 300 && res.status < 400) throw new Error("UNAUTHORIZED");
  if (res.status === 401 || res.status === 403) throw new Error("UNAUTHORIZED");
  if (!res.ok) throw new Error(`Comments request failed: ${res.status}`);

  const data = (await res.json()) as {
    comments?: unknown[];
    next_min_id?: string;
    status: string;
  };

  const raw = (data.comments ?? []) as Record<string, unknown>[];
  const comments = raw
    .map(normalizeComment)
    .filter((c): c is Comment => c !== null);

  return { comments, nextMinId: data.next_min_id ?? null };
}

function normalizeComment(raw: Record<string, unknown>): Comment | null {
  const user = raw.user as Record<string, unknown> | undefined;
  if (!user?.username) return null;

  return {
    id: String(raw.pk ?? raw.id ?? ""),
    text: String(raw.text ?? ""),
    timestamp: Number(raw.created_at ?? 0),
    user: {
      id: String(user.pk ?? user.id ?? ""),
      username: String(user.username),
      profilePicUrl: String(user.profile_pic_url ?? ""),
    },
  };
}
