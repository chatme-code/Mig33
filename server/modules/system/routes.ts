import type { Express, Request, Response } from "express";
import { broadcastAlertToAll, getGatewayStats } from "../../gateway";
import { getTcpClientCount } from "../../gateway/tcp";
import { redisHealthCheck, isRedisAvailable } from "../../redis";
import { storage } from "../../storage";

const START_TIME = Date.now();

export function registerSystemRoutes(app: Express): void {
  app.get("/api/system/health", async (_req: Request, res: Response) => {
    const uptime = Math.floor((Date.now() - START_TIME) / 1000);
    const redis  = await redisHealthCheck();
    return res.status(200).json({
      status: "UP",
      service: "Migme Fusion API",
      version: "9.0.0",
      uptime,
      timestamp: new Date().toISOString(),
      redis: {
        status:    redis.status,
        latencyMs: redis.latencyMs ?? null,
      },
    });
  });

  app.get("/api/system/status", (_req: Request, res: Response) => {
    return res.status(200).json({
      api:         "UP",
      gateway_ws:  "UP",
      gateway_tcp: process.env.TCP_PORT ? "UP" : "DISABLED",
      redis:       isRedisAvailable() ? "UP" : "UNAVAILABLE",
      database:    "MEMORY",
      version:     "9.0.0",
      environment: process.env.NODE_ENV || "development",
    });
  });

  app.get("/api/system/info", (_req: Request, res: Response) => {
    return res.status(200).json({
      project:      "com.projectgoth.fusion",
      artifactId:   "Fusion",
      version:      "9.0.0",
      javaEquivalent: "Spring Boot 3.3.1",
      nodeVersion:  process.version,
      platform:     process.platform,
      modules: [
        "auth", "feed", "profile", "system",
        "chatroom", "room", "lost", "merchant",
        "merchant-tag", "discovery", "credit",
      ],
      gateway: {
        http:    true,
        websocket: true,
        tcp:     !!process.env.TCP_PORT,
        tcpPort: process.env.TCP_PORT || "5001",
      },
      cache: {
        redis:     isRedisAvailable(),
        redisHost: process.env.REDIS_HOST || "127.0.0.1",
        redisPort: parseInt(process.env.REDIS_PORT || "6379", 10),
      },
    });
  });

  // ── Gateway admin endpoints (matches GatewayAdminI in backend app) ──────────

  // Matches GatewayAdminI.getStats() — returns connection counts and event totals
  app.get("/api/system/gateway/stats", (_req: Request, res: Response) => {
    const ws  = getGatewayStats();
    const tcp = getTcpClientCount();
    return res.status(200).json({
      ws: {
        connections:   ws.connections,
        authenticated: ws.authenticated,
        totalEvents:   ws.totalEvents,
      },
      tcp: {
        connections: tcp,
      },
      totalConnections: ws.connections + tcp,
    });
  });

  // Matches GatewayAdminI.sendAlertToAllConnections() — broadcast alert to all WS clients
  app.post("/api/system/gateway/alert", (req: Request, res: Response) => {
    const { title, message } = req.body as { title?: string; message?: string };
    if (!title || !message) {
      return res.status(400).json({ error: "title dan message wajib diisi" });
    }
    broadcastAlertToAll(title, message);
    const stats = getGatewayStats();
    return res.status(200).json({
      ok:         true,
      dispatched: stats.authenticated,
      title,
      message,
    });
  });

  // ── Global Admin Management ─────────────────────────────────────────────────
  // POST /api/system/admin/grant — grant global admin to a user
  // Requires caller to be a global admin (or no admins exist yet — bootstrap)
  app.post("/api/system/admin/grant", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const caller = await storage.getUser(req.session.userId);
    if (!caller) return res.status(401).json({ message: "Invalid session." });

    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) {
      return res.status(403).json({ message: "Only an existing global admin can grant admin rights." });
    }

    const { username } = req.body as { username?: string };
    if (!username) return res.status(400).json({ message: "username wajib diisi." });

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    await storage.setGlobalAdmin(target.id, true);
    return res.status(200).json({ message: `${username} is now a global admin.`, username, isAdmin: true });
  });

  // POST /api/system/admin/revoke — revoke global admin from a user
  app.post("/api/system/admin/revoke", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const callerIsAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (!callerIsAdmin) {
      return res.status(403).json({ message: "Only an existing global admin can revoke admin rights." });
    }

    const { username } = req.body as { username?: string };
    if (!username) return res.status(400).json({ message: "username wajib diisi." });

    const target = await storage.getUserByUsername(username);
    if (!target) return res.status(404).json({ message: `User '${username}' not found.` });

    if (target.id === req.session.userId) {
      return res.status(400).json({ message: "You cannot revoke your own admin rights." });
    }

    await storage.setGlobalAdmin(target.id, false);
    return res.status(200).json({ message: `${username} is no longer a global admin.`, username, isAdmin: false });
  });

  // POST /api/system/admin/bootstrap — first-time setup: grant self admin (only if NO admin exists yet)
  app.post("/api/system/admin/bootstrap", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const caller = await storage.getUser(req.session.userId);
    if (!caller) return res.status(401).json({ message: "Invalid session." });

    const alreadyAdmin = await storage.isGlobalAdmin(req.session.userId);
    if (alreadyAdmin) return res.status(409).json({ message: "You are already a global admin." });

    await storage.setGlobalAdmin(req.session.userId, true);
    return res.status(200).json({
      message: `Bootstrap successful. ${caller.username} is now a global admin.`,
      username: caller.username,
      isAdmin: true,
    });
  });

  // GET /api/system/admin/check — check if current user is a global admin
  app.get("/api/system/admin/check", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in." });
    const isAdmin = await storage.isGlobalAdmin(req.session.userId);
    const caller = await storage.getUser(req.session.userId);
    return res.status(200).json({ username: caller?.username, isAdmin });
  });
}
