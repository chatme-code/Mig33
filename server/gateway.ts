import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "crypto";
import type { Server } from "http";
import { storage } from "./storage";
import { checkAccess } from "./middleware/accessControl";
import { getRedisClient, getOfflineMessages, clearOfflineMessages } from "./redis";
import { verifyJwt } from "./middleware/jwtAuth";
import { db } from "./db";
import { friendships, contactRequests, userProfiles, LEADERBOARD_TYPE, LEADERBOARD_PERIOD, CREDIT_TRANSACTION_TYPE } from "@shared/schema";
import { eq, and } from "drizzle-orm";
import type { ChatParticipant } from "@shared/schema";

const GW_LB_PERIODS = [LEADERBOARD_PERIOD.DAILY, LEADERBOARD_PERIOD.WEEKLY, LEADERBOARD_PERIOD.ALL_TIME];

function recordGiftLeaderboardGW(senderUsername: string, recipientUsernames: string[], count = 1) {
  for (const period of GW_LB_PERIODS) {
    storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_SENT, period, senderUsername, count, true).catch(() => {});
    for (const r of recipientUsernames) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.GIFT_RECEIVED, period, r, 1, true).catch(() => {});
    }
  }
}
import { processMessage as botProcessMessage, notifyUserJoin as botNotifyJoin, notifyUserLeave as botNotifyLeave, startBot as botStartBot, stopBot as botStopBot } from "./modules/botservice/botService";
import { isRegisteredGame, getRegisteredGames } from "./modules/botservice/BotLoader";
import { awardReputationScore } from "./modules/reputation/routes";

export const GATEWAY_WS_PATH = "/gateway";

// Matches Gateway.ServerType in backend app
export type ServerType = "HTTP" | "TCP" | "WS";

// Matches FusionPktError.Code in backend app
export const ErrorCode = {
  UNDEFINED:            1,
  INCORRECT_CREDENTIAL: 3,
  INVALID_VERSION:      100,
  UNSUPPORTED_PROTOCOL: 101,
} as const;

// Matches ConnectionI lifecycle in backend app
type ConnectionState = "CONNECTING" | "AUTHENTICATED" | "DISCONNECTED";

interface GatewayClient {
  ws: WebSocket;
  sessionId: string;           // UUID per connection — matches ConnectionI.sessionID
  userId?: string;
  username?: string;
  subscribedRooms: Set<string>;
  state: ConnectionState;
  serverType: ServerType;
  connectedAt: number;
  lastActivity: number;
  migLevel: number;
  isChatroomAdmin: boolean;
  // User-selected chat color (matches TEXT_COLOR palette, packet 924). Default: blue "2196F3"
  chatColor: string;
  /**
   * Role-based color override — mirrors ChatRoomParticipant.getMessageSourceColorOverride().
   * Set on SUBSCRIBE per room (keyed by roomId). When present, this overrides chatColor
   * for that room so the username appears with the correct role color.
   * Sourced from com/projectgoth/fusion MessageData.SourceTypeEnum:
   *   GLOBAL_ADMIN     → F47422 (orange)
   *   MODERATOR_USER   → FCC504 (golden yellow)
   *   GROUP_ADMIN_USER → FCC504 (golden yellow)  [owner/group-admin]
   *   TOP_MERCHANT     → 990099/FF2EA7/FF0000     [merchant/mentor]
   */
  roleColors: Map<string, string>;  // roomId → hex color (no #)
  // Rate limiting — matches PacketProcessor flood control
  packetCount: number;
  packetWindowStart: number;
  eventsDispatched: number;
}

const clients = new Map<WebSocket, GatewayClient>();

// Matches PacketProcessor rate limiting config in backend app
const RATE_LIMIT_MAX_PACKETS = 30;
const RATE_LIMIT_WINDOW_MS   = 10_000;
const KEEP_ALIVE_TIMEOUT_MS  = 120_000;
const PURGE_INTERVAL_MS      = 30_000;
const APP_VERSION            = "9.0.0";

// ─── Disconnect grace period ──────────────────────────────────────────────────
// When WS closes (network blip, reconnect, app background), we wait this long
// before broadcasting "has left" and removing from DB.  If the same user
// re-SUBSCRIBEs within the window the timer is cancelled and no leave/enter
// messages are emitted — exactly as the original Java gateway behaved.
//
// Java equivalent: the Android client kept a persistent TCP socket inside a
// background Service (NetworkService), so the connection never dropped during
// normal in-app navigation.  We replicate this by using a generous grace window:
// 120 s covers brief network blips, app-backgrounding, and switching between
// menus — giving the client plenty of time to reconnect silently.
const LEAVE_GRACE_MS = 120_000;  // 2 minutes (was 15 s)
interface PendingLeave {
  timer:          NodeJS.Timeout;
  roomId:         string;
  userId:         string;
  username:       string;
  color:          string;
  migLevel:       number;
  disconnectedAt: number;   // ms timestamp — used to fetch missed messages on reconnect
}

// Matches Java ChatRoom.queueEntryExitAdminMessage:
// userLevel == 0 → plain username; userLevel > 0 → "username[level]"
// Show badge for all levels >= 1 so "mig33 [1] has entered" is displayed correctly.
function withLevel(username: string, migLevel: number): string {
  return migLevel >= 1 ? `${username}[${migLevel}]` : username;
}
// Gift messages always show [level] badge — matches Gift.java formatUserNameWithLevel exactly
// Gift.java: return username + " [" + userReputationLevel + "]"
// << sender [level] gives a/an giftName emoji to recipient [level]! >>
function withGiftLevel(username: string, migLevel: number): string {
  return `${username} [${migLevel}]`;
}
// Lookup recipient's migLevel — check connected clients first, then DB
async function recipientDisplay(username: string): Promise<string> {
  // Check if they are currently connected
  for (const [, c] of clients) {
    if (c.state === "AUTHENTICATED" && c.username?.toLowerCase() === username.toLowerCase()) {
      return `${c.username} [${c.migLevel}]`;
    }
  }
  // Fallback: DB lookup
  const user = await storage.getUserByUsername(username);
  if (user) {
    const profile = await storage.getUserProfile(user.id);
    return `${user.username} [${profile?.migLevel ?? 1}]`;
  }
  return username; // unknown user — show as-is
}
// key: `${userId}:${roomId}`
const pendingLeaves = new Map<string, PendingLeave>();

// ─── Gift rate limiting ───────────────────────────────────────────────────────
// /gift all: per-user, matches GiftAllRateLimitInSeconds = 60s in Gift.java
const giftAllLastSent = new Map<string, number>();
const GIFT_ALL_RATE_LIMIT_MS = 60_000;

// /gift single: per sender+recipient+gift combo, matches GiftSingleRateLimitInSeconds = 60s
// key: `${senderUsername}:${recipientLower}:${giftName}` — same key strategy as Java's
// MemCachedKeyUtils.getFullKeyForKeySpace(VIRTUAL_GIFT_RATE_LIMIT, sender, recipient, giftId)
const giftSingleRateLimitMap = new Map<string, number>();
const GIFT_SINGLE_RATE_LIMIT_MS = 60_000;

// Matches StringUtil.implodeUserList(allRecipients, 5) in Gift.java
function implodeUserList(usernames: string[], max = 5): string {
  if (usernames.length === 0) return "everyone";
  if (usernames.length <= max) return usernames.join(", ");
  const shown = usernames.slice(0, max);
  const rest = usernames.length - max;
  return `${shown.join(", ")} and ${rest} more`;
}

// ─── Chatroom Theme ───────────────────────────────────────────────────────────
// Matches FusionPktChatRoomTheme (packet 719) in backend app
export interface ChatroomTheme {
  themeId: number;
  name: string;
  background_color: string;
  background_img_url: string | null;
  background_img_alignment: number;
  sender_username_color: string;
  sender_message_color: string;
  recp_username_color: string;
  recp_message_color: string;
  admin_username_color: string;
  admin_message_color: string;
  emote_message_color: string;
  error_message_color: string;
  server_username_color: string;
  server_message_color: string;
  client_message_color: string;
}

// All available chatroom themes — mirrors Java ThemeEnum in com.projectgoth.fusion
// All themes are free (no purchase required)
export const CHATROOM_THEMES: ChatroomTheme[] = [
  {
    themeId: 1, name: "Dark",
    background_color: "1A1A2E", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "2196F3", sender_message_color: "FFFFFF",
    recp_username_color:   "2196F3", recp_message_color:   "FFFFFF",
    admin_username_color: "F47422",  admin_message_color:  "FCC504",
    emote_message_color: "DD587A",   error_message_color:  "FF4444",
    server_username_color: "607D8B", server_message_color: "9E9E9E",
    client_message_color: "FFFFFF",
  },
  {
    themeId: 2, name: "Light",
    background_color: "F5F5F5", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "1565C0", sender_message_color: "212121",
    recp_username_color:   "1565C0", recp_message_color:   "212121",
    admin_username_color: "E65100",  admin_message_color:  "F57F17",
    emote_message_color: "C2185B",   error_message_color:  "D32F2F",
    server_username_color: "546E7A", server_message_color: "616161",
    client_message_color: "212121",
  },
  {
    themeId: 3, name: "Ocean",
    background_color: "002244", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "00BCD4", sender_message_color: "E0F7FA",
    recp_username_color:   "00BCD4", recp_message_color:   "E0F7FA",
    admin_username_color: "FF6F00",  admin_message_color:  "FFCA28",
    emote_message_color: "18FFFF",   error_message_color:  "FF5252",
    server_username_color: "4DD0E1", server_message_color: "80DEEA",
    client_message_color: "E0F7FA",
  },
  {
    themeId: 4, name: "Forest",
    background_color: "1B4332", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "69F0AE", sender_message_color: "E8F5E9",
    recp_username_color:   "69F0AE", recp_message_color:   "E8F5E9",
    admin_username_color: "FFD600",  admin_message_color:  "FFF176",
    emote_message_color: "CCFF90",   error_message_color:  "FF6E40",
    server_username_color: "A5D6A7", server_message_color: "C8E6C9",
    client_message_color: "E8F5E9",
  },
  {
    themeId: 5, name: "Sunset",
    background_color: "3D0C0C", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "FF7043", sender_message_color: "FFF3E0",
    recp_username_color:   "FF7043", recp_message_color:   "FFF3E0",
    admin_username_color: "FFCA28",  admin_message_color:  "FFE082",
    emote_message_color: "FF8A65",   error_message_color:  "FF1744",
    server_username_color: "FFAB91", server_message_color: "FFCCBC",
    client_message_color: "FFF3E0",
  },
  {
    themeId: 6, name: "Purple",
    background_color: "1A0033", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "CE93D8", sender_message_color: "F3E5F5",
    recp_username_color:   "CE93D8", recp_message_color:   "F3E5F5",
    admin_username_color: "FFD600",  admin_message_color:  "FFF9C4",
    emote_message_color: "EA80FC",   error_message_color:  "FF4081",
    server_username_color: "B39DDB", server_message_color: "D1C4E9",
    client_message_color: "F3E5F5",
  },
  {
    themeId: 7, name: "Carbon",
    background_color: "1C1C1C", background_img_url: null, background_img_alignment: 0,
    sender_username_color: "78909C", sender_message_color: "ECEFF1",
    recp_username_color:   "78909C", recp_message_color:   "ECEFF1",
    admin_username_color: "FF6F00",  admin_message_color:  "FFC107",
    emote_message_color: "80CBC4",   error_message_color:  "EF5350",
    server_username_color: "546E7A", server_message_color: "90A4AE",
    client_message_color: "ECEFF1",
  },
];

export function getThemeById(id: number): ChatroomTheme {
  return CHATROOM_THEMES.find(t => t.themeId === id) ?? CHATROOM_THEMES[0];
}

export const DEFAULT_THEME: ChatroomTheme = CHATROOM_THEMES[0];

// ─── Participants payload ─────────────────────────────────────────────────────
// Matches FusionPktChatRoomParticipantsOld (packet 708) in backend app
// Java sends: chatRoomName, participants (csv), administrators (csv), mutedParticipants (csv)
export interface ParticipantsPayload {
  type: "PARTICIPANTS";
  roomId: string;
  chatRoomName: string;
  participants: string[];
  administrators: string[];
  mutedParticipants: string[];
}

export function buildParticipantsPayload(
  roomId: string,
  roomName: string,
  list: ChatParticipant[]
): ParticipantsPayload {
  const participants:     string[] = [];
  const administrators:   string[] = [];
  const mutedParticipants: string[] = [];

  for (const p of list) {
    if (p.isMuted) {
      mutedParticipants.push(p.username);
    } else if (p.isMod || p.isOwner) {
      administrators.push(p.username);
    } else {
      participants.push(p.username);
    }
  }
  return { type: "PARTICIPANTS", roomId, chatRoomName: roomName, participants, administrators, mutedParticipants };
}

// ─── Incoming message types (client → server) ─────────────────────────────────
export type GatewayMessage =
  | { type: "AUTH"; token?: string; sessionUserId?: string; username?: string }
  | { type: "SUBSCRIBE"; roomId: string }
  | { type: "JOIN_ROOM"; roomId: string }
  | { type: "UNSUBSCRIBE"; roomId: string }
  | { type: "SEND_MESSAGE"; roomId: string; text: string }
  // Matches /gift [recipient|all] [giftName] from ChatController.java
  | { type: "SEND_GIFT"; roomId: string; recipient: string; giftName: string; giftEmoji?: string; price?: number; giftMessage?: string }
  | { type: "CMD"; roomId: string; cmd: string; target?: string; message?: string; waitTime?: number }
  // Matches FusionPktDataTextColor (packet 924) — returns sender + message color palettes
  | { type: "GET_COLORS" }
  // Allows user to change their chat username color (stored per WS session)
  | { type: "SET_COLOR"; color: string }
  | { type: "GET_ROOMS"; categoryId?: number; page?: number }
  | { type: "GET_MESSAGES"; roomId: string; after?: string; before?: string; limit?: number }
  | { type: "GET_PARTICIPANTS"; roomId: string }
  | { type: "GET_THEME"; roomId: string }
  | { type: "GET_STATS" }
  | { type: "PING" };

