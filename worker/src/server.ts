/**
 * Node.js entry point — used when running on the Raspberry Pi.
 * The Cloudflare Worker (src/index.ts) is unchanged; this just
 * adapts it to run under Node.js via @hono/node-server.
 *
 * Start:  npm run start          (dev, ts-node)
 * Deploy: npm run build && npm run start:prod
 */
import { serve } from "@hono/node-server";
import app from "./index.js";

const port = Number(process.env.PORT ?? 3000);

serve({ fetch: app.fetch, port }, () => {
  console.log(`Cleanstagram backend running on http://localhost:${port}`);
});
