import { build as esbuild } from "esbuild";
import { build as viteBuild } from "vite";
import { rm, readFile, mkdir, writeFile } from "node:fs/promises";

// Vercel build: produces a self-contained serverless function so Vercel's
// bundler never has to resolve our deep server import graph. Mirrors the
// allowlist strategy in build.ts for fast cold starts.
const allowlist = [
  "@google/generative-ai",
  "axios",
  "cors",
  "date-fns",
  "drizzle-orm",
  "drizzle-zod",
  "express",
  "express-rate-limit",
  "express-session",
  "jsonwebtoken",
  "memorystore",
  "multer",
  "nanoid",
  "nodemailer",
  "openai",
  "passport",
  "passport-local",
  "stripe",
  "uuid",
  "ws",
  "xlsx",
  "zod",
  "zod-validation-error",
];

async function buildAll() {
  await rm("dist", { recursive: true, force: true });

  console.log("building client...");
  await viteBuild();

  console.log("building serverless function...");
  const pkg = JSON.parse(await readFile("package.json", "utf-8"));
  const allDeps = [
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
  ];
  const externals = allDeps.filter((dep) => !allowlist.includes(dep));

  await mkdir("api", { recursive: true });

  // Bundle the handler + ALL ../server imports into one self-contained CJS
  // module at dist/server.cjs. The tiny api/[[...path]].js shim re-exports it;
  // Vercel traces the require and includes the bundle. Because the heavy code
  // lives in dist/server.cjs (not directly in /api), Vercel's @vercel/node
  // builder does not re-bundle our import graph — it just includes the file.
  await esbuild({
    entryPoints: ["server/serverless/entry.ts"],
    platform: "node",
    bundle: true,
    format: "cjs",
    outfile: "dist/server.cjs",
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    minify: true,
    external: externals,
    logLevel: "info",
  });

  // Tiny catch-all shim that Vercel detects as the function. It requires the
  // prebuilt, fully-bundled handler. include_files ensures the bundle ships.
  await writeFile(
    "api/[[...path]].js",
    'module.exports = require("../dist/server.cjs");\n',
  );
}

buildAll().catch((err) => {
  console.error(err);
  process.exit(1);
});
