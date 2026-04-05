# cleanstagram

Instagram home feed, cleaned up. No ads, no suggested posts, no explore — just the people you follow.

## Features

- ✅ Clean chronological feed (newest first, no ads/suggestions)
- ✅ Stories with video playback and seen-state tracking
- ✅ Video posts with autoplay-in-viewport
- ✅ Offline-capable with stale-while-revalidate cache
- ✅ Pull-to-refresh + auto-refresh on tab focus
- ✅ Lazy-loaded comments per post
- ✅ "You're up to date" divider between new and seen posts
- ✅ PWA-installable on mobile (Add to Home Screen)
- ✅ Session code export — share your session to other devices easily

---

## Local Development

**Terminal 1 — Worker (API):**
```bash
cd worker
npm install
npm run dev
# API available at http://localhost:8787
```

**Terminal 2 — Web (Frontend):**
```bash
cd web
npm install
npm run dev
# App available at http://localhost:5173
```

The web app talks to the Worker at `http://localhost:8787` by default (set in `web/.env.development`).

---

## Deployment to Cloudflare

### Step 1 — Deploy the Worker

```bash
cd worker
npm install
npm run deploy
```

Note the URL printed after deploy — it looks like:
```
https://cleanstagram-worker.<your-subdomain>.workers.dev
```

### Step 2 — Build the Frontend

```bash
cd web
npm install
VITE_API_URL=https://cleanstagram-worker.<your-subdomain>.workers.dev npm run build
```

This produces a `web/dist/` folder.

### Step 3 — Deploy to Cloudflare Pages

**Option A — Wrangler CLI (fastest):**
```bash
cd web
npx wrangler pages deploy dist --project-name cleanstagram
```

**Option B — Cloudflare Dashboard:**
1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Pages → Create project
2. Connect your GitHub repo (or use Direct Upload)
3. Set build command: `npm run build`
4. Set build output directory: `dist`
5. Add environment variable: `VITE_API_URL` = your Worker URL from Step 1

### Step 4 — (Optional) Custom Domain

In the Cloudflare Pages dashboard, add a custom domain under your project settings.

---

## First-Time Setup (Login)

Cleanstagram uses your existing Instagram session — no passwords are stored.

### Desktop (recommended for first setup)

1. Open [instagram.com](https://instagram.com) and log in
2. Open DevTools (F12 / ⌥⌘I) → Network tab → reload
3. Click the first request to `www.instagram.com`
4. Find the `cookie` request header → right-click → Copy value
5. Paste it into Cleanstagram's login screen

### Mobile

Sessions last for weeks, so the easiest approach is:
1. Set up on a desktop browser first (see above)
2. Tap **Share** in the top bar to export a session code
3. Open Cleanstagram on your phone, tap **"I have a session code"**, paste the code

---

## Architecture

```
cleanstagram/
├── worker/          Cloudflare Worker (Hono) — API proxy to Instagram
│   └── src/
│       ├── index.ts     Routes: /api/feed, /api/stories, /api/comments, /api/proxy/image
│       ├── feed.ts      Instagram timeline API → FeedPost normalization
│       ├── stories.ts   Instagram stories tray + per-user story fetch
│       ├── comments.ts  Instagram comments API
│       └── auth.ts      Login proxy flow
│
└── web/             React + Vite + Tailwind — frontend
    └── src/
        ├── App.tsx         Session management
        ├── api.ts          API client (typed wrappers)
        ├── lib/
        │   └── storage.ts  localStorage: feed cache, seen posts, seen stories
        ├── pages/
        │   ├── FeedPage.tsx   Main feed with pull-to-refresh, infinite scroll
        │   └── LoginPage.tsx  Cookie import + session code flow
        └── components/
            ├── PostCard.tsx       Post card with video, carousel, comments
            ├── CommentsSection.tsx Lazy-loaded comments
            ├── StoriesRow.tsx     Horizontal stories tray
            └── StoryViewer.tsx    Full-screen story viewer with video
```

All session data stays in the browser (`localStorage`). The Worker is stateless.