// ─── Outgoing event types (server → client) ───────────────────────────────────
export type GatewayEvent =
  | { type: "WELCOME"; clientId: string; sessionId: string; version: string }
  | { type: "AUTH_OK"; username: string; sessionId: string; migLevel: number }
  | { type: "AUTH_FAIL"; code: number; message: string }
  | { type: "SUBSCRIBED"; roomId: string; room: object; theme: ChatroomTheme; userColor: string }
  | { type: "JOIN_FAIL"; code: string | number; message: string }
  | { type: "MESSAGE"; roomId: string; message: object }
  | { type: "MESSAGES"; roomId: string; messages: object[] }
  | { type: "HISTORY"; roomId: string; messages: object[]; hasMore: boolean }
  | ParticipantsPayload
  | { type: "KICKED"; roomId: string; username: string }
  | { type: "BANNED"; roomId: string; username: string }
  | { type: "MUTED"; roomId: string; username: string }
  | { type: "UNMUTED"; roomId: string; username: string }
  | { type: "MOD"; roomId: string; username: string }
  | { type: "UNMOD"; roomId: string; username: string }
  | { type: "WARNED"; roomId: string; username: string; message?: string }
  | { type: "ANNOUNCEMENT"; roomId: string; message: string }
  | { type: "ANNOUNCEMENT_OFF"; roomId: string }
  // Matches LoveMatch.java + FindMyMatch.java — broadcast love score result to room
  | { type: "LOVE_MATCH"; roomId: string; user1: string; user2: string; score: number }
  | { type: "FIND_MY_MATCH"; roomId: string; seeker: string; match: string; score: number }
  // Matches Flames.java — broadcast FLAMES result to room
  | { type: "FLAMES"; roomId: string; user1: string; user2: string; letter: string; label: string; emoji: string }
  | { type: "FLAMES_NO_MATCH"; roomId: string; user1: string; user2: string }
  // Matches Follow.java — sendMessageToSender only (only caller sees confirmation)
  | { type: "FOLLOW_OK"; username: string }
  | { type: "UNFOLLOW_OK"; username: string }
  // Matches GetMyLuck.java — broadcast 4 luck values (1-5) to entire room
  // Cached per user per day via Redis (mirrors MemCachedClientWrapper.add with TTL)
  | { type: "GET_MY_LUCK"; roomId: string; username: string; love: number; career: number; health: number; luck: number }
  | { type: "LOCKED"; roomId: string }
  | { type: "UNLOCKED"; roomId: string }
  | { type: "THEME"; roomId: string; theme: ChatroomTheme }
  // Matches FusionPktGiftHotkeys — broadcast gift event to room
  | { type: "GIFT"; roomId: string; sender: string; senderColor: string; recipient: string; giftName: string; giftEmoji: string; giftImageUrl?: string; price: number; message: object }
  // Matches FusionPktDataTextColor (packet 924) — chatSenderColorList + chatMessageColorList
  | { type: "COLOR_LIST"; senderColors: string[]; messageColors: string[] }
  | { type: "COLOR_CHANGED"; roomId: string; username: string; color: string }
  | { type: "ROOMS_LIST"; chatrooms: object[]; page: number; totalPages: number }
  | { type: "ALERT"; title: string; message: string }
  | { type: "STATS"; connections: number; authenticated: number; totalEvents: number }
  | { type: "CMD_OK"; cmd: string; target?: string }
  | { type: "PONG"; timestamp: number }
  | { type: "ERROR"; code: number; message: string }
  | { type: "CHAT_MESSAGE"; conversationId: string; message: object }
  // ─── Presence (FusionPktPresence / FusionPktSetPresence) ──────────────────
  // Java: PresenceType values: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
  | { type: "PRESENCE"; username: string; userId: string; status: "online" | "away" | "offline" }
  | { type: "PRESENCE_LIST"; users: { username: string; userId: string; status: "online" | "away" | "offline" }[] }
  // ─── Read receipt (FusionPktMessageStatusEvent pkt 505) ───────────────────
  // statusEventType: DELIVERED=1, READ=2 — we implement READ only (parity with Java logic)
  | { type: "READ_RECEIPT"; conversationId: string; messageIds: string[]; readByUsername: string; readAt: string }
  // ─── Server-generated RECEIVED event (ServerGeneratedReceivedEventPusher.java)
  // Pushed back to the original sender when the server stores a message.
  // Mirrors: messageSender.putMessageStatusEvent(toIceObject()) — status=RECEIVED (1)
  // Client uses this to flip ✓ (sending) → ✓ (delivered to server).
  // status: "RECEIVED" = server ack'd (pkt 505 statusEventType=1)
  //         "READ"     = recipient read (sent via READ_RECEIPT, included here for completeness)
  | { type: "MESSAGE_STATUS"; conversationId: string; messageId: string; status: "RECEIVED" | "READ"; serverGenerated: boolean; timestamp: number }
  // ─── Contact / Friend system (FusionPktContactRequest / Accept / Reject) ──
  | { type: "CONTACT_REQUEST"; requestId: string; fromUsername: string; fromDisplayName: string | null }
  | { type: "CONTACT_ACCEPTED"; byUsername: string; byDisplayName: string | null; friendshipId: string }
  | { type: "CONTACT_REJECTED"; byUsername: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────
function send(ws: WebSocket, event: GatewayEvent): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
    const client = clients.get(ws);
    if (client) client.eventsDispatched++;
  }
}

function isRateLimited(client: GatewayClient): boolean {
  const now = Date.now();
  if (now - client.packetWindowStart > RATE_LIMIT_WINDOW_MS) {
    client.packetWindowStart = now;
    client.packetCount = 0;
  }
  client.packetCount++;
  return client.packetCount > RATE_LIMIT_MAX_PACKETS;
}

// Matches FusionPktDataTextColor (packet 924) — chatSenderColorList sent to client
// Default index 0 = "2196F3" (blue) — the Migme original default user color
export const TEXT_SENDER_COLORS = [
  "2196F3", "FFFFFF", "FF5252", "69F0AE", "FFEB3B",
  "FF9800", "E040FB", "FF4081", "00E5FF", "FF6D00",
  "4CAF50", "F44336", "9C27B0", "009688", "795548",
];
export const TEXT_MESSAGE_COLORS = [
  "FFFFFF", "FFEB3B", "FF5252", "69F0AE", "00E5FF",
  "FF9800", "E040FB", "FF4081",
];

// Default = blue "2196F3" (index 0). Hash picks a color from the palette for variety.
export function userColor(username: string): string {
  const idx = Math.abs(username.split("").reduce((a, c) => a + c.charCodeAt(0), 0)) % TEXT_SENDER_COLORS.length;
  return TEXT_SENDER_COLORS[idx];
}

/**
 * Mirrors ChatRoomParticipant.getMessageSourceColorOverride() from com/projectgoth/fusion.
 *
 * Priority (highest → lowest):
 *   1. Room Owner / Group Admin / Mod → GROUP_ADMIN_USER / MODERATOR_USER → FCC504 (golden yellow)
 *   2. Merchant / Mentor              → merchant.usernameColor (default #990099 purple)
 *   3. Regular user                   → fallback (null = use client.chatColor)
 *
 * Global Admin (#F47422 orange) is handled separately when user.isGlobalAdmin is set.
 *
 * Source color values from MessageData.SourceTypeEnum:
 *   GROUP_ADMIN_USER (3)  = 16565508 = 0xFCC504
 *   MODERATOR_USER   (4)  = 16565508 = 0xFCC504
 *   TOP_MERCHANT_LVL1(12) = 0x990099
 *   TOP_MERCHANT_LVL2(13) = 16723623 = 0xFF2EA7
 *   TOP_MERCHANT_LVL3(15) = 0xFF0000
 *   GLOBAL_ADMIN     (17) = 16020514 = 0xF47422
 */
export async function getRoleColor(params: {
  userId: string;
  username: string;
  roomId: string;
  defaultColor: string;
}): Promise<string> {
  const { userId, username, roomId, defaultColor } = params;
  try {
    const room = await storage.getChatroom(roomId);
    if (!room) return defaultColor;

    const isOwner = room.createdBy === userId;
    const isMod   = await storage.isModUser(roomId, userId);

    if (isOwner || isMod) {
      return "FCC504";
    }

    const merchant = await storage.getMerchantByUsername(username);
    if (merchant) {
      return (merchant.usernameColor ?? "#990099").replace(/^#/, "");
    }
  } catch {}
  return defaultColor;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function broadcastToRoom(roomId: string, event: GatewayEvent): void {
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED" && client.subscribedRooms.has(roomId)) {
      send(client.ws, event);
    }
  });
}

export function broadcastToUser(userId: string, event: GatewayEvent): void {
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED" && client.userId === userId) {
      send(client.ws, event);
    }
  });
}

// ─── Presence tracking ────────────────────────────────────────────────────────
// Mirrors FusionPktSetPresence / FusionPktPresence (Java: SessionPrx.setPresence)
// Java PresenceType: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
// States: online (AVAILABLE), away (AWAY), busy (BUSY), offline (OFFLINE/INVISIBLE)
// In-memory map: userId → user-set override ("away" | "online" | "busy")
// Default: derived from WS connection — if authenticated WS connection exists → "online"
const presenceOverrides = new Map<string, "away" | "online" | "busy" | "offline">();

// In-memory status messages: userId → status message text
const statusMessages = new Map<string, string>();

export function getUserPresence(userId: string): "online" | "away" | "busy" | "offline" {
  let isConnected = false;
  clients.forEach((c) => {
    if (c.state === "AUTHENTICATED" && c.userId === userId) isConnected = true;
  });
  if (!isConnected) return "offline";
  const override = presenceOverrides.get(userId);
  if (override === "away") return "away";
  if (override === "busy") return "busy";
  if (override === "offline") return "offline";
  return "online";
}

export function getUserStatusMessage(userId: string): string {
  return statusMessages.get(userId) ?? "";
}

export function setUserStatusMessage(userId: string, message: string): void {
  if (message.trim()) {
    statusMessages.set(userId, message.trim());
  } else {
    statusMessages.delete(userId);
  }
}

export function setUserPresenceOverride(userId: string, status: "online" | "away" | "busy" | "offline"): void {
  if (status === "online") {
    presenceOverrides.delete(userId);
  } else {
    presenceOverrides.set(userId, status);
  }
}

export function isUserOnline(userId: string): boolean {
  return getUserPresence(userId) !== "offline";
}

// Push PRESENCE event to a list of online friend userIds
export function broadcastPresenceToFriends(userId: string, username: string, status: "online" | "away" | "busy" | "offline", friendUserIds: string[]): void {
  for (const fid of friendUserIds) {
    if (fid !== userId) {
      broadcastToUser(fid, { type: "PRESENCE", username, userId, status });
    }
  }
}

// ─── Public helper: batch presence for a list of userIds ──────────────────────
export function getPresenceList(userIds: string[]): { username: string; userId: string; status: "online" | "away" | "busy" | "offline" }[] {
  const result: { username: string; userId: string; status: "online" | "away" | "busy" | "offline" }[] = [];
  for (const uid of userIds) {
    let username = "";
    clients.forEach((c) => { if (c.userId === uid && c.username) username = c.username; });
    result.push({ userId: uid, username, status: getUserPresence(uid) });
  }
  return result;
}

// Matches GatewayAdminI.sendAlertToAllConnections() in backend app
export function broadcastAlertToAll(title: string, message: string): void {
  let dispatched = 0;
  clients.forEach((client) => {
    if (client.state === "AUTHENTICATED") {
      send(client.ws, { type: "ALERT", title, message });
      dispatched++;
    }
  });
  console.log(`[gateway] Alert "${title}" dispatched to ${dispatched} connections`);
}

export function getGatewayStats() {
  let authenticated = 0;
  let totalEvents = 0;
  clients.forEach((c) => {
    if (c.state === "AUTHENTICATED") authenticated++;
    totalEvents += c.eventsDispatched;
  });
  return { connections: clients.size, authenticated, totalEvents };
}

// ─── Announce repeat timers (mirrors Announce.java chatRoomPrx.announceOn/Off) ─
// Key: roomId → NodeJS timer handle
// waitTime -1 = one-shot (no repeat). 120-3600 = repeat interval in seconds.
const announceTimers = new Map<string, ReturnType<typeof setInterval>>();

function clearAnnounceTimer(roomId: string): void {
  const t = announceTimers.get(roomId);
  if (t) { clearInterval(t); announceTimers.delete(roomId); }
}

