import "./load-env"; // MUST be first: loads .env.local (override) then .env before any env read
import express, { Response, NextFunction } from "express";
import type { Request, Express } from "express";
import { registerRoutes } from "./routes";
import { createServer, Server } from "node:http";

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });
  console.log(`${formattedTime} [${source}] ${message}`);
}

// Build and fully configure the Express app + http server.
// Used by both the standalone server (server/index.ts) and the
// Vercel serverless entry point (api/index.ts).
export async function createApp(): Promise<{ app: Express; httpServer: Server }> {
  const app = express();
  const httpServer = createServer(app);

  // Evidence photos are sent inline as base64 data URLs inside the JSON body.
  // Raise the body limit well beyond the default 100kb to avoid 413 errors.
  app.use(
    express.json({
      limit: "25mb",
      verify: (req, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: "25mb" }));

  app.use((req, res, next) => {
    const start = Date.now();
    const path = req.path;
    let capturedJsonResponse: Record<string, any> | undefined = undefined;

    const originalResJson = res.json;
    res.json = function (bodyJson, ...args) {
      capturedJsonResponse = bodyJson;
      return originalResJson.apply(res, [bodyJson, ...args]);
    };

    res.on("finish", () => {
      const duration = Date.now() - start;
      if (path.startsWith("/api")) {
        let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
        if (capturedJsonResponse) {
          logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
        }
        log(logLine);
      }
    });

    next();
  });

  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    console.error("Internal Server Error:", err);
    if (res.headersSent) {
      return next(err);
    }
    return res.status(status).json({ message });
  });

  return { app, httpServer };
}

// Serverless app for Vercel. Static assets (and the SPA index.html fallback)
// are served by Vercel's CDN via vercel.json routing, so this app only needs
// to handle /api/* routes — no filesystem static serving here.
export async function createServerlessApp(): Promise<Express> {
  const { app } = await createApp();
  return app;
}
