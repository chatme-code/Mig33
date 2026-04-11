import type { Express, Request, Response } from "express";

const SUPPORTED_COMMANDS: Record<string, string> = {
  migStore: "Buka Mig Store",
  joinChatroom: "Masuk ke chatroom berdasarkan ID",
  searchTopic: "Cari topik / hot topic",
  privateChat: "Mulai private chat dengan username",
  joinGroupChatroom: "Masuk ke group chatroom (roomId, linkedId)",
  showGroup: "Tampilkan halaman grup berdasarkan groupId",
  chat: "Tampilkan daftar chatroom",
  login: "Tampilkan halaman login",
  url: "Buka URL di browser",
  profile: "Tampilkan profil user berdasarkan username",
  mygroups: "Tampilkan grup saya",
  groupList: "Tampilkan daftar semua grup",
  migWorld: "Buka migWorld browser",
  hotTopics: "Tampilkan hot topics",
  recommendedUsers: "Tampilkan rekomendasi user",
  logout: "Lakukan logout",
  ssologin: "SSO login (Facebook, dll)",
  ssologinFiksu: "SSO login via Fiksu",
  syncPhoneAddressBook: "Sinkronisasi phonebook",
  showPost: "Tampilkan post (postId, isGroup?)",
  share: "Tampilkan sharebox dengan konten",
  sendGift: "Kirim gift (recipient, giftId, context?)",
  showFollowers: "Tampilkan daftar followers",
  showBadges: "Tampilkan daftar badges",
  showInviteFriends: "Tampilkan halaman invite teman",
  goGamePage: "Buka Game Centre",
  auth: "Autentikasi session",
  closeBrowser: "Tutup browser in-app",
  showChatroomUsers: "Tampilkan daftar user di chatroom",
  showFriends: "Tampilkan daftar teman",
  friend: "Tampilkan daftar teman",
  groupChat: "Mulai group chat",
  help: "Tampilkan halaman bantuan",
  showIMManager: "Tampilkan IM manager",
  mentions: "Tampilkan mentions",
  invokeNativeBrowser: "Buka native browser",
  showPhoneBook: "Tampilkan phonebook",
  recommendations: "Tampilkan rekomendasi",
  settings: "Buka pengaturan",
  updateStatus: "Update status",
  watchlist: "Tampilkan watchlist",
};

const MIG_CMD_PATTERN = /^mig33:([a-zA-Z0-9_]+)(?:\((['"]?)([^)]*)\2\))?$/;

function parseMigCommandUrl(url: string): { command: string; params: string[] } | null {
  const trimmed = url.trim();
  const m = MIG_CMD_PATTERN.exec(trimmed);
  if (!m) return null;

  const command = m[1];
  const rawParams = m[3] ?? "";

  let params: string[] = [];
  if (rawParams.trim().length > 0) {
    try {
      const decoded = decodeURIComponent(rawParams);
      params = decoded.split(/,\s*/).map((p) => p.trim());
    } catch {
      params = rawParams.split(/,\s*/).map((p) => p.trim());
    }
  }

  return { command, params };
}

export function registerMigCommandRoutes(app: Express): void {
  app.get("/api/migcommand/supported", (_req: Request, res: Response) => {
    const list = Object.entries(SUPPORTED_COMMANDS).map(([command, description]) => ({
      command,
      url: `mig33:${command}`,
      description,
    }));
    return res.status(200).json({ commands: list, total: list.length });
  });

  app.post("/api/migcommand/resolve", (req: Request, res: Response) => {
    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string") {
      return res.status(400).json({ message: "Field 'url' wajib diisi (contoh: mig33:joinChatroom('roomId'))" });
    }

    const parsed = parseMigCommandUrl(url);
    if (!parsed) {
      return res.status(400).json({
        message: "URL bukan format MigCommand yang valid",
        hint: "Format: mig33:command atau mig33:command('param1,param2')",
      });
    }

    const { command, params } = parsed;
    const description = SUPPORTED_COMMANDS[command] ?? null;
    const supported = description !== null;

    return res.status(200).json({
      url,
      command,
      params,
      supported,
      description: description ?? "Command tidak dikenali",
    });
  });

  app.post("/api/migcommand/resolve/batch", (req: Request, res: Response) => {
    const { urls } = req.body as { urls?: unknown };
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ message: "Field 'urls' harus berupa array string yang tidak kosong" });
    }
    if (urls.length > 100) {
      return res.status(400).json({ message: "Maksimal 100 URL per request" });
    }

    const results = (urls as string[]).map((url) => {
      if (typeof url !== "string") {
        return { url, error: "Bukan string" };
      }
      const parsed = parseMigCommandUrl(url);
      if (!parsed) {
        return { url, error: "Format tidak valid" };
      }
      const { command, params } = parsed;
      const description = SUPPORTED_COMMANDS[command] ?? null;
      return {
        url,
        command,
        params,
        supported: description !== null,
        description: description ?? "Command tidak dikenali",
      };
    });

    return res.status(200).json({ results, total: results.length });
  });
}
