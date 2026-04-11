import pino from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const logger = pino({
  level: isDev ? "debug" : "warn",
  ...(isDev && {
    transport: {
      target: "pino-pretty",
      options: {
        colorize: true,
        translateTime: "SYS:HH:MM:ss",
        ignore: "pid,hostname",
      },
    },
  }),
});

export const SKIP_LOG_PATHS = new Set([
  "/api/chatsync/version",
  "/api/contacts",
  "/api/uns/notifications",
  "/api/chatrooms",
]);

export const SKIP_LOG_PREFIXES = [
  "/api/feed",
];