// ─── Flames helper — ported from Flames.java ─────────────────────────────────
// getFlamesScore: counts shared characters (user1 freq + user2 freq per shared char).
// Mirrors: Flames.java#getFlamesScore (lines 35-60)
// FLAMES_VALUES index = score % 6:
//   0→Sis/Bro  1→Friendship  2→Love  3→Admiration  4→Marriage  5→Enemy
const FLAMES_VALUES = [
  { letter: "S", label: "Sis/Bro",    emoji: "👫" },
  { letter: "F", label: "Friendship", emoji: "🤝" },
  { letter: "L", label: "Love",       emoji: "❤️"  },
  { letter: "A", label: "Admiration", emoji: "😍" },
  { letter: "M", label: "Marriage",   emoji: "💍" },
  { letter: "E", label: "Enemy",      emoji: "😡" },
];
function getFlamesScore(username1: string, username2: string): number {
  // Build char frequency map for username1
  const freq1 = new Map<string, number>();
  for (const c of username1) { freq1.set(c, (freq1.get(c) ?? 0) + 1); }
  // For each char in username2 that also appears in username1, accumulate
  // First occurrence: common[c] = freq1[c] + 1; subsequent: common[c] += 1
  // Mirrors Flames.java occurrenceCommon logic exactly
  const common = new Map<string, number>();
  for (const c of username2) {
    if (!freq1.has(c)) continue;
    if (common.has(c)) { common.set(c, common.get(c)! + 1); }
    else               { common.set(c, freq1.get(c)! + 1); }
  }
  let total = 0;
  for (const v of common.values()) total += v;
  return total;
}

