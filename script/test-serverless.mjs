// Reproduce the Vercel serverless cold-start locally to surface the real error.
import { createServerlessApp } from "../server/app.ts";

process.env.NODE_ENV = "production";

try {
  console.log("Building serverless app...");
  const app = await createServerlessApp();
  console.log("App built OK. Simulating GET /api/auth/me ...");

  const http = await import("node:http");
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
  console.log("Status:", res.status);
  console.log("Body:", (await res.text()).slice(0, 300));
  server.close();
  process.exit(0);
} catch (err) {
  console.error("COLD START / REQUEST ERROR:");
  console.error(err);
  process.exit(1);
}
