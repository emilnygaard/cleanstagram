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

export async function likeMedia(
  sessionId: string,
  csrfToken: string,
  mediaId: string,
  unlike: boolean,
  dsUserId?: string
): Promise<void> {
  const action = unlike ? "unlike" : "like";
  const url = `${IG_BASE}/api/v1/media/${mediaId}/${action}/`;

  const cookieParts = [
    `sessionid=${sessionId}`,
    `csrftoken=${csrfToken}`,
    ...(dsUserId ? [`ds_user_id=${dsUserId}`] : []),
  ];

  const res = await fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      ...HEADERS_BASE,
      Accept: "*/*",
      "Content-Type": "application/x-www-form-urlencoded",
      "X-CSRFToken": csrfToken,
      Cookie: cookieParts.join("; "),
    },
    body: `media_id=${mediaId}&src=feed_timeline`,
  });

  if (res.status === 301 || res.status === 302 || res.status === 303) {
    throw new Error("UNAUTHORIZED");
  }
  if (res.status === 401 || res.status === 403) {
    throw new Error("UNAUTHORIZED");
  }
  if (!res.ok) {
    throw new Error(`Like request failed: ${res.status}`);
  }
}