// ─── LoveMatch helpers — ported from LoveMatch.java ──────────────────────────
// getLoveCode: rolling sum of char codes mod 101, with code==100 bumped to 101
// Mirrors: LoveMatch.java#getLoveCode (line 32-48)
function getLoveCode(username: string): number {
  if (!username) return 0;
  const v = username.trim().toLowerCase();
  if (!v.length) return 0;
  let code = 0;
  for (const c of v) { code = (code + c.charCodeAt(0)) % 101; }
  code %= 101;
  if (code === 100) code++;
  return code;
}
// getLoveMatchScore: (code2 * code1 + code1 + code2) % 101
// Mirrors: LoveMatch.java#getLoveMatchScore (line 50-52)
function getLoveMatchScore(username1: string, username2: string): number {
  const c1 = getLoveCode(username1);
  const c2 = getLoveCode(username2);
  return (c2 * c1 + c1 + c2) % 101;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
export function setupGateway(httpServer: Server): void {
  const wss = new WebSocketServer({ server: httpServer, path: GATEWAY_WS_PATH });

  // PurgeConnectionTask — drop idle/dead connections (matches backend PurgeConnectionTask)
  const purgeTimer = setInterval(() => {
    const now = Date.now();
    const toDelete: WebSocket[] = [];
    clients.forEach((client, ws) => {
      if (now - client.lastActivity > KEEP_ALIVE_TIMEOUT_MS) {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Connection timed out" });
        client.state = "DISCONNECTED";
        ws.terminate();
        toDelete.push(ws);
      }
    });
    toDelete.forEach((ws) => clients.delete(ws));
  }, PURGE_INTERVAL_MS);
  purgeTimer.unref();

  // Native WebSocket ping interval — sends WS-level ping frames to keep TCP connections
  // alive through proxies and load balancers that drop idle connections.
  // Mirrors FusionService.pingTimerTask in the Android client (scheduleNextPingTimerTask).
  const NATIVE_PING_INTERVAL_MS = 30_000;

  wss.on("connection", (ws, req) => {
    const now = Date.now();
    const sessionId = randomUUID();
    const clientIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "unknown";
    console.log(`[gateway] WS client connected: sessionId=${sessionId} ip=${clientIp}`);

    const client: GatewayClient = {
      ws,
      sessionId,
      subscribedRooms: new Set(),
      state: "CONNECTING",
      serverType: "WS",
      connectedAt: now,
      lastActivity: now,
      migLevel: 1,
      isChatroomAdmin: false,
      chatColor: "2196F3",   // Default blue — matches Migme original default
      roleColors: new Map(),
      packetCount: 0,
      packetWindowStart: now,
      eventsDispatched: 0,
    };
    clients.set(ws, client);

    // Native ping — keeps the TCP connection alive through proxies/load balancers
    const nativePingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
      } else {
        clearInterval(nativePingTimer);
      }
    }, NATIVE_PING_INTERVAL_MS);

    // Pong reply updates lastActivity — prevents idle purge from dropping live connections
    ws.on("pong", () => {
      client.lastActivity = Date.now();
    });

    // WELCOME — matches GatewayWS initial handshake in backend app
    send(ws, { type: "WELCOME", clientId: sessionId, sessionId, version: APP_VERSION });

    ws.on("message", async (data) => {
      client.lastActivity = Date.now();

      // Rate limiting — PacketProcessor flood control
      if (isRateLimited(client)) {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Too many requests. Slow down." });
        client.state = "DISCONNECTED";
        ws.terminate();
        clients.delete(ws);
        return;
      }

      let msg: GatewayMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Invalid JSON" });
        return;
      }

      switch (msg.type) {

        // ── AUTH ────────────────────────────────────────────────────────────
        case "AUTH": {
          let user = null;

          // Path 1: JWT token (preferred — works reliably across Docker/mobile)
          if (msg.token) {
            const payload = verifyJwt(msg.token);
            if (payload) {
              user = await storage.getUser(payload.userId);
              console.log(`[gateway] AUTH attempt via JWT: userId=${payload.userId} userFound=${!!user}`);
            } else {
              console.log(`[gateway] AUTH_FAIL: invalid JWT token`);
              send(ws, { type: "AUTH_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Token tidak valid" });
              return;
            }
          }

          // Path 2: sessionUserId fallback (backward compat for web)
          if (!user && msg.sessionUserId) {
            const found = await storage.getUser(msg.sessionUserId);
            if (found && (!msg.username || found.username === msg.username)) {
              user = found;
            }
            console.log(`[gateway] AUTH attempt via sessionUserId=${msg.sessionUserId} userFound=${!!user}`);
          }

          if (!user) {
            console.log(`[gateway] AUTH_FAIL: no valid credentials provided`);
            send(ws, { type: "AUTH_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Autentikasi gagal" });
            return;
          }
          const profile = await storage.getUserProfile(user.id);
          client.userId    = user.id;
          client.username  = user.username;
          client.migLevel  = profile?.migLevel ?? 1;
          // chatColor stays as "2196F3" (blue default) unless user changes it via SET_COLOR
          // Matches Migme original default — users pick color from TEXT_COLOR palette (packet 924)
          client.state     = "AUTHENTICATED";
          console.log(`[gateway] AUTH_OK: userId=${user.id} username=${user.username}`);
          send(ws, { type: "AUTH_OK", username: user.username, sessionId, migLevel: client.migLevel });
          // Broadcast ONLINE presence to friends — mirrors Java FusionPktPresence broadcast on login
          try {
            const myFriends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, user.id));
            const friendIds = myFriends.map((f: { friendUserId: string }) => f.friendUserId);
            broadcastPresenceToFriends(user.id, user.username, "online", friendIds);
          } catch {}

          // Flush offline messages queued while user was disconnected
          // Mirrors RedisChatSyncStore offline message delivery on reconnect
          try {
            const today = new Date();
            const yesterdayDate = new Date(today);
            yesterdayDate.setDate(today.getDate() - 1);
            const todayMsgs   = await getOfflineMessages(user.id, today);
            const yestMsgs    = await getOfflineMessages(user.id, yesterdayDate);
            const allOffline  = [...yestMsgs, ...todayMsgs];
            for (const raw of allOffline) {
              try {
                const event = JSON.parse(raw);
                send(ws, event);
              } catch {}
            }
            if (allOffline.length > 0) {
              await clearOfflineMessages(user.id, today);
              await clearOfflineMessages(user.id, yesterdayDate);
            }
          } catch {}
          break;
        }

        // ── SUBSCRIBE / JOIN_ROOM ────────────────────────────────────────────
        // Matches FusionPktJoinChatRoomOld (703): joins DB, sends theme+participants+history
        // JOIN_ROOM is the preferred name from mobile clients; SUBSCRIBE kept for web compat.
        case "JOIN_ROOM":
        case "SUBSCRIBE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "JOIN_FAIL", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            ws.terminate();
            return;
          }
          const roomId = (msg as any).roomId as string;
          console.log(`[gateway] JOIN_ROOM: userId=${client.userId} username=${client.username} roomId=${roomId}`);
          const room = await storage.getChatroom(roomId);
          if (!room) {
            console.log(`[gateway] JOIN_FAIL: room ${roomId} not found`);
            send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: `Room ${roomId} tidak ditemukan` });
            ws.terminate();
            return;
          }
          const banned = await storage.isBanned(roomId, client.userId!);
          if (banned) {
            console.log(`[gateway] JOIN_FAIL: userId=${client.userId} is banned from room ${roomId}`);
            send(ws, { type: "JOIN_FAIL", code: ErrorCode.UNDEFINED, message: "Kamu di-ban dari chatroom ini" });
            ws.terminate();
            return;
          }

          // AccessControl: ENTER_CHATROOM — mirrors AuthenticatedAccessControlTypeEnum.ENTER_CHATROOM
          const canEnter = await checkAccess("ENTER_CHATROOM", client.userId!);
          if (!canEnter) {
            console.log(`[gateway] JOIN_FAIL: userId=${client.userId} email not verified`);
            send(ws, { type: "JOIN_FAIL", code: "EMAIL_NOT_VERIFIED", message: "Verifikasi email kamu terlebih dahulu untuk masuk ke chatroom." });
            ws.terminate();
            return;
          }

          // ── Grace period reconnect check ─────────────────────────────────
          // If this user disconnected recently (within LEAVE_GRACE_MS), cancel
          // the pending "has left" and re-subscribe silently — no enter/leave
          // messages emitted, matching Java gateway reconnect behaviour.
          const graceKey = `${client.userId}:${roomId}`;
          const pending  = pendingLeaves.get(graceKey);
          const isReconnect = !!pending;
          if (pending) {
            clearTimeout(pending.timer);
            pendingLeaves.delete(graceKey);
          }

          // Determine role-based color — mirrors ChatRoomParticipant.getMessageSourceColorOverride()
          // Owner/Mod → FCC504 (golden yellow), Merchant/Mentor → 990099 (purple), else chatColor
          const roleColor = await getRoleColor({
            userId: client.userId!,
            username: client.username!,
            roomId,
            defaultColor: client.chatColor,
          });
          client.roleColors.set(roomId, roleColor);

          // Join chatroom in DB — use role color so participant list reflects the correct color
          const color = roleColor;
          await storage.joinChatroom(roomId, {
            id: client.userId!, username: client.username!,
            displayName: client.username!, color,
          });
          client.subscribedRooms.add(roomId);

          // Send SUBSCRIBED with room info, theme, and the user's resolved role color
          // so the client can use the correct color immediately for optimistic messages.
          const roomThemeId = parseInt((room as any).theme ?? "1", 10) || 1;
          const roomTheme   = getThemeById(roomThemeId);
          console.log(`[gateway] JOIN_OK: userId=${client.userId} username=${client.username} roomId=${roomId} isReconnect=${isReconnect} themeId=${roomThemeId}`);
          send(ws, { type: "SUBSCRIBED", roomId, room, theme: roomTheme, userColor: roleColor });

          // Send COLOR_LIST — matches FusionPktDataTextColor (packet 924)
          send(ws, { type: "COLOR_LIST", senderColors: TEXT_SENDER_COLORS, messageColors: TEXT_MESSAGE_COLORS });

          // Send PARTICIPANTS privately to the joining user — their personal
          // "Currently in the room" snapshot (mirrors Java queueAdminMessage
          // with MIMETYPE_PARTICIPANTS, sent only to the entrant).
          const list = await storage.getParticipants(roomId);
          send(ws, buildParticipantsPayload(roomId, room.name, list));

          // Always send recent message history so the user sees existing chat
          // when entering or re-entering a room (matches user expectation on mobile).
          // For reconnects within the grace period, also include any missed messages.
          const recentMessages = await storage.getMessages(roomId, { limit: 50 });
          if (recentMessages.length > 0) {
            send(ws, { type: "MESSAGES", roomId, messages: recentMessages });
          }
          if (isReconnect && pending) {
            // Send only messages posted AFTER the disconnect time to fill the gap,
            // filtering out any already sent in the recent batch above.
            const recentIds = new Set(recentMessages.map(m => m.id));
            const missed = (await storage.getMessagesSince(roomId, pending.disconnectedAt))
              .filter(m => !recentIds.has(m.id));
            if (missed.length > 0) {
              send(ws, { type: "MESSAGES", roomId, messages: missed });
            }
          }

          // Broadcast "has entered" only on a genuine first join, not a reconnect.
          // Matches Java ChatRoom.queueEntryExitAdminMessage: include level badge
          // when migLevel > 1 — e.g. "alice[5] has entered".
          if (!isReconnect) {
            const displayName = withLevel(client.username!, client.migLevel);
            const joinMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: client.username!,
              senderColor: color, text: `${room.name}::${displayName} has entered`, isSystem: true,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: joinMsg });
            // Mirrors Java ChatRoomParticipants.notifyUserJoinedChatRoom:
            // each existing participant is notified so they refresh their list.
            // Broadcast updated PARTICIPANTS to ALL clients in the room so
            // "Currently in the room" and the sidebar update for everyone.
            broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
            botNotifyJoin(roomId, client.username!);
          }
          break;
        }

        // ── UNSUBSCRIBE / LEAVE CHATROOM ─────────────────────────────────────
        // Matches FusionPktLeaveChatRoomOld: leaves DB, broadcasts USER_LEFT
        case "UNSUBSCRIBE": {
          const { roomId } = msg;
          if (!client.subscribedRooms.has(roomId)) return;
          client.subscribedRooms.delete(roomId);
          if (!client.userId) return;
          await storage.leaveChatroom(roomId, client.userId);
          const room = await storage.getChatroom(roomId);
          const leaveDisplayName = withLevel(client.username!, client.migLevel);
          const leaveMsg = await storage.postMessage(roomId, {
            senderUsername: client.username!, senderColor: client.chatColor,
            text: `${room?.name ?? roomId}::${leaveDisplayName} has left`, isSystem: true,
          });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
          const list = await storage.getParticipants(roomId);
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
          botNotifyLeave(roomId, client.username!);
          break;
        }

        // ── SEND_MESSAGE ─────────────────────────────────────────────────────
        // Matches FusionPktMessage (500) in backend app
        case "SEND_MESSAGE": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            return;
          }
          const { roomId, text } = msg;
          if (!roomId || !text?.trim()) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId dan text wajib" });
            return;
          }
          if (!client.subscribedRooms.has(roomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" });
            return;
          }
          // Resolve effective sender color — role overrides user-chosen color.
          // Mirrors ChatRoomParticipant.getMessageSourceColorOverride() from com/projectgoth/fusion:
          //   isOwner/isMod  → FCC504 (golden yellow)
          //   merchant/mentor → 990099 (purple) or merchant's usernameColor
          //   regular user   → client.chatColor (user-chosen, default "2196F3")
          const senderColor = client.roleColors.get(roomId) ?? client.chatColor;

          // ── /gift command interceptor ────────────────────────────────────────
          // Matches Gift.java: /gift {recipient|all} {giftName} [-m {message}]
          // /gift all: shower format, billing msg to sender, balance check, rate limit
          const trimmed = text.trim();

          // Mute check — deferred until after slash-command parsing so that
          // admin/mod commands (/kick, /ban, /mute, /silence, etc.) are not blocked
          // when the executor themselves is somehow muted (edge case).
          // Regular chat messages are still blocked for muted users.
          const isAdminSlashCmd = /^\/(lock|unlock|kick|ban|mute|unmute|silence|unban|suspend|block|me|roll|brb|off|gift|g\s|bot|botstop|games)(\s|$)/i.test(trimmed);
          if (!isAdminSlashCmd) {
            const muted = await storage.isMuted(roomId, client.userId!);
            if (muted) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Kamu sedang di-mute" });
              return;
            }
          }
          if (/^\/g(?:ift)?\s+/i.test(trimmed)) {
            // /gift all (no giftName) — help message
            if (/^\/g(?:ift)?\s+all\s*$/i.test(trimmed)) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'To buy a gift for all users in this room, type "/gift all <gift name>". Type "/gift list" to see available gifts.' });
              return;
            }
            // Parse: /gift <recipient> <giftName> [-m <optional message>]
            const giftMatch = trimmed.match(/^\/g(?:ift)?\s+(\S+)\s+(\S+)(?:\s+-m\s+(.+))?$/i);
            if (!giftMatch) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Format: /gift {username|all} {namagift} [-m pesan]" });
              return;
            }
            const [, giftRecipient, giftName, giftPersonalMsg] = giftMatch;
            const gift = await storage.getVirtualGiftByName(giftName);
            if (!gift) {
              // Matches Gift.java findVirtualGiftByName: "Sorry, there is no gift matching [giftName]"
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Sorry, there is no gift matching [${giftName}]` });
              return;
            }

            const senderUsername = client.username!;
            const senderDisplay  = withGiftLevel(senderUsername, client.migLevel);
            const isAll          = giftRecipient.toLowerCase() === "all";
            const article        = /^[aeiou]/i.test(giftName) ? "an" : "a";
            const hotkey         = gift.hotKey ?? "🎁";

            if (isAll) {
              // ── /gift all — Matches GiftAsync.giftAll() + GiftAllTask.java ──
              // Rate limit: once per 60 seconds per user (matches GiftAllRateLimitInSeconds)
              const now = Date.now();
              const lastSent = giftAllLastSent.get(senderUsername) ?? 0;
              if (now - lastSent < GIFT_ALL_RATE_LIMIT_MS) {
                const waitSec = Math.ceil((GIFT_ALL_RATE_LIMIT_MS - (now - lastSent)) / 1000);
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only use /gift all every 60 seconds. Try again in ${waitSec}s.` });
                return;
              }

              // Get all room participants (excluding sender) — matches getAllUsernamesInChat(false)
              const allParticipants = await storage.getParticipants(roomId);
              const recipients = allParticipants
                .map(p => p.username)
                .filter(u => u.toLowerCase() !== senderUsername.toLowerCase());

              if (recipients.length === 0) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "There are no other users in the room." });
                return;
              }

              // Balance check — matches GiftAsync: balance >= price * numRecipients
              const totalCost = gift.price * recipients.length;
              const acct      = await storage.getCreditAccount(senderUsername);
              if (acct.balance < totalCost) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
                return;
              }

              // Apply rate limit timestamp
              giftAllLastSent.set(senderUsername, now);

              // Deduct balance — matches GiftAllBiller.java billing step
              await storage.adjustBalance(senderUsername, -totalCost);
              const remainingAcct = await storage.getCreditAccount(senderUsername);

              // Shower message — matches GiftAsync.sendGiftShowerMessageToAllUsersInChat()
              const recipientList = implodeUserList(recipients, 5);
              const wsGiftDisplay = gift.location64x64Png ? giftName : `${giftName} ${hotkey}`;
              let giftText = `<< (shower) *GIFT SHOWER* ${senderDisplay} gives ${article} ${wsGiftDisplay} to ${recipientList}! Hurray!`;
              if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
              giftText += " >>";

              const giftMsg = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername, senderColor,
                text: giftText, isSystem: false,
              });

              // Broadcast shower message + GIFT event to all in room
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
              broadcastToRoom(roomId, {
                type: "GIFT", roomId,
                sender: senderUsername, senderColor,
                recipient: "all", giftName, giftEmoji: hotkey,
                giftImageUrl: gift.location64x64Png ?? undefined,
                price: totalCost, recipientCount: recipients.length,
                message: giftMsg,
                ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
              });

              // Billing message — sent ONLY to sender (matches GiftAllBillingMessageData.java)
              // "Congratulations for sending gifts! You have used X MIG and your estimated remaining balance after gifting will be Y MIG."
              send(ws, {
                type: "GIFT_BILLING",
                message: `Congratulations for sending gifts! You have used ${totalCost} MIG and your estimated remaining balance after gifting will be ${remainingAcct.balance.toFixed(2)} MIG.`,
                totalCost, remainingBalance: remainingAcct.balance, currency: "MIG",
              });

              // Reputation: award gift XP to sender and each recipient
              recordGiftLeaderboardGW(senderUsername, recipients, recipients.length);
              awardReputationScore(senderUsername, "giftSent", recipients.length).catch(() => {});
              for (const r of recipients) {
                awardReputationScore(r, "giftReceived").catch(() => {});
              }

            } else {
              // ── /gift <username> <giftName> — single-user gift ──
              // Matches Gift.java handleGiftToUserEmote()
              const recipientLower = giftRecipient.toLowerCase();

              // Rate limit: 60s per sender+recipient+gift combo (matches GiftSingleRateLimitInSeconds)
              // Java: MemCachedRateLimiter.hit(VIRTUAL_GIFT_RATE_LIMIT, sender, recipient, giftId)
              const rlKey = `${senderUsername}:${recipientLower}:${giftName}`;
              const rlNow = Date.now();
              const rlLast = giftSingleRateLimitMap.get(rlKey) ?? 0;
              if (rlNow - rlLast < GIFT_SINGLE_RATE_LIMIT_MS) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only send the same gift to ${giftRecipient} every 60 seconds. Try sending a different gift.` });
                return;
              }

              // Balance check — matches Gift.java: "You do not have enough credit to purchase the gift"
              const sAcct = await storage.getCreditAccount(senderUsername);
              if (sAcct.balance < gift.price) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
                return;
              }

              // Apply rate limit and deduct credit — matches contentBean.buyVirtualGift(...)
              giftSingleRateLimitMap.set(rlKey, rlNow);
              await storage.adjustBalance(senderUsername, -gift.price);

              // Format: << sender [level] gives a/an giftName to recipient [level]! -- msg >>
              // Matches Gift.java handleGiftToUserEmote lines 542-554
              const recipDisp  = await recipientDisplay(giftRecipient);
              const wsSingleDisplay = gift.location64x64Png ? giftName : `${giftName} ${hotkey}`;
              let giftText = `<< ${senderDisplay} gives ${article} ${wsSingleDisplay} to ${recipDisp}!`;
              if (giftPersonalMsg) giftText += ` -- ${giftPersonalMsg}`;
              giftText += " >>";

              const giftMsg = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername, senderColor,
                text: giftText, isSystem: false,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: giftMsg });
              broadcastToRoom(roomId, {
                type: "GIFT", roomId,
                sender: senderUsername, senderColor,
                recipient: giftRecipient, giftName, giftEmoji: hotkey,
                giftImageUrl: gift.location64x64Png ?? undefined,
                price: gift.price, message: giftMsg,
                ...(giftPersonalMsg ? { personalMessage: giftPersonalMsg } : {}),
              });

              // Leaderboard + Reputation for single gift
              recordGiftLeaderboardGW(senderUsername, [giftRecipient]);
              awardReputationScore(senderUsername, "giftSent").catch(() => {});
              awardReputationScore(giftRecipient, "giftReceived").catch(() => {});
            }
            break;
          }
          // ── End /gift interceptor ────────────────────────────────────────────

          // ── /bot, /botstop, /games slash command interceptor ────────────────
          // Mirrors ChatSession.sendFusionMessageToChatRoom() in Java:
          //   messageText.startsWith("/") → handleChatRoomCommand()
          //     /bot <gameType>  → StartBot.java  (admin/mod only)
          //     /bot stop        → StopBot.java   (admin/mod only)
          //     /botstop [! [timeout]] → StopAllBots.java (admin/mod only)
          //     /games           → SendGamesHelpToUser.java (all users)
          if (trimmed.startsWith("/bot") || /^\/games\b/i.test(trimmed)) {
            const slashArgs = trimmed.replace(/^\//, "").split(/\s+/);
            const slashCmd  = slashArgs[0]?.toLowerCase();

            // /games — available to all participants
            if (slashCmd === "games") {
              const games = getRegisteredGames();
              if (games.length === 0) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "No games in this room." });
              } else {
                for (const g of games) {
                  const helpMsg = await storage.postMessage(roomId, {
                    senderUsername: "System", senderColor: "DD587A",
                    text: `To start ${g}, type: /bot ${g}`, isSystem: true,
                  });
                  send(ws, { type: "MESSAGE", roomId, message: helpMsg });
                }
                const helpLink = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "DD587A",
                  text: "For help, see: migWorld", isSystem: true,
                });
                send(ws, { type: "MESSAGE", roomId, message: helpLink });
              }
              break;
            }

            // /bot and /botstop require admin/mod
            const slashRoom = await storage.getChatroom(roomId);
            if (!slashRoom) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Room not found" }); return; }
            const slashIsOwner = slashRoom.createdBy === client.userId;
            const slashIsMod   = await storage.isModUser(roomId, client.userId!);
            if (!slashIsOwner && !slashIsMod) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You need to be owner/mod to use this command." });
              break;
            }

            // /botstop [! [<timeout>]] — StopAllBots.java
            if (slashCmd === "botstop") {
              // arg[1] must be "!" to confirm all-stop
              if (slashArgs[1] !== "!") {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'Usage: /botstop ! [timeout in seconds, 120-3600]' });
                break;
              }
              const timeoutSec = slashArgs[2] ? parseInt(slashArgs[2], 10) : 0;
              if (slashArgs[2] && (isNaN(timeoutSec) || timeoutSec < 120 || timeoutSec > 3600)) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Timeout must be between 120 and 3600 seconds." });
                break;
              }
              const stopped = botStopBot(roomId);
              const stopMsg = stopped
                ? timeoutSec > 0
                  ? `All bots stopped by ${client.username}. Room bots blocked for ${timeoutSec}s.`
                  : `All bots stopped by ${client.username}.`
                : "No active bots to stop.";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "DD587A",
                text: stopMsg, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            // /bot stop — StopBot.java
            if (slashCmd === "bot" && slashArgs[1]?.toLowerCase() === "stop") {
              const stopped = botStopBot(roomId);
              const stopMsg = stopped
                ? `Bot stopped by ${client.username}.`
                : "No active bot to stop.";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "DD587A",
                text: stopMsg, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            // /bot <gameType> — StartBot.java
            if (slashCmd === "bot" && slashArgs[1]) {
              const gameType = slashArgs[1].toLowerCase();
              if (!isRegisteredGame(gameType)) {
                const available = getRegisteredGames().join(", ");
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Unknown game "${gameType}". Available: ${available}` });
                break;
              }
              try {
                await botStartBot(roomId, gameType, client.username!);
                const startMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "DD587A",
                  text: `${client.username} started ${gameType}. Type !help for commands.`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: startMsg });
              } catch (err: any) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: err.message ?? "Failed to start bot." });
              }
              break;
            }

            // /bot with no subcommand — show usage
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: 'Usage: /bot <gameName> | /bot stop. Type /games for available games.' });
            break;
          }
          // ── End /bot,/botstop,/games slash command interceptor ───────────────

          // ── /me — mirrors Alias.java / ChatSession emote action ─────────
          // Usage: /me  → broadcasts just the username to everyone in room
          if (/^\/me(\s|$)/i.test(trimmed)) {
            const meMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "",
              senderColor: "800020", text: `${client.username}`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: meMsg });
            break;
          }

          // ── Emote commands (/slap, /kiss, /8ball, /hug, etc.) ───────────────
          {
            const emTokens  = trimmed.split(/\s+/);
            const emCmd     = emTokens[0].toLowerCase();
            const emTarget  = emTokens[1] ?? "";
            const s         = client.username!;
            const t         = emTarget;
            const EMOTE_COLOR = "800020";

            type EmoteDef = { action: string; actionTarget: string; random?: "roll" | "8ball" | "rps" };
            const EMOTES: Record<string, EmoteDef> = {
              "/slap":       { action: `* ${s} slaps himself`,                         actionTarget: `* ${s} slaps ${t}` },
              "/hug":        { action: `* ${s} gives himself a hug`,                   actionTarget: `* ${s} hugs ${t}` },
              "/kiss":       { action: `* ${s} blows a kiss to the room`,              actionTarget: `* ${s} kisses ${t}` },
              "/wave":       { action: `* ${s} waves`,                                  actionTarget: `* ${s} waves at ${t}` },
              "/dance":      { action: `* ${s} dances`,                                 actionTarget: `* ${s} dances with ${t}` },
              "/cry":        { action: `* ${s} cries`,                                  actionTarget: `* ${s} cries on ${t}'s shoulder` },
              "/laugh":      { action: `* ${s} laughs out loud`,                        actionTarget: `* ${s} laughs at ${t}` },
              "/poke":       { action: `* ${s} pokes himself`,                          actionTarget: `* ${s} pokes ${t}` },
              "/punch":      { action: `* ${s} punches the air`,                        actionTarget: `* ${s} punches ${t}` },
              "/love":       { action: `* ${s} has too much love to give`,              actionTarget: `* ${s} loves ${t}` },
              "/hi":         { action: `* ${s} waves hi to everyone`,                   actionTarget: `* ${s} waves hi at ${t}` },
              "/clap":       { action: `* ${s} claps`,                                  actionTarget: `* ${s} claps for ${t}` },
              "/bow":        { action: `* ${s} bows`,                                   actionTarget: `* ${s} bows to ${t}` },
              "/sit":        { action: `* ${s} sits down`,                              actionTarget: `* ${s} sits next to ${t}` },
              "/stand":      { action: `* ${s} stands up`,                              actionTarget: `* ${s} stands next to ${t}` },
              "/sleep":      { action: `* ${s} falls asleep`,                           actionTarget: `* ${s} falls asleep on ${t}'s shoulder` },
              "/yawn":       { action: `* ${s} yawns`,                                  actionTarget: `* ${s} yawns at ${t}` },
              "/facepalm":   { action: `* ${s} facepalms`,                              actionTarget: `* ${s} facepalms at ${t}` },
              "/shrug":      { action: `* ${s} shrugs`,                                 actionTarget: `* ${s} shrugs at ${t}` },
              "/lol":        { action: `* ${s} LOLs`,                                   actionTarget: `* ${s} LOLs at ${t}` },
              "/think":      { action: `* ${s} is thinking...`,                         actionTarget: `* ${s} is thinking about ${t}` },
              "/wink":       { action: `* ${s} winks`,                                  actionTarget: `* ${s} winks at ${t}` },
              "/smile":      { action: `* ${s} smiles`,                                 actionTarget: `* ${s} smiles at ${t}` },
              "/stare":      { action: `* ${s} stares into the void`,                   actionTarget: `* ${s} stares at ${t}` },
              "/shake":      { action: `* ${s} shakes his head`,                        actionTarget: `* ${s} shakes ${t}'s hand` },
              "/tackle":     { action: `* ${s} tackles himself`,                        actionTarget: `* ${s} tackles ${t}` },
              "/throw":      { action: `* ${s} throws something`,                       actionTarget: `* ${s} throws something at ${t}` },
              "/pat":        { action: `* ${s} pats himself on the back`,               actionTarget: `* ${s} pats ${t} on the head` },
              "/rofl":       { action: `* ${s} rolls on the floor laughing`,            actionTarget: `* ${s} rolls on the floor laughing at ${t}` },
              "/8ball":      { action: `* ${s} asks the Magic 8ball... %r`,             actionTarget: `* ${s} asks the Magic 8ball about ${t}... %r`, random: "8ball" },
              "/flip":       { action: `* ${s} flips a coin... It's %r!`,              actionTarget: `* ${s} flips a coin... It's %r!`, random: "roll" },
              "/rps":        { action: `* ${s} plays rock-paper-scissors... %r!`,       actionTarget: `* ${s} challenges ${t} to rock-paper-scissors... %r!`, random: "rps" },
            };

            const EIGHT_BALL_ANSWERS = ["Yep", "OK", "Maybe", "No", "Don't Bother", "Definitely", "Ask again later", "Not likely"];
            const RPS_CHOICES        = ["Rock 🪨", "Paper 📄", "Scissors ✂️"];

            function resolveEmoteRandom(type?: "roll" | "8ball" | "rps"): string {
              if (type === "roll")   return String(Math.floor(Math.random() * 100) + 1);
              if (type === "8ball")  return EIGHT_BALL_ANSWERS[Math.floor(Math.random() * EIGHT_BALL_ANSWERS.length)];
              if (type === "rps")    return RPS_CHOICES[Math.floor(Math.random() * RPS_CHOICES.length)];
              return "";
            }

            const emoteDef = EMOTES[emCmd];
            if (emoteDef) {
              const rndVal    = resolveEmoteRandom(emoteDef.random);
              const template  = t ? emoteDef.actionTarget : emoteDef.action;
              const emoteText = template.replace(/%r/g, rndVal);
              const emoteMsg  = await storage.postMessage(roomId, {
                senderId: client.userId, senderUsername: "", senderColor: EMOTE_COLOR,
                text: emoteText, isSystem: false,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: emoteMsg });
              break;
            }
          }
          // ── End emote commands ───────────────────────────────────────────────

          // ── /roll — dice roll (emote style, no icon, no asterisk) ──────────
          if (/^\/roll(\s|$)/i.test(trimmed)) {
            const rollValue = Math.floor(Math.random() * 6) + 1;
            const rollMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} rolls ${rollValue}`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: rollMsg });
            break;
          }

          // ── /brb — be right back (emote style, no icon, no asterisk) ────────
          if (/^\/brb(\s|$)/i.test(trimmed)) {
            const brbMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} will be right back`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: brbMsg });
            break;
          }

          // ── /off — going offline (emote style, no icon, no asterisk) ─────────
          if (/^\/off(\s|$)/i.test(trimmed)) {
            const offMsg = await storage.postMessage(roomId, {
              senderId: client.userId, senderUsername: "", senderColor: "800020",
              text: `${client.username} has been off`, isSystem: false,
            });
            broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: offMsg });
            break;
          }

          // ── Admin slash commands via SEND_MESSAGE text (mirrors Java emote routing) ──
          // Parse /lock, /unlock, /kick, /ban, /mute, /unmute, /silence, /unban, /suspend, /block
          if (/^\/(lock|unlock|kick|ban|mute|unmute|silence|unban|suspend|block)(\s|$)/i.test(trimmed)) {
            const parts = trimmed.replace(/^\//, '').split(/\s+/);
            const slashCmd = parts[0].toLowerCase();
            const slashTarget = parts[1] ?? '';
            const slashRoom = await storage.getChatroom(roomId);
            if (!slashRoom) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Room tidak ditemukan" }); return; }
            const slashIsOwner = slashRoom.createdBy === client.userId;
            const slashIsMod   = await storage.isModUser(roomId, client.userId!);
            const slashIsAdmin = slashIsOwner || slashIsMod;
            const slashIsGlobalAdmin = client.isChatroomAdmin;

            if (slashCmd === 'lock' || slashCmd === 'unlock') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              if (slashCmd === 'lock') {
                await storage.updateChatroom(roomId, { maxParticipants: slashRoom.currentParticipants ?? 1 });
                const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom telah dikunci. Member baru tidak dapat bergabung", isSystem: true });
                broadcastToRoom(roomId, { type: "LOCKED", roomId });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              } else {
                await storage.updateChatroom(roomId, { maxParticipants: 50 });
                const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "795548", text: "Chatroom telah dibuka. Member baru dapat bergabung", isSystem: true });
                broadcastToRoom(roomId, { type: "UNLOCKED", roomId });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              }
              break;
            }

            if (!slashTarget) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Usage: /${slashCmd} [username]` }); return; }
            const slashTargetUser = await storage.getUserByUsername(slashTarget);
            if (!slashTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `User "${slashTarget}" tidak ditemukan` }); return; }

            if (slashCmd === 'kick') {
              if (slashIsAdmin) {
                // Admin/mod direct kick — mirrors Kick.java admin path
                await storage.leaveChatroom(roomId, slashTargetUser.id);
                const kickerLabel = slashIsGlobalAdmin
                  ? `administrator ${client.username}`
                  : client.username;
                const kickMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF4444",
                  text: `${slashTarget} has been kicked by ${kickerLabel}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "KICKED", roomId, username: slashTarget });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: kickMsg });
                const pList = await storage.getParticipants(roomId);
                broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              } else {
                // Regular user vote kick — mirrors Kick.java voteToKickUser path
                const voteMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF8C00",
                  text: `${client.username} menginginkan ${slashTarget} di-kick. Ketuk /kick ${slashTarget} untuk vote.`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: voteMsg });
              }
              break;
            }

            if (slashCmd === 'ban') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              await storage.banUser(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF4444", text: `${slashTarget} telah di-ban dari chatroom`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "BANNED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'mute') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              await storage.muteUser(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${slashTarget} telah di-mute dan tidak dapat mengetik`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'unmute') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              await storage.unmuteUser(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget} sudah di-unmute`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              break;
            }

            if (slashCmd === 'silence') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              const timeoutSecs = parseInt(parts[2] ?? '60', 10);
              if (isNaN(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 86400) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /silence [username] [detik 1-86400]" }); return;
              }
              await storage.silenceUser(roomId, slashTargetUser.id, slashTargetUser.username, timeoutSecs);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "FF8C00", text: `${slashTarget} di-silence selama ${timeoutSecs} detik. Akan otomatis aktif kembali setelah waktu habis.`, isSystem: true });
              const pList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: slashTarget });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, slashRoom.name, pList));
              setTimeout(async () => {
                try {
                  await storage.unmuteUser(roomId, slashTargetUser.id);
                  const unsilMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget} silence telah berakhir.`, isSystem: true });
                  broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: slashTarget });
                  broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsilMsg });
                } catch {}
              }, timeoutSecs * 1000);
              break;
            }

            if (slashCmd === 'unban') {
              if (!slashIsAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              await storage.unbanUser(roomId, slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "4CAF50", text: `${slashTarget} telah di-unban dari chatroom`, isSystem: true });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            if (slashCmd === 'suspend') {
              if (!slashIsGlobalAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa suspend user" }); return; }
              await storage.suspendUser(slashTargetUser.id);
              const sysMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "F47422", text: `${slashTarget} telah di-suspend oleh administrator`, isSystem: true });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              break;
            }

            if (slashCmd === 'block') {
              await storage.blockUserGlobal(client.username!, slashTarget);
              const blockMsg = await storage.postMessage(roomId, { senderUsername: "System", senderColor: "607D8B", text: `Kamu tidak akan melihat pesan dari ${slashTarget} lagi.`, isSystem: true });
              send(ws, { type: "MESSAGE", roomId, message: blockMsg });
              break;
            }
            break;
          }

          // ── Bot command interceptor ──────────────────────────────────────────
          // Route !commands to the active bot game in this room (if any).
          // Mirrors ChatSession.sendFusionMessageToChatRoom(): messageText.startsWith("!")
          //   → chatRoomPrx.sendMessageToBots(username, text, receivedTimestamp)
          // When handled by the bot, skip normal message posting.
          if (trimmed.startsWith("!") && botProcessMessage(roomId, client.username!, trimmed)) {
            break;
          }
          // ── End bot command interceptor ──────────────────────────────────────

          const message = await storage.postMessage(roomId, {
            senderId: client.userId, senderUsername: client.username!,
            senderColor, text: text.trim(),
          });
          broadcastToRoom(roomId, { type: "MESSAGE", roomId, message });
          awardReputationScore(client.username!, "chatRoomMessage").catch(() => {});
          break;
        }

        // ── SEND_GIFT ─────────────────────────────────────────────────────────
        // Matches /gift [recipient|all] [giftName] from ChatController.java
        // When recipient === "all": shower format + billing msg (matches GiftAsync.java)
        case "SEND_GIFT": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId: gRoomId, recipient, giftName, giftEmoji = "🎁", giftMessage } = msg;
          if (!gRoomId || !recipient || !giftName) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId, recipient, dan giftName wajib" }); return;
          }
          if (!client.subscribedRooms.has(gRoomId)) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Harus subscribe ke room dulu" }); return;
          }
          const gSenderUsername = client.username!;
          const gSenderDisplay  = withGiftLevel(gSenderUsername, client.migLevel);
          const gArticle        = /^[aeiou]/i.test(giftName) ? "an" : "a";
          const gHotkey         = giftEmoji;
          // Use role color if available for this room, else user-chosen chatColor
          const gSenderColor    = client.roleColors.get(gRoomId) ?? client.chatColor;

          // Look up gift from catalog for accurate price
          const giftRecord = await storage.getVirtualGiftByName(giftName);
          const giftPrice  = giftRecord?.price ?? (msg as any).price ?? 10;

          const isAll = recipient.toLowerCase() === "all";

          if (isAll) {
            // ── SEND_GIFT all — shower format (matches GiftAsync.giftAll) ──
            const now      = Date.now();
            const lastSent = giftAllLastSent.get(gSenderUsername) ?? 0;
            if (now - lastSent < GIFT_ALL_RATE_LIMIT_MS) {
              const waitSec = Math.ceil((GIFT_ALL_RATE_LIMIT_MS - (now - lastSent)) / 1000);
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only use /gift all every 60 seconds. Try again in ${waitSec}s.` });
              return;
            }
            const allParts = await storage.getParticipants(gRoomId);
            const gRecipients = allParts
              .map(p => p.username)
              .filter(u => u.toLowerCase() !== gSenderUsername.toLowerCase());

            if (gRecipients.length === 0) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "There are no other users in the room." });
              return;
            }
            const gTotalCost = giftPrice * gRecipients.length;
            const gAcct      = await storage.getCreditAccount(gSenderUsername);
            if (gAcct.balance < gTotalCost) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
              return;
            }
            giftAllLastSent.set(gSenderUsername, now);
            const gUpdatedAll = await storage.adjustBalance(gSenderUsername, -gTotalCost);
            const gAcctAll    = await storage.getCreditAccount(gSenderUsername);
            storage.createCreditTransaction({
              username: gSenderUsername,
              type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
              reference: `GW-GIFT-ALL-${Date.now()}`,
              description: `Gift shower: ${giftName} ke ${gRecipients.length} user`,
              currency: gAcctAll.currency,
              amount: -gTotalCost,
              fundedAmount: 0,
              tax: 0,
              runningBalance: gUpdatedAll.balance,
            }).catch(() => {});
            const gRemaining = gAcctAll;

            // Shower message — matches GiftAsync.sendGiftShowerMessageToAllUsersInChat()
            const gRecipList = implodeUserList(gRecipients, 5);
            let giftText = `<< (shower) *GIFT SHOWER* ${gSenderDisplay} gives ${gArticle} ${giftName} ${gHotkey} to ${gRecipList}! Hurray!`;
            if (giftMessage) giftText += ` -- ${giftMessage}`;
            giftText += " >>";

            const giftMsg = await storage.postMessage(gRoomId, {
              senderId: client.userId, senderUsername: gSenderUsername,
              senderColor: gSenderColor, text: giftText, isSystem: false,
            });
            broadcastToRoom(gRoomId, { type: "MESSAGE", roomId: gRoomId, message: giftMsg });
            broadcastToRoom(gRoomId, {
              type: "GIFT", roomId: gRoomId,
              sender: gSenderUsername, senderColor: gSenderColor,
              recipient: "all", giftName, giftEmoji: gHotkey,
              price: gTotalCost, recipientCount: gRecipients.length,
              message: giftMsg,
              ...(giftMessage ? { personalMessage: giftMessage } : {}),
            });
            // Billing message to sender only — matches GiftAllBillingMessageData.java
            send(ws, {
              type: "GIFT_BILLING",
              message: `Congratulations for sending gifts! You have used ${gTotalCost} MIG and your estimated remaining balance after gifting will be ${gRemaining.balance.toFixed(2)} MIG.`,
              totalCost: gTotalCost, remainingBalance: gRemaining.balance, currency: "MIG",
            });
            recordGiftLeaderboardGW(gSenderUsername, gRecipients, gRecipients.length);
            awardReputationScore(gSenderUsername, "giftSent", gRecipients.length).catch(() => {});
            for (const gr of gRecipients) {
              awardReputationScore(gr, "giftReceived").catch(() => {});
            }
          } else {
            // ── SEND_GIFT single user — matches Gift.java handleGiftToUserEmote() ──
            const gRecipientLower = recipient.toLowerCase();

            // Rate limit: 60s per sender+recipient+gift combo (GiftSingleRateLimitInSeconds)
            const gRlKey = `${gSenderUsername}:${gRecipientLower}:${giftName}`;
            const gRlNow = Date.now();
            const gRlLast = giftSingleRateLimitMap.get(gRlKey) ?? 0;
            if (gRlNow - gRlLast < GIFT_SINGLE_RATE_LIMIT_MS) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `You can only send the same gift to ${recipient} every 60 seconds. Try sending a different gift.` });
              return;
            }

            // Balance check — "You do not have enough credit to purchase the gift"
            const gSAcct = await storage.getCreditAccount(gSenderUsername);
            if (gSAcct.balance < giftPrice) {
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "You do not have enough credit to purchase the gift" });
              return;
            }

            // Apply rate limit and deduct credit — matches contentBean.buyVirtualGift(...)
            giftSingleRateLimitMap.set(gRlKey, gRlNow);
            const gUpdatedSingle = await storage.adjustBalance(gSenderUsername, -giftPrice);
            const gAcctSingle    = await storage.getCreditAccount(gSenderUsername);
            storage.createCreditTransaction({
              username: gSenderUsername,
              type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
              reference: `GW-GIFT-${Date.now()}`,
              description: `Gift: ${giftName} dikirim ke @${recipient}`,
              currency: gAcctSingle.currency,
              amount: -giftPrice,
              fundedAmount: 0,
              tax: 0,
              runningBalance: gUpdatedSingle.balance,
            }).catch(() => {});

            // Format: << sender [level] gives a/an giftName hotKey to recipient [level]! -- msg >>
            const displayRecip = await recipientDisplay(recipient);
            let giftText = `<< ${gSenderDisplay} gives ${gArticle} ${giftName} ${gHotkey} to ${displayRecip}!`;
            if (giftMessage) giftText += ` -- ${giftMessage}`;
            giftText += " >>";

            const giftMsg = await storage.postMessage(gRoomId, {
              senderId: client.userId, senderUsername: gSenderUsername,
              senderColor: gSenderColor, text: giftText, isSystem: false,
            });
            broadcastToRoom(gRoomId, { type: "MESSAGE", roomId: gRoomId, message: giftMsg });
            broadcastToRoom(gRoomId, {
              type: "GIFT", roomId: gRoomId,
              sender: gSenderUsername, senderColor: gSenderColor,
              recipient, giftName, giftEmoji: gHotkey, price: giftPrice,
              message: giftMsg,
              ...(giftMessage ? { personalMessage: giftMessage } : {}),
            });
            recordGiftLeaderboardGW(gSenderUsername, [recipient]);
            awardReputationScore(gSenderUsername, "giftSent").catch(() => {});
            awardReputationScore(recipient, "giftReceived").catch(() => {});
            // Record in virtual_gifts_received so profile gift count is persisted
            storage.createVirtualGiftReceived({
              username: recipient,
              sender: gSenderUsername,
              virtualGiftId: 0,
              message: `${giftName} ${gHotkey}`.trim(),
              isPrivate: 0,
            }).catch(() => {});
          }
          break;
        }

        // ── GET_COLORS ────────────────────────────────────────────────────────
        // Matches FusionPktDataTextColor (packet 924) — returns available color palettes
        case "GET_COLORS": {
          send(ws, { type: "COLOR_LIST", senderColors: TEXT_SENDER_COLORS, messageColors: TEXT_MESSAGE_COLORS });
          break;
        }

        // ── SET_COLOR ─────────────────────────────────────────────────────────
        // Lets user change their chat username color from the TEXT_COLOR palette
        case "SET_COLOR": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { color } = msg;
          if (!TEXT_SENDER_COLORS.includes(color.replace(/^#/, ""))) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Warna tidak valid. Gunakan GET_COLORS untuk daftar warna." }); return;
          }
          client.chatColor = color.replace(/^#/, "");
          // Update roleColors cache for all subscribed rooms — if user's cached color
          // is not a role-specific special color (owner/mod=FCC504, merchant=990099 etc.),
          // replace it with the new chatColor so SEND_MESSAGE immediately picks up the change.
          const ROLE_SPECIAL_COLORS = new Set(["FCC504", "990099", "F47422", "FF2EA7", "FF0000"]);
          for (const scRoomId of Array.from(client.subscribedRooms)) {
            const cached = client.roleColors.get(scRoomId);
            if (!cached || !ROLE_SPECIAL_COLORS.has(cached)) {
              client.roleColors.set(scRoomId, client.chatColor);
            }
            broadcastToRoom(scRoomId, { type: "COLOR_CHANGED", roomId: scRoomId, username: client.username!, color: client.chatColor });
          }
          send(ws, { type: "CMD_OK", cmd: "set_color", target: client.chatColor });
          break;
        }

        // ── CMD (admin commands) ──────────────────────────────────────────────
        // Matches chatroom admin command handling in backend app
        case "CMD": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" });
            return;
          }
          const { roomId, cmd, target, message: cmdMsg } = msg;
          const room = await storage.getChatroom(roomId);
          if (!room) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Chatroom tidak ditemukan" });
            return;
          }
          const isOwner = room.createdBy === client.userId;
          const isMod   = await storage.isModUser(roomId, client.userId!);
          const isAdmin = isOwner || isMod;

          const ownerOnlyCmds = ["mod", "unmod", "lock", "unlock", "description"];
          const adminCmds = ["kick", "ban", "mute", "unmute", "warn", "kill", "bump", "broadcast", "announce", "announce_off", "silence", "unban"];
          if (ownerOnlyCmds.includes(cmd) && !isOwner) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner yang bisa" }); return;
          }
          if (adminCmds.includes(cmd) && !isAdmin) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return;
          }

          const needsTarget = ["kick","kill","ban","mute","unmute","mod","unmod","warn","silence","unban","suspend","block"];
          if (needsTarget.includes(cmd) && !target) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Target wajib" }); return;
          }

          let targetUser = target ? await storage.getUserByUsername(target) : null;
          if (["kick","kill","ban","mute","unmute","mod","unmod","warn"].includes(cmd) && !targetUser) {
            send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return;
          }

          switch (cmd) {
            case "kick": case "kill": {
              await storage.leaveChatroom(roomId, targetUser!.id);
              // Mirrors Kick.java: isGlobalAdmin → "kicked by administrator {username}"
              //                   isOwner/isMod → "kicked by {username}"
              //                   kill → "dikeluarkan paksa oleh {username}"
              const kickerLabel = client.isChatroomAdmin
                ? `administrator ${client.username}`
                : client.username;
              const kickText = cmd === "kill"
                ? `${target} dikeluarkan paksa oleh ${client.username}`
                : `${target} has been kicked by ${kickerLabel}`;
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF4444",
                text: kickText, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "KICKED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "ban": {
              await storage.banUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF4444",
                text: `${target} telah di-ban dari chatroom`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "BANNED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "mute": {
              await storage.muteUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} telah di-mute`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "unmute": {
              await storage.unmuteUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${target} sudah di-unmute`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "mod": {
              await storage.modUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "9C27B0",
                text: `${target} telah dipromosikan menjadi Mod`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MOD", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "unmod": {
              await storage.unmodUser(roomId, targetUser!.id);
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "9C27B0",
                text: `${target} telah dicopot dari Mod`, isSystem: true,
              });
              const list = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "UNMOD", roomId, username: target! });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, list));
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "warn": {
              const note = cmdMsg ? ` — "${cmdMsg}"` : "";
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} mendapat peringatan${note}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "WARNED", roomId, username: target!, message: cmdMsg });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }
            case "lock": {
              const r = await storage.getChatroom(roomId);
              await storage.updateChatroom(roomId, { maxParticipants: r?.currentParticipants ?? 1 });
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "795548",
                text: "Chatroom telah dikunci. Member baru tidak dapat bergabung", isSystem: true,
              });
              broadcastToRoom(roomId, { type: "LOCKED", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "unlock": {
              await storage.updateChatroom(roomId, { maxParticipants: 50 });
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "795548",
                text: "Chatroom telah dibuka. Member baru dapat bergabung", isSystem: true,
              });
              broadcastToRoom(roomId, { type: "UNLOCKED", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "bump": {
              await storage.updateChatroom(roomId, { createdAt: new Date() });
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `Chatroom di-bump oleh ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "broadcast": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Pesan wajib" }); return;
              }
              const sysMsg = await storage.postMessage(roomId, {
                senderUsername: client.username!, senderColor: "2196F3",
                text: `[Broadcast] ${cmdMsg.trim()}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            // ── /announce — mirrors Announce.java chatRoomPrx.announceOn/Off ─────
            // Usage: /announce [message] [time] or /announce off
            // time must be 120-3600 seconds (3-4 digits, matches Announce.java validation).
            // waitTime = -1 → one-shot (no repeat). 120-3600 → repeat every N seconds.
            // Max message length: 320 chars (matches Announce.java hardcoded limit).
            case "announce_off": {
              clearAnnounceTimer(roomId);
              const offMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "607D8B",
                text: `📢 Announcement dimatikan oleh ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "ANNOUNCEMENT_OFF", roomId });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: offMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }
            case "announce": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /announce [pesan] [waktu] atau /announce off" }); return;
              }
              const rawAnnounce = cmdMsg.trim();
              // Matches Announce.java: max 320 chars
              if (rawAnnounce.length > 320) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Pesan tidak boleh lebih dari 320 karakter." }); return;
              }
              // Parse waitTime from message — mirrors Announce.java Pattern "^(.*) ([0-9]+)$"
              // waitTime passed from client, or try to parse from trailing number in message
              let announceMsg = rawAnnounce;
              let waitTime: number = msg.waitTime ?? -1;
              if (waitTime === -1) {
                const trailMatch = rawAnnounce.match(/^(.*)\s+([0-9]+)$/);
                if (trailMatch) {
                  const parsed = parseInt(trailMatch[2], 10);
                  const s = trailMatch[2];
                  if (s.length >= 3 && s.length <= 4 && parsed >= 120 && parsed <= 3600) {
                    announceMsg = trailMatch[1];
                    waitTime = parsed;
                  }
                }
              } else {
                // waitTime provided explicitly — validate range (mirrors Announce.java 120-3600)
                if (waitTime < 120 || waitTime > 3600) {
                  send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Waktu tidak valid. Harus antara 120 sampai 3600 detik." }); return;
                }
              }
              // Clear any existing timer for this room before starting new one
              clearAnnounceTimer(roomId);
              const sendAnnounce = async () => {
                const room2 = await storage.getChatroom(roomId);
                if (!room2) { clearAnnounceTimer(roomId); return; }
                const sysMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "2196F3",
                  text: `📢 [Announcement] ${announceMsg}`, isSystem: true,
                });
                broadcastToRoom(roomId, { type: "ANNOUNCEMENT", roomId, message: announceMsg });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: sysMsg });
              };
              // Fire once immediately, then repeat if waitTime > 0
              await sendAnnounce();
              if (waitTime > 0) {
                const timer = setInterval(sendAnnounce, waitTime * 1000);
                announceTimers.set(roomId, timer);
              }
              send(ws, { type: "CMD_OK", cmd, ...(waitTime > 0 ? { waitTime } : {}) });
              break;
            }
            // ── getmyluck — mirrors GetMyLuck.java EmoteCommand ──────────────────
            // Usage: /getmyluck
            // Generates 4 luck values (1-5) for the caller, cached per-user per-day in Redis.
            // Mirrors MemCachedClientWrapper.add (add-only if not exists) — same values all day.
            // TTL = 24 hours; re-generates on parse error (mirrors Java fallback logic).
            // Broadcasts to all users in room — mirrors sendMessageToAllUsersInChat.
            // Categories (mig33 tradition): Love / Career / Health / Luck (1-5 stars each).
            case "getmyluck": {
              // Redis key mirrors MemCachedKeySpaces.CommonKeySpace.EMOTE_GETMYLUCK pattern
              const luckKey = `getmyluck:${client.username}`;
              const LUCK_TTL = 24 * 60 * 60; // 24 hours — daily reset
              let luckValues: number[] = [];
              let redis: ReturnType<typeof getRedisClient> | null = null;
              try { redis = getRedisClient(); } catch { /* Redis unavailable — generate fresh */ }
              let cached: string | null = null;
              if (redis) {
                try { cached = await redis.get(luckKey); } catch { /* ignore */ }
              }
              const VALUE_RE = /^([1-5]):([1-5]):([1-5]):([1-5])$/;
              if (cached && VALUE_RE.test(cached)) {
                // Mirrors: VALUE_PATTERN.matcher(luckValue).matches() — parse cached
                luckValues = cached.split(':').map(Number);
              } else {
                // Mirrors: RANDOM_GENERATOR.nextInt(5) + 1  (SecureRandom, 1-5 inclusive)
                luckValues = Array.from({ length: 4 }, () => Math.floor(Math.random() * 5) + 1);
                const serialized = luckValues.join(':');
                if (redis) {
                  try {
                    // Mirrors: MemCachedClientWrapper.add — only stores if key absent
                    const nx = await redis.set(luckKey, serialized, 'EX', LUCK_TTL, 'NX');
                    if (!nx) {
                      // Another request stored first — read their value (mirrors Java add() fallback)
                      const freshCached = await redis.get(luckKey);
                      if (freshCached && VALUE_RE.test(freshCached)) {
                        luckValues = freshCached.split(':').map(Number);
                      }
                    }
                  } catch { /* ignore */ }
                }
              }
              const [love, career, health, luck] = luckValues;
              const stars = (n: number) => '⭐'.repeat(n);
              const gmlMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF9800",
                text: `🔮 Luck of ${client.username} hari ini — ` +
                      `Cinta: ${stars(love)} | Karir: ${stars(career)} | ` +
                      `Kesehatan: ${stars(health)} | Keberuntungan: ${stars(luck)}`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "GET_MY_LUCK", roomId, username: client.username!, love, career, health, luck });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: gmlMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── follow — mirrors Follow.java EmoteCommand ─────────────────────────
            // Usage: /follow [username] or /f [username]
            // Adds usernameToFollow as contact for caller.
            // sendMessageToSender only — only caller sees "You are now following…"
            // Mirrors: Follow.java line 64-65 (messageText + sendMessageToSender).
            // Not admin-only; available to all authenticated users.
            case "follow":
            case "f": {
              const followTarget = cmdMsg?.trim();
              if (!followTarget) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /follow [username]" }); return;
              }
              if (followTarget.toLowerCase() === client.username?.toLowerCase()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Tidak bisa follow diri sendiri" }); return;
              }
              const followTargetUser = await storage.getUserByUsername(followTarget);
              if (!followTargetUser) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `User "${followTarget}" tidak ditemukan` }); return;
              }
              const callerUser = await storage.getUserByUsername(client.username!);
              if (!callerUser) break;

              // One-way follow (legacy phone-book)
              await storage.followUser(client.username!, followTargetUser.username);

              // ── Also send contact request so target gets notified & can accept ──
              // Skip if already friends
              const [alreadyFriendF] = await db
                .select()
                .from(friendships)
                .where(and(eq(friendships.userId, callerUser.id), eq(friendships.friendUserId, followTargetUser.id)));

              if (!alreadyFriendF) {
                // Check for reverse request → auto-accept
                const [reverseF] = await db
                  .select()
                  .from(contactRequests)
                  .where(and(
                    eq(contactRequests.fromUserId, followTargetUser.id),
                    eq(contactRequests.toUserId, callerUser.id),
                    eq(contactRequests.status, "pending"),
                  ));

                const callerProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, callerUser.id)).then(r => r[0]);
                const callerDisplay = callerUser.displayName ?? callerProfile?.aboutMe ?? callerUser.username;
                const targetProfile = await db.select().from(userProfiles).where(eq(userProfiles.userId, followTargetUser.id)).then(r => r[0]);
                const targetDisplay = followTargetUser.displayName ?? targetProfile?.aboutMe ?? followTargetUser.username;

                if (reverseF) {
                  // Auto-accept
                  await db.update(contactRequests)
                    .set({ status: "accepted" })
                    .where(eq(contactRequests.id, reverseF.id));
                  const fId = randomUUID();
                  await db.insert(friendships).values([
                    { id: fId, userId: callerUser.id, friendUserId: followTargetUser.id, friendUsername: followTargetUser.username, friendDisplayName: targetDisplay },
                    { id: randomUUID(), userId: followTargetUser.id, friendUserId: callerUser.id, friendUsername: callerUser.username, friendDisplayName: callerDisplay },
                  ]);
                  broadcastToUser(callerUser.id, { type: "CONTACT_ACCEPTED", byUsername: followTargetUser.username, byDisplayName: targetDisplay, friendshipId: fId });
                  broadcastToUser(followTargetUser.id, { type: "CONTACT_ACCEPTED", byUsername: callerUser.username, byDisplayName: callerDisplay, friendshipId: fId });
                } else {
                  // Check no duplicate pending
                  const [existingF] = await db
                    .select()
                    .from(contactRequests)
                    .where(and(
                      eq(contactRequests.fromUserId, callerUser.id),
                      eq(contactRequests.toUserId, followTargetUser.id),
                      eq(contactRequests.status, "pending"),
                    ));

                  if (!existingF) {
                    const [newReq] = await db
                      .insert(contactRequests)
                      .values({
                        id: randomUUID(),
                        fromUserId: callerUser.id,
                        fromUsername: callerUser.username,
                        fromDisplayName: callerDisplay,
                        toUserId: followTargetUser.id,
                        toUsername: followTargetUser.username,
                        status: "pending",
                      })
                      .returning();

                    broadcastToUser(followTargetUser.id, {
                      type: "CONTACT_REQUEST",
                      requestId: newReq.id,
                      fromUsername: callerUser.username,
                      fromDisplayName: callerDisplay,
                    });
                    // Persist UNS ALERT for offline users
                    try {
                      await storage.createNotification({
                        username: followTargetUser.username,
                        type: "ALERT",
                        subject: "Permintaan Pertemanan",
                        message: `${callerUser.username} ingin berteman denganmu. Buka notifikasi untuk menerima atau menolak.`,
                        status: 1,
                      });
                    } catch {}
                  }
                }
              }

              // Mirrors Follow.java: sendMessageToSender (only caller sees this, NOT broadcast)
              send(ws, { type: "FOLLOW_OK", username: followTargetUser.username });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── unfollow — companion to Follow.java ───────────────────────────────
            // Usage: /unfollow [username]
            // Removes follow relationship; only caller sees confirmation.
            case "unfollow": {
              const unfollowTarget = cmdMsg?.trim();
              if (!unfollowTarget) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /unfollow [username]" }); return;
              }
              await storage.unfollowUser(client.username!, unfollowTarget);
              // sendMessageToSender only — mirrors Follow.java pattern
              send(ws, { type: "UNFOLLOW_OK", username: unfollowTarget });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── flames — mirrors Flames.java EmoteCommand ─────────────────────────
            // Usage: /flames [user1] [user2]
            // Computes shared-character score, maps via score % 6 to FLAMES_VALUES.
            // score == 0 → "Too bad, not a match" (mirrors Flames.java DEFAULT_NO_MATCH_MESSAGE)
            // Available to all users (not admin-only), broadcasts to entire room.
            case "flames": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /flames [user1] [user2]" }); return;
              }
              const flParts = cmdMsg.trim().split(/\s+/);
              if (flParts.length < 2) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /flames [user1] [user2]" }); return;
              }
              const flUser1 = flParts[0];
              const flUser2 = flParts[1];
              const flScore = getFlamesScore(flUser1, flUser2);
              if (flScore === 0) {
                // Mirrors Flames.java DEFAULT_NO_MATCH_MESSAGE
                const nmMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "9E9E9E",
                  text: `😔 Sayang sekali, ${flUser1} dan ${flUser2} tidak cocok.`,
                  isSystem: true,
                });
                broadcastToRoom(roomId, { type: "FLAMES_NO_MATCH", roomId, user1: flUser1, user2: flUser2 });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: nmMsg });
              } else {
                const flVal = FLAMES_VALUES[flScore % FLAMES_VALUES.length];
                const flMsg = await storage.postMessage(roomId, {
                  senderUsername: "System", senderColor: "FF5722",
                  text: `🔥 ${flUser1} dan ${flUser2}: ${flVal.emoji} ${flVal.letter} — ${flVal.label}!`,
                  isSystem: true,
                });
                broadcastToRoom(roomId, { type: "FLAMES", roomId, user1: flUser1, user2: flUser2, letter: flVal.letter, label: flVal.label, emoji: flVal.emoji });
                broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: flMsg });
              }
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── lovematch — mirrors LoveMatch.java EmoteCommand ──────────────────
            // Usage: /lovematch [user1] [user2]
            // Broadcasts love score (0-100) between two users to entire room.
            // Available to all users (not admin-only), matches Java non-filtering behaviour.
            case "lovematch": {
              if (!cmdMsg?.trim()) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /lovematch [user1] [user2]" }); return;
              }
              const lmParts = cmdMsg.trim().split(/\s+/);
              if (lmParts.length < 2) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /lovematch [user1] [user2]" }); return;
              }
              const lmUser1 = lmParts[0];
              const lmUser2 = lmParts[1];
              const lmScore = getLoveMatchScore(lmUser1, lmUser2);
              // Mirrors LoveMatch.java sendMessageToAllUsersInChat — broadcast to entire room
              const lmMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "E91E63",
                text: `💕 ${lmUser1} dan ${lmUser2} memiliki love match score: ${lmScore}%`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "LOVE_MATCH", roomId, user1: lmUser1, user2: lmUser2, score: lmScore });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: lmMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── findmymatch — mirrors FindMyMatch.java EmoteCommand ───────────────
            // Usage: /findmymatch
            // Finds the best love match for the caller among all visible room users.
            // Broadcasts result to entire room — mirrors sendMessageToAllUsersInChat.
            // Error if no other users in chat — mirrors FusionException with "No Match" message.
            case "findmymatch": {
              // Get all visible usernames in room, excluding the caller
              // Mirrors: chatSource.getVisibleUsernamesInChat(false)
              const roomUsers: string[] = [];
              clients.forEach((c) => {
                if (
                  c.state === "AUTHENTICATED" &&
                  c.subscribedRooms.has(roomId) &&
                  c.username !== client.username
                ) {
                  roomUsers.push(c.username!);
                }
              });
              if (roomUsers.length === 0) {
                // Mirrors FusionException("No Match - there are no other users in the chat")
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "No Match - there are no other users in the chat" }); return;
              }
              // Find user with highest love match score — mirrors FindMyMatch.java loop
              let fmmBest = roomUsers[0];
              let fmmMax  = getLoveMatchScore(client.username!, fmmBest);
              for (const u of roomUsers.slice(1)) {
                const s = getLoveMatchScore(client.username!, u);
                if (s > fmmMax) { fmmMax = s; fmmBest = u; }
              }
              const fmmMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "E91E63",
                text: `💕 Match terbaik ${client.username} adalah ${fmmBest} dengan score: ${fmmMax}%`,
                isSystem: true,
              });
              broadcastToRoom(roomId, { type: "FIND_MY_MATCH", roomId, seeker: client.username!, match: fmmBest, score: fmmMax });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: fmmMsg });
              send(ws, { type: "CMD_OK", cmd });
              break;
            }

            // ── silence — timed mute, mirrors Silence.java EmoteCommand ──────────
            // Usage: /silence [username] [seconds]
            // Mirrors: chatroomPrx.silenceUser(username, timeoutSeconds) in Silence.java
            // Auto-unmutes after timeoutSeconds via setTimeout; stores in DB with mutedUntil.
            case "silence": {
              if (!isAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /silence [username] [detik]" }); return; }
              const silTargetUser = await storage.getUserByUsername(target);
              if (!silTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              const timeoutSecs = parseInt(String(msg.timeoutSecs ?? cmdMsg ?? '60'), 10);
              if (isNaN(timeoutSecs) || timeoutSecs < 1 || timeoutSecs > 86400) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Durasi harus antara 1 dan 86400 detik" }); return;
              }
              await storage.silenceUser(roomId, silTargetUser.id, silTargetUser.username, timeoutSecs);
              const silMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "FF8C00",
                text: `${target} di-silence selama ${timeoutSecs} detik oleh ${client.username}`, isSystem: true,
              });
              const silList = await storage.getParticipants(roomId);
              broadcastToRoom(roomId, { type: "MUTED", roomId, username: target });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: silMsg });
              broadcastToRoom(roomId, buildParticipantsPayload(roomId, room.name, silList));
              send(ws, { type: "CMD_OK", cmd, target });
              setTimeout(async () => {
                try {
                  await storage.unmuteUser(roomId, silTargetUser.id);
                  const unsilMsg = await storage.postMessage(roomId, {
                    senderUsername: "System", senderColor: "4CAF50",
                    text: `${target} silence telah berakhir.`, isSystem: true,
                  });
                  broadcastToRoom(roomId, { type: "UNMUTED", roomId, username: target });
                  broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unsilMsg });
                } catch {}
              }, timeoutSecs * 1000);
              break;
            }

            // ── unban — mirrors Unban.java EmoteCommand ───────────────────────────
            // Usage: /unban [username]
            case "unban": {
              if (!isAdmin) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya owner/mod yang bisa" }); return; }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /unban [username]" }); return; }
              const unbanTargetUser = await storage.getUserByUsername(target);
              if (!unbanTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              await storage.unbanUser(roomId, unbanTargetUser.id);
              const unbanMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "4CAF50",
                text: `${target} telah di-unban oleh ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: unbanMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            // ── suspend — global admin only, mirrors Suspend.java ─────────────────
            // Usage: /suspend [username] — permanently disables the account
            case "suspend": {
              if (!client.isChatroomAdmin) {
                send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Hanya global admin yang bisa suspend user" }); return;
              }
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /suspend [username]" }); return; }
              const suspTargetUser = await storage.getUserByUsername(target);
              if (!suspTargetUser) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "User tidak ditemukan" }); return; }
              await storage.suspendUser(suspTargetUser.id);
              // Kick them from all rooms
              await storage.leaveChatroom(roomId, suspTargetUser.id);
              const suspMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "F47422",
                text: `${target} telah di-suspend oleh administrator ${client.username}`, isSystem: true,
              });
              broadcastToRoom(roomId, { type: "KICKED", roomId, username: target });
              broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: suspMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            // ── block — mirrors Block.java EmoteCommand ───────────────────────────
            // Usage: /block [username] — adds to personal block list (caller only)
            case "block": {
              if (!target) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "Usage: /block [username]" }); return; }
              await storage.blockUserGlobal(client.username!, target);
              const blockMsg = await storage.postMessage(roomId, {
                senderUsername: "System", senderColor: "607D8B",
                text: `Kamu tidak akan melihat pesan dari ${target} lagi.`, isSystem: true,
              });
              send(ws, { type: "MESSAGE", roomId, message: blockMsg });
              send(ws, { type: "CMD_OK", cmd, target });
              break;
            }

            default:
              send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: `Unknown cmd: ${cmd}` });
          }
          break;
        }

        // ── GET_ROOMS ─────────────────────────────────────────────────────────
        // Matches ChatRoomList pagination in backend app (pageSize=5)
        case "GET_ROOMS": {
          const PAGE_SIZE = 5;
          const page = msg.page ?? 1;
          const allRooms = msg.categoryId
            ? await storage.getChatroomsByCategory(msg.categoryId)
            : await storage.getChatrooms();
          const totalPages = Math.ceil(allRooms.length / PAGE_SIZE);
          const chatrooms = allRooms.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
          send(ws, { type: "ROOMS_LIST", chatrooms, page, totalPages });
          break;
        }

        // ── GET_MESSAGES ──────────────────────────────────────────────────────
        // Matches FusionPktGetMessages / RedisChatSyncStore in backend app
        // Supports two cursor modes:
        //   after  → backlog (messages AFTER a timestamp, used for reconnect)
        //   before → history (messages BEFORE a timestamp, used for pull-to-refresh)
        // Returns { type: "HISTORY" } so the client can prepend instead of append.
        case "GET_MESSAGES": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "ERROR", code: ErrorCode.INCORRECT_CREDENTIAL, message: "Belum login" }); return;
          }
          const { roomId, after, before } = msg;
          if (!roomId) { send(ws, { type: "ERROR", code: ErrorCode.UNDEFINED, message: "roomId wajib" }); return; }
          const limit = msg.limit ?? 50;
          const messages = await storage.getMessages(roomId, { after, before, limit: limit + 1 });
          const hasMore = messages.length > limit;
          const page = hasMore ? messages.slice(0, limit) : messages;
          send(ws, { type: "HISTORY", roomId, messages: page, hasMore });
          break;
        }

        // ── GET_PARTICIPANTS ──────────────────────────────────────────────────
        // Matches FusionPktChatRoomParticipantsOld (708) in backend app
        case "GET_PARTICIPANTS": {
          const { roomId } = msg;
          const room = await storage.getChatroom(roomId);
          const list = await storage.getParticipants(roomId);
          send(ws, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
          break;
        }

        // ── GET_THEME ─────────────────────────────────────────────────────────
        case "GET_THEME": {
          send(ws, { type: "THEME", roomId: msg.roomId, theme: DEFAULT_THEME });
          break;
        }

        // ── GET_STATS ─────────────────────────────────────────────────────────
        case "GET_STATS": {
          send(ws, { type: "STATS", ...getGatewayStats() });
          break;
        }

        // ── PING ──────────────────────────────────────────────────────────────
        case "PING": {
          send(ws, { type: "PONG", timestamp: Date.now() });
          break;
        }

        // ── SET_PRESENCE ───────────────────────────────────────────────────────
        // Mirrors FusionPktSetPresence (Java: sessionPrx.setPresence(value))
        // Client sends: { type: "SET_PRESENCE", status: "online" | "away" | "busy" | "offline" }
        // Java PresenceType: AVAILABLE=0, AWAY=1, BUSY=2, INVISIBLE=3, OFFLINE=4
        case "SET_PRESENCE": {
          if (client.state !== "AUTHENTICATED" || !client.userId || !client.username) break;
          let newStatus: "online" | "away" | "busy" = "online";
          if (msg.status === "away") newStatus = "away";
          else if (msg.status === "busy") newStatus = "busy";
          presenceOverrides.set(client.userId, newStatus);
          // Push to own friends list — same as Java broadcasting FusionPktPresence to contacts
          try {
            const friends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, client.userId));
            const friendIds = friends.map((f: { friendUserId: string }) => f.friendUserId);
            broadcastPresenceToFriends(client.userId, client.username, newStatus, friendIds);
          } catch {}
          send(ws, { type: "PONG", timestamp: Date.now() }); // ack
          break;
        }

        // ── SET_STATUS_MESSAGE ────────────────────────────────────────────────
        // Client sends: { type: "SET_STATUS_MESSAGE", message: string }
        // Stores status text in-memory and broadcasts STATUS_MESSAGE event to friends
        case "SET_STATUS_MESSAGE": {
          if (client.state !== "AUTHENTICATED" || !client.userId || !client.username) break;
          const message = typeof msg.message === "string" ? msg.message : "";
          setUserStatusMessage(client.userId, message);
          try {
            const friends = await db.select({ friendUserId: friendships.friendUserId })
              .from(friendships).where(eq(friendships.userId, client.userId));
            for (const f of friends) {
              broadcastToUser(f.friendUserId, {
                type: "STATUS_MESSAGE",
                userId: client.userId,
                username: client.username,
                message: message.trim(),
              });
            }
          } catch {}
          send(ws, { type: "PONG", timestamp: Date.now() }); // ack
          break;
        }

        // ── GET_PRESENCE ───────────────────────────────────────────────────────
        // Client sends: { type: "GET_PRESENCE", userIds: string[] }
        // Returns PRESENCE_LIST for the requested userIds
        case "GET_PRESENCE": {
          if (client.state !== "AUTHENTICATED") break;
          const ids: string[] = Array.isArray(msg.userIds) ? msg.userIds : [];
          send(ws, { type: "PRESENCE_LIST", users: getPresenceList(ids) });
          break;
        }

        // ── LOGOUT ────────────────────────────────────────────────────────────
        // Matches fusion SSO logout flow: immediately broadcast "has left" for
        // all subscribed rooms without the grace period, then close the WS.
        // Called by the Expo client when the user explicitly taps "Log Out".
        case "LOGOUT": {
          if (client.state !== "AUTHENTICATED") {
            send(ws, { type: "LOGOUT_OK" });
            ws.close();
            break;
          }

          // Cancel any pending grace timers for this user so there's no
          // duplicate "has left" after the forced logout.
          for (const roomId of Array.from(client.subscribedRooms)) {
            const graceKey = `${client.userId}:${roomId}`;
            const pending  = pendingLeaves.get(graceKey);
            if (pending) {
              clearTimeout(pending.timer);
              pendingLeaves.delete(graceKey);
            }
          }

          // Broadcast "has left" immediately for every subscribed room,
          // mirroring Java ChatRoom.queueEntryExitAdminMessage(false).
          for (const roomId of Array.from(client.subscribedRooms)) {
            if (!client.userId) continue;
            await storage.leaveChatroom(roomId, client.userId).catch(() => {});
            const room = await storage.getChatroom(roomId).catch(() => null);
            const displayName = withLevel(client.username ?? "user", client.migLevel);
            const leaveMsg = await storage.postMessage(roomId, {
              senderUsername: client.username ?? "user",
              senderColor:    client.chatColor,
              text:           `${room?.name ?? roomId}::${displayName} has left`,
              isSystem:       true,
            }).catch(() => null);
            if (leaveMsg) broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
            const list = await storage.getParticipants(roomId).catch(() => []);
            broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
          }
          client.subscribedRooms.clear();

          send(ws, { type: "LOGOUT_OK" });
          ws.close();
          break;
        }
      }
    });

    ws.on("close", () => {
      clearInterval(nativePingTimer);
      client.state = "DISCONNECTED";
      clients.delete(ws);

      // Broadcast OFFLINE presence to friends after disconnect
      // Mirrors Java: FusionPktPresence broadcast on session termination
      if (client.userId && client.username) {
        const offlineUserId   = client.userId;
        const offlineUsername = client.username;
        db.select({ friendUserId: friendships.friendUserId })
          .from(friendships).where(eq(friendships.userId, offlineUserId))
          .then((friends: { friendUserId: string }[]) => {
            // Only broadcast offline if user truly has no remaining connections
            const stillConnected = [...clients.values()].some(
              (c) => c.state === "AUTHENTICATED" && c.userId === offlineUserId,
            );
            if (!stillConnected) {
              presenceOverrides.delete(offlineUserId);
              broadcastPresenceToFriends(offlineUserId, offlineUsername, "offline", friends.map((f) => f.friendUserId));
            }
          }).catch(() => {});
      }

      // ── Grace period ──────────────────────────────────────────────────────
      // Don't broadcast "has left" immediately — the client may reconnect
      // within LEAVE_GRACE_MS (network blip, app backgrounded, etc.).
      // If they re-SUBSCRIBE within the window we cancel the timer silently.
      // Only after the grace period expires do we remove from DB and broadcast.
      for (const roomId of Array.from(client.subscribedRooms)) {
        if (!client.userId) continue;
        const graceKey = `${client.userId}:${roomId}`;

        // Cancel any pre-existing grace timer for this user+room (edge case:
        // two rapid disconnects before first timer fires)
        const existing = pendingLeaves.get(graceKey);
        if (existing) {
          clearTimeout(existing.timer);
          pendingLeaves.delete(graceKey);
        }

        const userId         = client.userId;
        const username       = client.username ?? "user";
        const color          = client.chatColor;
        const migLevel       = client.migLevel;
        const disconnectedAt = Date.now();

        const timer = setTimeout(async () => {
          pendingLeaves.delete(graceKey);
          await storage.leaveChatroom(roomId, userId).catch(() => {});
          const room = await storage.getChatroom(roomId).catch(() => null);
          // Matches Java queueEntryExitAdminMessage: include level badge when level > 1
          const displayName = withLevel(username, migLevel);
          const leaveMsg = await storage.postMessage(roomId, {
            senderUsername: username, senderColor: color,
            text: `${room?.name ?? roomId}::${displayName} has left`, isSystem: true,
          }).catch(() => null);
          if (leaveMsg) broadcastToRoom(roomId, { type: "MESSAGE", roomId, message: leaveMsg });
          const list = await storage.getParticipants(roomId).catch(() => []);
          broadcastToRoom(roomId, buildParticipantsPayload(roomId, room?.name ?? roomId, list));
        }, LEAVE_GRACE_MS);

        pendingLeaves.set(graceKey, { timer, roomId, userId, username, color, migLevel, disconnectedAt });
      }
    });

    ws.on("error", () => {
      clearInterval(nativePingTimer);
      client.state = "DISCONNECTED";
      clients.delete(ws);
    });
  });

  console.log(`[gateway] WebSocket gateway running at ws://0.0.0.0:PORT${GATEWAY_WS_PATH}`);
}
