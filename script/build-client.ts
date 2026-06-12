import { build as viteBuild } from "vite";
import { rm } from "node:fs/promises";

// Client-only build for Vercel. The server runs as a Vercel serverless
// function (api/index.ts), which Vercel compiles itself — so we only need
// to produce the static frontend in dist/public here.
async function buildClient() {
  await rm("dist/public", { recursive: true, force: true });
  console.log("building client...");
  await viteBuild();
}

buildClient().catch((err) => {
  console.error(err);
  process.exit(1);
});
