// Vercel serverless entry point (compiled by Vercel's @vercel/node runtime).
import type { IncomingMessage, ServerResponse } from "node:http";

let appPromise: Promise<any> | null = null;
let initError: Error | null = null;

async function getApp() {
  if (!appPromise) {
    appPromise = (async () => {
      const { createServerlessApp } = await import("../server/app");
      return createServerlessApp();
    })().catch((err) => {
      initError = err as Error;
      throw err;
    });
  }
  return appPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  try {
    const app = await getApp();
    return (app as any)(req, res);
  } catch (err: any) {
    // Surface the real cold-start error instead of a generic 500 so we can
    // diagnose runtime-only failures on Vercel.
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        error: "init_failed",
        message: String(err?.message || err),
        stack: String(err?.stack || "").split("\n").slice(0, 5),
        init: String(initError?.message || ""),
      }),
    );
  }
}
