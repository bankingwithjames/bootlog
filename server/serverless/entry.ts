// Serverless entry for Vercel (@vercel/node legacy builder).
// Exports a request handler; never binds a port. esbuild bundles this file
// and ALL ../server imports into a single self-contained CommonJS module, so
// there is nothing for Vercel to resolve at runtime.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessApp } from "../app";

let appPromise: ReturnType<typeof createServerlessApp> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = createServerlessApp();
  }
  return appPromise;
}

module.exports = async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const app = await getApp();
    return (app as any)(req, res);
  } catch (err: any) {
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "init_failed",
        message: String(err?.message || err),
        stack: String(err?.stack || "").split("\n").slice(0, 6),
      }),
    );
  }
};
