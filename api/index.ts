// Vercel serverless entry point.
//
// Vercel's @vercel/node runtime expects an exported request handler, not a
// server that binds a port. This module builds the same Express app used in
// local/standalone mode (via createServerlessApp) and exports it as the
// handler. The app instance is cached across warm invocations so route
// registration + DB seeding only runs on a cold start.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createServerlessApp } from "../server/app";

process.env.NODE_ENV = process.env.NODE_ENV || "production";

let appPromise: ReturnType<typeof createServerlessApp> | null = null;

function getApp() {
  if (!appPromise) {
    appPromise = createServerlessApp();
  }
  return appPromise;
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
) {
  const app = await getApp();
  return (app as any)(req, res);
}
