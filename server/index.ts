import express, { type Request, Response, NextFunction } from "express";
import session from "express-session";
import cors from "cors";
import { registerRoutes } from "./routes";
import { createServer } from "http";
import { startTcpGateway } from "./gateway/tcp";
import { getRedisClient, closeRedis } from "./redis";
import { storage } from "./storage";
import { DatabaseStorage } from "./db-storage";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db";
import { sql } from "drizzle-orm";
import path from "path";
import { botHunterMiddleware } from "./modules/bothunter/middleware";
import { botHunterEngine } from "./modules/bothunter/engine";
import { jwtAuthMiddleware } from "./middleware/jwtAuth";
import { logger, SKIP_LOG_PATHS, SKIP_LOG_PREFIXES } from "./logger";

const app = express();
const httpServer = createServer(app);

app.set("trust proxy", 1);

app.use(cors({
  origin: true,
  credentials: true,
}));

app.use('/gifts', express.static(path.join(process.cwd(), 'server/public/gifts')));

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "migxchat-secret-key-2024",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      secure: process.env.COOKIE_SECURE === "true",
      sameSite: process.env.COOKIE_SECURE === "true" ? "none" : "lax",
    },
  })
);

app.use(jwtAuthMiddleware);
app.use(botHunterMiddleware);

export function log(message: string, source = "express") {
  logger.info({ source }, message);
}

app.use((req: Request, res: Response, next: NextFunction) => {
  const reqPath = req.path;
  if (!reqPath.startsWith("/api") || SKIP_LOG_PATHS.has(reqPath) || SKIP_LOG_PREFIXES.some(p => reqPath.startsWith(p))) {
    return next();
  }

  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    const status = res.statusCode;
    const logData = { method: req.method, path: reqPath, status, responseTime: duration };
    if (status >= 500) {
      logger.error(logData);
    } else if (status >= 400) {
      logger.warn(logData);
    } else {
      logger.info(logData);
    }
  });

  next();
});

(async () => {
  // Initialize Redis (non-fatal — falls back to in-memory if unavailable)
  getRedisClient();

  // Run database migrations to ensure all tables exist.
  // If tables already exist (code 42P07), that is fine — schema is up to date
  // via db:push and the server will work correctly. Suppress the noisy error.
  try {
    await migrate(db, { migrationsFolder: path.join(process.cwd(), "migrations") });
    log("Database migrations applied", "db");
  } catch (err: any) {
    if (err?.code === "42P07") {
      log("Database schema already up to date", "db");
    } else {
      console.error("Database migration error:", err);
    }
  }

  // Ensure is_admin column exists (safe to run on every startup via IF NOT EXISTS)
  try {
    await db.execute(sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin boolean NOT NULL DEFAULT false`);
    log("Column is_admin ensured on users table", "db");
  } catch (err) {
    console.error("Column ensure error:", err);
  }

  // Ensure new merchant columns exist (mirrors Java MerchantDetailsData & MerchantTagData fields)
  try {
    await db.execute(sql`
      ALTER TABLE merchants
        ADD COLUMN IF NOT EXISTS username_color_type integer NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS merchant_type integer NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS mentor text,
        ADD COLUMN IF NOT EXISTS referrer text
    `);
    await db.execute(sql`
      ALTER TABLE merchant_locations
        ADD COLUMN IF NOT EXISTS country_id integer,
        ADD COLUMN IF NOT EXISTS country text
    `);
    await db.execute(sql`
      ALTER TABLE merchant_points
        ADD COLUMN IF NOT EXISTS type integer NOT NULL DEFAULT 1
    `);
    await db.execute(sql`
      ALTER TABLE merchant_tags
        ADD COLUMN IF NOT EXISTS amount double precision,
        ADD COLUMN IF NOT EXISTS currency text,
        ADD COLUMN IF NOT EXISTS account_entry_id varchar
    `);
    log("Merchant schema columns ensured", "db");
  } catch (err) {
    console.error("Merchant column ensure error:", err);
  }

  // Migrate existing credit accounts and transactions from USD to IDR
  try {
    await db.execute(sql`UPDATE credit_accounts SET currency = 'IDR' WHERE currency = 'USD'`);
    await db.execute(sql`UPDATE credit_transactions SET currency = 'IDR' WHERE currency = 'USD'`);
    log("Credit currency migrated from USD to IDR", "db");
  } catch (err) {
    console.error("Credit currency migration error:", err);
  }

  // Update gift image URLs for existing gifts (idempotent)
  try {
    await db.execute(sql`
      UPDATE virtual_gifts
      SET location_64x64_png = '/gifts/rose.png',
          location_16x16_png = '/gifts/rose.png'
      WHERE name = 'rose' AND (location_64x64_png IS NULL OR location_64x64_png != '/gifts/rose.png')
    `);
    log("Gift image URLs updated", "db");
  } catch (err) {
    console.error("Gift image URL update error:", err);
  }

  // Seed default data to database on first boot
  if (storage instanceof DatabaseStorage) {
    try {
      await storage.seed();
      log("Database seeded successfully", "db");
    } catch (err) {
      console.error("Database seed error:", err);
    }
  }

  await registerRoutes(httpServer, app);

  botHunterEngine.start();

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";
    logger.error({ err, status }, "Internal Server Error");
    if (res.headersSent) return next(err);
    return res.status(status).json({ message });
  });

  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    { port, host: "0.0.0.0", reusePort: true },
    () => { log(`serving on port ${port}`); }
  );

  startTcpGateway();

  // Graceful shutdown — matches RedisConnectionManager.shutdown() in backend app
  process.on("SIGTERM", async () => {
    botHunterEngine.stop();
    await closeRedis();
    process.exit(0);
  });
  process.on("SIGINT", async () => {
    botHunterEngine.stop();
    await closeRedis();
    process.exit(0);
  });
})();
