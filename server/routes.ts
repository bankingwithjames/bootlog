import type { Express } from "express";
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { storage } from "./storage";
import { insertBootSchema } from "@shared/schema";
import { fromZodError } from "zod-validation-error";

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  app.get("/api/boots", async (_req, res) => {
    const boots = await storage.getBoots();
    res.json(boots);
  });

  app.post("/api/boots", async (req, res) => {
    const parsed = insertBootSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: fromZodError(parsed.error).toString() });
    }
    const boot = await storage.createBoot(parsed.data);
    res.status(201).json(boot);
  });

  app.delete("/api/boots/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (Number.isNaN(id)) {
      return res.status(400).json({ message: "Invalid id" });
    }
    const result = await storage.deleteBoot(id);
    if (result.changes === 0) {
      return res.status(404).json({ message: "Boot not found" });
    }
    res.status(204).end();
  });

  return httpServer;
}
