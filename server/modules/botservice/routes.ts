import type { Express, Request, Response } from "express";
import { startBot, stopBot, getBot, listActiveBots } from "./botService";
import { GAME_TYPES, GameType } from "./types";
import { botServiceAdmin } from "./BotServiceAdminI";
import { getGames } from "./BotChannelHelper";

export function registerBotServiceRoutes(app: Express): void {

  app.get("/api/botservice/games", (_req: Request, res: Response) => {
    res.json({ games: GAME_TYPES });
  });

  app.get("/api/botservice/active", (_req: Request, res: Response) => {
    res.json({ bots: listActiveBots() });
  });

  app.get("/api/botservice/rooms/:roomId", (req: Request, res: Response) => {
    const bot = getBot(req.params.roomId);
    if (!bot) return res.status(404).json({ message: "No active bot in this room" });
    return res.json({ roomId: req.params.roomId, gameType: bot.gameType, instanceId: bot.instanceId });
  });

  app.post("/api/botservice/rooms/:roomId/start", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const { gameType } = req.body as { gameType?: string };
    if (!gameType || !GAME_TYPES.includes(gameType as GameType)) {
      return res.status(400).json({ message: `Invalid gameType. Valid: ${GAME_TYPES.join(", ")}` });
    }
    try {
      const user = (req as any).user ?? { username: req.session.userId };
      const username: string = user.username ?? req.session.userId as string;
      const bot = await startBot(req.params.roomId, gameType as GameType, username);
      return res.status(201).json({
        message: "Bot started",
        roomId:     req.params.roomId,
        gameType:   bot.gameType,
        instanceId: bot.instanceId,
      });
    } catch (err: any) {
      return res.status(409).json({ message: err.message ?? "Could not start bot" });
    }
  });

  app.delete("/api/botservice/rooms/:roomId", (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Not logged in" });
    const stopped = stopBot(req.params.roomId);
    if (!stopped) return res.status(404).json({ message: "No active bot in this room" });
    return res.json({ message: "Bot stopped" });
  });

  // ── Admin endpoints ─────────────────────────────────────────────────────────
  // Mirrors: BotServiceAdminI.getStats() and BotServiceAdminI.ping()

  // GET /api/botservice/admin/stats — statistik lengkap BotService
  app.get("/api/botservice/admin/stats", (_req: Request, res: Response) => {
    return res.json({ stats: botServiceAdmin.getStats() });
  });

  // GET /api/botservice/admin/ping — health check, kembalikan jumlah bot aktif
  app.get("/api/botservice/admin/ping", (_req: Request, res: Response) => {
    return res.json({ numBotObjects: botServiceAdmin.ping() });
  });

  // GET /api/botservice/admin/games — daftar game dari BotChannelHelper.getGames()
  app.get("/api/botservice/admin/games", (_req: Request, res: Response) => {
    return res.json({ games: getGames() });
  });
}
