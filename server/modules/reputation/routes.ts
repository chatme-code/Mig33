import type { Express } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { NOTIFICATION_TYPE, NOTIFICATION_STATUS, LEADERBOARD_TYPE, LEADERBOARD_PERIOD } from "@shared/schema";
import type { UserReputationRow, LevelThreshold } from "@shared/schema";

// ─── Java Scoring Formula ─────────────────────────────────────────────────────
// Mirrors com/projectgoth/fusion/reputation/file/ScoreFinalSummary.java
// and com/projectgoth/fusion/reputation/cache/ScoreFormulaParameters.java
//
// The Java system runs a daily batch that:
//   1. Collects raw activity metrics for each user
//   2. Normalises each metric to [0–100] relative to a "reasonable maximum"
//   3. Applies a bonus for high performers (closer to reasonableMax → bonus pts)
//   4. Groups normalised+weighted metrics into 4 categories (each capped at 100)
//   5. Sums categories → daily score (capped at dailyHardCap = 400)
//   6. Adds to cumulative score and re-derives the user's level via the DB table

// ScoreFormulaParameters.java default values
const REASONABLE_MAX = {
  chatRoomMessagesSent:   30,
  privateMessagesSent:    75,
  totalTime:              6000,  // seconds
  photosUploaded:         1,
  kicksInitiated:         5,
  authenticatedReferrals: 3,
  rechargedAmount:        1,
  virtualGiftsReceived:   2,
  virtualGiftsSent:       2,
  phoneCallDuration:      120,   // seconds
};

// Bonus table — from ScoreFormulaParameters:
//   reasonableMaximumMinus50 = 2 → if metric >= 50% of max, award +2
//   reasonableMaximumMinus45 = 4, Minus40 = 6, Minus35 = 8, Minus30 = 10
//   Minus25 = 6, Minus20 = 4, Minus15 = 2, Minus10 = 0
const BONUS_TABLE: Array<{ threshold: number; bonus: number }> = [
  { threshold: 0.50, bonus: 2  },
  { threshold: 0.45, bonus: 4  },
  { threshold: 0.40, bonus: 6  },
  { threshold: 0.35, bonus: 8  },
  { threshold: 0.30, bonus: 10 },
  { threshold: 0.25, bonus: 6  },
  { threshold: 0.20, bonus: 4  },
  { threshold: 0.15, bonus: 2  },
  { threshold: 0.10, bonus: 0  },
];

const DAILY_HARD_CAP = 400; // ScoreFormulaParameters.dailyHardCap

type MetricKey = keyof typeof REASONABLE_MAX;

function normalise(actual: number, max: number): number {
  const pct = Math.round((actual / max) * 100);
  return Math.max(0, Math.min(100, pct));
}

// Mirrors ScoreFinalSummary.score() bonus logic
function applyBonus(normalisedScore: number, reasonableMax: number): number {
  for (const entry of BONUS_TABLE) {
    if (normalisedScore >= entry.threshold * reasonableMax) {
      return normalisedScore + entry.bonus;
    }
  }
  return normalisedScore;
}

// Compute a single-period score from lifetime metrics.
// Real-time equivalent of the Java daily batch ScoreFinalSummary.scoreFile().
export function computeScoreFromMetrics(rep: UserReputationRow): number {
  const metrics: Record<MetricKey, number> = {
    chatRoomMessagesSent:   rep.chatRoomMessagesSent,
    privateMessagesSent:    rep.privateMessagesSent,
    totalTime:              rep.totalTime,
    photosUploaded:         rep.photosUploaded,
    kicksInitiated:         rep.kicksInitiated,
    authenticatedReferrals: rep.authenticatedReferrals,
    rechargedAmount:        rep.rechargedAmount,
    virtualGiftsReceived:   rep.virtualGiftsReceived,
    virtualGiftsSent:       rep.virtualGiftsSent,
    phoneCallDuration:      rep.phoneCallDuration,
  };

  const s: Record<MetricKey, number> = {} as any;
  for (const key of Object.keys(metrics) as MetricKey[]) {
    const raw = normalise(metrics[key], REASONABLE_MAX[key]);
    s[key]    = Math.min(100, applyBonus(raw, REASONABLE_MAX[key]));
  }

  // ScoreCategory.TIME_IN_PRODUCT
  const timeInProduct = s.totalTime;

  // ScoreCategory.CREDITS_SPENT = rechargedAmount + virtualGiftsSent + phoneCallDuration
  const creditsSpent = Math.min(100, s.rechargedAmount + s.virtualGiftsSent + s.phoneCallDuration);

  // ScoreCategory.HUMAN_LIKELY_BEHAVIOUR = photosUploaded + virtualGiftsReceived + authenticatedReferrals
  const humanLikely = Math.min(100, s.photosUploaded + s.virtualGiftsReceived + s.authenticatedReferrals);

  // ScoreCategory.BASIC_ACTIVITY = min(chatRoom,75) + min(privateMsg,75), capped at 100
  const basicActivity = Math.min(100, Math.min(s.chatRoomMessagesSent, 75) + Math.min(s.privateMessagesSent, 75));

  const total = timeInProduct + creditsSpent + humanLikely + basicActivity;
  return Math.min(DAILY_HARD_CAP, total);
}

// ─── Level Table (in-memory cache) ───────────────────────────────────────────
// Mirrors com/projectgoth/fusion/reputation/util/LevelTable.java
// The table is loaded from DB at startup and refreshed periodically.
// The Java system reads it with: SELECT score,level FROM ReputationScoreToLevel ORDER BY score DESC

let cachedLevelTable: LevelThreshold[] = [];
let levelTableLoadedAt = 0;
const LEVEL_TABLE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getLevelTable(): Promise<LevelThreshold[]> {
  const now = Date.now();
  if (cachedLevelTable.length > 0 && now - levelTableLoadedAt < LEVEL_TABLE_TTL_MS) {
    return cachedLevelTable;
  }
  try {
    const table = await storage.getLevelTable();
    if (table.length > 0) {
      cachedLevelTable = table; // already sorted DESC by score from DB
      levelTableLoadedAt = now;
      return cachedLevelTable;
    }
  } catch {
    // fall through to hardcoded defaults
  }
  // Hardcoded fallback matching the Java defaults (scores from level thresholds)
  cachedLevelTable = HARDCODED_LEVELS;
  levelTableLoadedAt = now;
  return cachedLevelTable;
}

// Hardcoded fallback — mirrors migration 0012_expand_levels_1_to_50.sql
// 50-level progression: score(n) ≈ 20*(n-1)^1.5  →  Level 50 = 6860 XP
const HARDCODED_LEVELS: LevelThreshold[] = [
  // Sorted DESC by score (as DB returns them)
  { level: 50, score: 6860, name: "God",          image: null, chatRoomSize: 100, groupSize: 200, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 10 },
  { level: 49, score: 6655, name: "Demigod",       image: null, chatRoomSize: 100, groupSize: 195, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 10 },
  { level: 48, score: 6450, name: "Titan",         image: null, chatRoomSize: 100, groupSize: 190, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 10 },
  { level: 47, score: 6240, name: "Immortal",      image: null, chatRoomSize: 99,  groupSize: 185, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 9  },
  { level: 46, score: 6035, name: "Legendary",     image: null, chatRoomSize: 99,  groupSize: 180, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 9  },
  { level: 45, score: 5835, name: "Epic",          image: null, chatRoomSize: 98,  groupSize: 175, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 9  },
  { level: 44, score: 5640, name: "Mythic",        image: null, chatRoomSize: 98,  groupSize: 170, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 9  },
  { level: 43, score: 5440, name: "Icon",          image: null, chatRoomSize: 97,  groupSize: 165, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 9  },
  { level: 42, score: 5255, name: "Legend",        image: null, chatRoomSize: 97,  groupSize: 160, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 8  },
  { level: 41, score: 5060, name: "Grandmaster",   image: null, chatRoomSize: 96,  groupSize: 155, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 8  },
  { level: 40, score: 4870, name: "Prodigy",       image: null, chatRoomSize: 95,  groupSize: 150, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 8  },
  { level: 39, score: 4685, name: "Ace",           image: null, chatRoomSize: 93,  groupSize: 140, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 8  },
  { level: 38, score: 4505, name: "Elite",         image: null, chatRoomSize: 90,  groupSize: 130, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 7  },
  { level: 37, score: 4320, name: "Virtuoso",      image: null, chatRoomSize: 87,  groupSize: 120, numGroupChatRooms: 10, createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 7  },
  { level: 36, score: 4145, name: "Master",        image: null, chatRoomSize: 84,  groupSize: 115, numGroupChatRooms: 9,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 7  },
  { level: 35, score: 3965, name: "Champion",      image: null, chatRoomSize: 81,  groupSize: 110, numGroupChatRooms: 9,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 7  },
  { level: 34, score: 3790, name: "Authority",     image: null, chatRoomSize: 78,  groupSize: 105, numGroupChatRooms: 9,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 7  },
  { level: 33, score: 3620, name: "Professional",  image: null, chatRoomSize: 75,  groupSize: 100, numGroupChatRooms: 9,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 6  },
  { level: 32, score: 3455, name: "Specialist",    image: null, chatRoomSize: 72,  groupSize: 95,  numGroupChatRooms: 8,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 6  },
  { level: 31, score: 3285, name: "Expert",        image: null, chatRoomSize: 69,  groupSize: 90,  numGroupChatRooms: 8,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 6  },
  { level: 30, score: 3125, name: "Advanced",      image: null, chatRoomSize: 66,  groupSize: 85,  numGroupChatRooms: 8,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 6  },
  { level: 29, score: 2965, name: "Proficient",    image: null, chatRoomSize: 63,  groupSize: 80,  numGroupChatRooms: 8,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 6  },
  { level: 28, score: 2805, name: "Skilled",       image: null, chatRoomSize: 60,  groupSize: 75,  numGroupChatRooms: 7,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 5  },
  { level: 27, score: 2650, name: "Experienced",   image: null, chatRoomSize: 57,  groupSize: 70,  numGroupChatRooms: 7,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 5  },
  { level: 26, score: 2500, name: "Senior",        image: null, chatRoomSize: 54,  groupSize: 65,  numGroupChatRooms: 7,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 5  },
  { level: 25, score: 2350, name: "Dedicated",     image: null, chatRoomSize: 51,  groupSize: 60,  numGroupChatRooms: 6,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 5  },
  { level: 24, score: 2205, name: "Devoted",       image: null, chatRoomSize: 49,  groupSize: 56,  numGroupChatRooms: 6,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 5  },
  { level: 23, score: 2065, name: "Veteran",       image: null, chatRoomSize: 47,  groupSize: 52,  numGroupChatRooms: 6,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 4  },
  { level: 22, score: 1925, name: "Enthusiast",    image: null, chatRoomSize: 45,  groupSize: 48,  numGroupChatRooms: 5,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 4  },
  { level: 21, score: 1790, name: "Active",        image: null, chatRoomSize: 43,  groupSize: 44,  numGroupChatRooms: 5,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 4  },
  { level: 20, score: 1655, name: "Regular",       image: null, chatRoomSize: 41,  groupSize: 40,  numGroupChatRooms: 5,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 4  },
  { level: 19, score: 1525, name: "Member",        image: null, chatRoomSize: 39,  groupSize: 36,  numGroupChatRooms: 5,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 4  },
  { level: 18, score: 1400, name: "Contributor",   image: null, chatRoomSize: 37,  groupSize: 33,  numGroupChatRooms: 4,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 3  },
  { level: 17, score: 1280, name: "Participant",   image: null, chatRoomSize: 35,  groupSize: 30,  numGroupChatRooms: 4,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 3  },
  { level: 16, score: 1160, name: "Initiate",      image: null, chatRoomSize: 33,  groupSize: 28,  numGroupChatRooms: 4,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 3  },
  { level: 15, score: 1050, name: "Discoverer",    image: null, chatRoomSize: 31,  groupSize: 26,  numGroupChatRooms: 3,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 3  },
  { level: 14, score: 935,  name: "Seeker",        image: null, chatRoomSize: 29,  groupSize: 24,  numGroupChatRooms: 3,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 3  },
  { level: 13, score: 830,  name: "Voyager",       image: null, chatRoomSize: 27,  groupSize: 22,  numGroupChatRooms: 3,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 2  },
  { level: 12, score: 730,  name: "Wanderer",      image: null, chatRoomSize: 25,  groupSize: 20,  numGroupChatRooms: 3,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 2  },
  { level: 11, score: 635,  name: "Adventurer",    image: null, chatRoomSize: 23,  groupSize: 18,  numGroupChatRooms: 2,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 2  },
  { level: 10, score: 540,  name: "Explorer",      image: null, chatRoomSize: 21,  groupSize: 16,  numGroupChatRooms: 2,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: true,  numGroupModerators: 2  },
  { level: 9,  score: 455,  name: "Trainee",       image: null, chatRoomSize: 19,  groupSize: 14,  numGroupChatRooms: 2,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 2  },
  { level: 8,  score: 370,  name: "Scholar",       image: null, chatRoomSize: 17,  groupSize: 12,  numGroupChatRooms: 2,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 1  },
  { level: 7,  score: 295,  name: "Student",       image: null, chatRoomSize: 15,  groupSize: 10,  numGroupChatRooms: 1,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 1  },
  { level: 6,  score: 225,  name: "Learner",       image: null, chatRoomSize: 13,  groupSize: 8,   numGroupChatRooms: 1,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 1  },
  { level: 5,  score: 160,  name: "Apprentice",    image: null, chatRoomSize: 11,  groupSize: 5,   numGroupChatRooms: 1,  createChatRoom: true,  createGroup: true,  publishPhoto: true,  postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 1  },
  { level: 4,  score: 105,  name: "Beginner",      image: null, chatRoomSize: 9,   groupSize: null, numGroupChatRooms: null, createChatRoom: true, createGroup: false, publishPhoto: true, postCommentLikeUserWall: true,  addToPhotoWall: true,  enterPot: false, numGroupModerators: 0  },
  { level: 3,  score: 55,   name: "Rookie",        image: null, chatRoomSize: 7,   groupSize: null, numGroupChatRooms: null, createChatRoom: true, createGroup: false, publishPhoto: true, postCommentLikeUserWall: true,  addToPhotoWall: false, enterPot: false, numGroupModerators: 0  },
  { level: 2,  score: 20,   name: "Newcomer",      image: null, chatRoomSize: 5,   groupSize: null, numGroupChatRooms: null, createChatRoom: false, createGroup: false, publishPhoto: true, postCommentLikeUserWall: true,  addToPhotoWall: false, enterPot: false, numGroupModerators: 0  },
  { level: 1,  score: 0,    name: "Newbie",        image: null, chatRoomSize: null, groupSize: null, numGroupChatRooms: null, createChatRoom: false, createGroup: false, publishPhoto: false, postCommentLikeUserWall: false, addToPhotoWall: false, enterPot: false, numGroupModerators: 0 },
];

// Mirrors LevelTable.getLevelForScore() — floor lookup: highest level where score >= threshold
// levelTable must be sorted DESC by score (as returned by DB)
export function scoreToLevel(score: number, levelTable: LevelThreshold[] = HARDCODED_LEVELS): number {
  for (const entry of levelTable) {
    if (score >= entry.score) return entry.level;
  }
  return 1;
}

export function getLevelDataForScoreSync(score: number, levelTable: LevelThreshold[] = HARDCODED_LEVELS): LevelThreshold | undefined {
  for (const entry of levelTable) {
    if (score >= entry.score) return entry;
  }
  return undefined;
}

// ─── Per-action Score Awards ─────────────────────────────────────────────────
// Real-time equivalent of the daily batch.
// Per-unit values derived from the Java formula ceilings:
//   chatRoomMsg  → BASIC_ACTIVITY cap 75 / 30 max msgs    → ≈ 2.5 pts each
//   privateMsg   → BASIC_ACTIVITY cap 75 / 75 max msgs    → ≈ 1.0 pts each
//   virtualGift  → CREDITS_SPENT / HUMAN_LIKE (max 2)     → 50 pts each
//   photoUpload  → HUMAN_LIKELY (max 1 = 100 pts)         → 100 pts
//   referral     → HUMAN_LIKELY (max 3)                   → ≈ 33 pts each
//   phoneCall/s  → CREDITS_SPENT (max 120 s = 100 pts)    → ≈ 1 pt/s
//   sessionTime  → TIME_IN_PRODUCT (max 6000 s = 100 pts) → ≈ 0.017 pts/s
export type ReputationAction =
  | "chatRoomMessage"
  | "privateMessage"
  | "giftSent"
  | "giftReceived"
  | "photoUploaded"
  | "referral"
  | "phoneCallSecond"
  | "sessionSecond";

const ACTION_SCORE: Record<ReputationAction, number> = {
  chatRoomMessage:  3,
  privateMessage:   1,
  giftSent:         50,
  giftReceived:     50,
  photoUploaded:    100,
  referral:         33,
  phoneCallSecond:  1,
  sessionSecond:    0,   // tracked but not directly scored — affects totalTime metric
};

const ACTION_METRIC: Record<ReputationAction, MetricKey | "sessionCount" | null> = {
  chatRoomMessage:  "chatRoomMessagesSent",
  privateMessage:   "privateMessagesSent",
  giftSent:         "virtualGiftsSent",
  giftReceived:     "virtualGiftsReceived",
  photoUploaded:    "photosUploaded",
  referral:         "authenticatedReferrals",
  phoneCallSecond:  "phoneCallDuration",
  sessionSecond:    "totalTime",
};

export interface AwardResult {
  username:    string;
  scoreAdded:  number;
  newScore:    number;
  oldLevel:    number;
  newLevel:    number;
  leveledUp:   boolean;
  levelData:   LevelThreshold | null;
}

// ─── onLevelChanged ───────────────────────────────────────────────────────────
// Mirrors UpdateScoreTable.onLevelChanged() in the Java backend.
// Triggered whenever a user's computed level increases.
// Java side effects:
//   1. updateUserOwnedRoomSize() — update chatroom max size in DB + live rooms
//   2. ReputationLevelIncreaseTrigger → RewardCentre.sendTrigger()
//   3. UserNotificationServicePrx.notifyFusionUser() with MIGLEVEL_INCREASE_ALERT
async function onLevelChanged(
  username: string,
  oldLevelData: LevelThreshold | undefined,
  newLevelData: LevelThreshold,
): Promise<void> {
  // 1. Update chatroom size if it changed (mirrors updateUserOwnedRoomSize())
  if (
    newLevelData.chatRoomSize !== null &&
    (oldLevelData === undefined || oldLevelData.chatRoomSize !== newLevelData.chatRoomSize)
  ) {
    try {
      // Update all chatrooms owned by this user to the new max size
      const userChatrooms = await storage.getChatrooms();
      for (const room of userChatrooms) {
        if (room.userOwned && room.createdBy) {
          const creator = await storage.getUserByUsername(username);
          if (creator && room.createdBy === creator.id) {
            await storage.updateChatroom(room.id, { maxParticipants: newLevelData.chatRoomSize! });
          }
        }
      }
    } catch {
      // non-fatal
    }
  }

  // 2. Sync migLevel in user_profiles (mirrors the mig_level field on the profile)
  try {
    const user = await storage.getUserByUsername(username);
    if (user) {
      await storage.upsertUserProfile(user.id, { migLevel: newLevelData.level });
    }
  } catch {
    // non-fatal
  }

  // 3. Update MIG_LEVEL leaderboard with new level across all periods
  try {
    const migLbPeriods = [
      LEADERBOARD_PERIOD.DAILY,
      LEADERBOARD_PERIOD.WEEKLY,
      LEADERBOARD_PERIOD.MONTHLY,
      LEADERBOARD_PERIOD.ALL_TIME,
    ];
    for (const period of migLbPeriods) {
      storage.upsertLeaderboardEntry(LEADERBOARD_TYPE.MIG_LEVEL, period, username, newLevelData.level, false).catch(() => {});
    }
  } catch {
    // non-fatal
  }

  // 4. Send MIGLEVEL_INCREASE_ALERT notification (mirrors UNS notifyFusionUser())
  try {
    await storage.createNotification({
      username,
      type: NOTIFICATION_TYPE.ALERT,
      subject: "miglevel_increase",
      message: `Congratulations! You reached level ${newLevelData.level} (${newLevelData.name ?? ""}). Keep it up!`,
      status: NOTIFICATION_STATUS.PENDING,
    });
  } catch {
    // non-fatal
  }
}

/**
 * Award reputation score for a user action.
 * Mirrors UpdateScoreTable.java real-time variant.
 * Increments the raw metric counter, adds score, updates level in DB,
 * and triggers onLevelChanged() side effects when level increases.
 */
export async function awardReputationScore(
  username: string,
  action: ReputationAction,
  count = 1,
): Promise<AwardResult> {
  const levelTable = await getLevelTable();
  const scoreAdded = ACTION_SCORE[action] * count;
  const metricKey  = ACTION_METRIC[action];

  let rep = await storage.getUserReputation(username);
  if (!rep) rep = await storage.createUserReputation(username);

  const oldScore = rep.score;
  const oldLevelData = getLevelDataForScoreSync(oldScore, levelTable);
  const oldLevel = oldLevelData?.level ?? 1;

  // Increment the raw metric counter
  if (metricKey) {
    await storage.updateReputationMetrics(username, { [metricKey]: count });
  }

  // Increment cumulative score (skip if action awards 0 pts like sessionSecond)
  let updated = rep;
  if (scoreAdded > 0) {
    updated = await storage.incrementReputationScore(username, scoreAdded);
  }

  const newLevelData = getLevelDataForScoreSync(updated.score, levelTable);
  const newLevel = newLevelData?.level ?? 1;

  // Update stored level if it changed
  if (newLevel !== oldLevel) {
    await storage.updateReputationLevel(username, newLevel);
    // Fire level-up side effects (mirrors UpdateScoreTable.onLevelChanged)
    await onLevelChanged(username, oldLevelData, newLevelData!);
  }

  return {
    username,
    scoreAdded,
    newScore:  updated.score,
    oldLevel,
    newLevel,
    leveledUp: newLevel > oldLevel,
    levelData: newLevelData ?? null,
  };
}

// ─── Routes ──────────────────────────────────────────────────────────────────
export function registerReputationRoutes(app: Express) {

  // GET /api/reputation/levels — full level threshold table from DB
  // Mirrors ReputationLevelScoreRanges.java + ReputationScoreToLevel DB table
  app.get("/api/reputation/levels", async (_req, res) => {
    try {
      const levelThresholds = await getLevelTable();
      // Return sorted ascending (lowest first) for UI friendliness
      const sorted = [...levelThresholds].sort((a, b) => a.score - b.score);
      res.json({ levelThresholds: sorted });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/top — leaderboard with level data
  app.get("/api/reputation/top", async (req, res) => {
    const limit  = Math.min(parseInt(req.query.limit  as string) || 20, 100);
    const offset = parseInt(req.query.offset as string) || 0;
    try {
      const [top, levelTable] = await Promise.all([
        storage.getTopReputationUsers(limit, offset),
        getLevelTable(),
      ]);
      const enriched = top.map(u => ({
        ...u,
        levelName: getLevelDataForScoreSync(u.score, levelTable)?.name ?? "Newbie",
      }));
      res.json({ top: enriched, count: enriched.length });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/:username — full profile + computed score breakdown + level privileges
  app.get("/api/reputation/:username", async (req, res) => {
    const { username } = req.params;
    try {
      const [levelTable] = await Promise.all([getLevelTable()]);
      let rep = await storage.getUserReputation(username);
      if (!rep) rep = await storage.createUserReputation(username);

      const currentLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const nextThreshold    = levelTable.slice().sort((a, b) => a.score - b.score)
                                 .find(t => t.score > rep!.score);
      const currentMinScore  = currentLevelData?.score ?? 0;
      const nextLevelAt      = nextThreshold?.score ?? null;
      const progressPct      = nextLevelAt
        ? Math.round(((rep.score - currentMinScore) / (nextLevelAt - currentMinScore)) * 100)
        : 100;

      const computedDailyMax = computeScoreFromMetrics(rep);

      res.json({
        ...rep,
        levelName:        currentLevelData?.name ?? "Newbie",
        levelPrivileges:  currentLevelData ?? null,
        nextLevelAt,
        progressPct:      Math.max(0, Math.min(100, progressPct)),
        computedDailyMax,
        levelThresholds:  levelTable.slice().sort((a, b) => a.score - b.score),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // GET /api/reputation/:username/level — lightweight level + privileges lookup
  // Mirrors ReputationServiceI.getUserLevel() + getLevelDataForScore()
  app.get("/api/reputation/:username/level", async (req, res) => {
    const { username } = req.params;
    try {
      const [rep, levelTable] = await Promise.all([
        storage.getUserReputation(username),
        getLevelTable(),
      ]);
      const score     = rep?.score ?? 0;
      const levelData = getLevelDataForScoreSync(score, levelTable);
      res.json({
        username,
        score,
        level:      levelData?.level ?? 1,
        levelName:  levelData?.name  ?? "Newbie",
        privileges: levelData ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/award — award points for a user action (real-time)
  // Mirrors UpdateScoreTable.java real-time variant + RewardCentre.sendTrigger()
  // Body: { username, action, count? }
  app.post("/api/reputation/award", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      action:   z.enum(["chatRoomMessage","privateMessage","giftSent","giftReceived",
                        "photoUploaded","referral","phoneCallSecond","sessionSecond"]),
      count:    z.number().int().positive().default(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await awardReputationScore(parsed.data.username, parsed.data.action, parsed.data.count);
      res.json(result);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/update-score — direct score increment (admin / legacy batch)
  // Mirrors UpdateScoreTable.process() which adds daily score to cumulative
  app.post("/api/reputation/update-score", async (req, res) => {
    const schema = z.object({
      username:       z.string().min(1),
      scoreIncrement: z.number(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, scoreIncrement } = parsed.data;
    try {
      const levelTable  = await getLevelTable();
      const existing    = await storage.getUserReputation(username);
      const oldScore    = existing?.score ?? 0;
      const oldLevelData = getLevelDataForScoreSync(oldScore, levelTable);

      const rep        = await storage.incrementReputationScore(username, scoreIncrement);
      const newLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const newLevel   = newLevelData?.level ?? 1;
      const oldLevel   = oldLevelData?.level ?? 1;

      if (newLevel !== oldLevel) {
        await storage.updateReputationLevel(username, newLevel);
        await onLevelChanged(username, oldLevelData, newLevelData!);
      }

      res.json({
        success: true, username,
        score: rep.score, level: newLevel,
        levelName: newLevelData?.name ?? "Newbie",
        levelChanged: newLevel !== oldLevel,
        leveledUp: newLevel > oldLevel,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/metrics — raw metric increment
  // Mirrors AccountEntryMetrics, ScoreMetrics, PhoneCallMetrics, VirtualGiftMetrics
  app.post("/api/reputation/metrics", async (req, res) => {
    const schema = z.object({
      username:               z.string().min(1),
      chatRoomMessagesSent:   z.number().int().nonnegative().optional(),
      privateMessagesSent:    z.number().int().nonnegative().optional(),
      totalTime:              z.number().int().nonnegative().optional(),
      photosUploaded:         z.number().int().nonnegative().optional(),
      kicksInitiated:         z.number().int().nonnegative().optional(),
      authenticatedReferrals: z.number().int().nonnegative().optional(),
      rechargedAmount:        z.number().nonnegative().optional(),
      phoneCallDuration:      z.number().int().nonnegative().optional(),
      sessionCount:           z.number().int().nonnegative().optional(),
      virtualGiftsSent:       z.number().int().nonnegative().optional(),
      virtualGiftsReceived:   z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, ...metrics } = parsed.data;
    try {
      const rep = await storage.updateReputationMetrics(username, metrics);
      res.json({ success: true, reputation: rep });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/recalculate — recompute level from cumulative score
  // Mirrors UpdateScoreTable behaviour of re-deriving level after score update
  app.post("/api/reputation/recalculate", async (req, res) => {
    const schema = z.object({ username: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username } = parsed.data;
    try {
      const [rep, levelTable] = await Promise.all([
        storage.getUserReputation(username),
        getLevelTable(),
      ]);
      if (!rep) return res.status(404).json({ error: "User reputation not found" });

      const oldLevel    = rep.level;
      const newLevelData = getLevelDataForScoreSync(rep.score, levelTable);
      const newLevel    = newLevelData?.level ?? 1;

      if (newLevel !== oldLevel) {
        await storage.updateReputationLevel(username, newLevel);
        const oldLevelData = getLevelDataForScoreSync(0, levelTable); // level 1
        await onLevelChanged(username, oldLevelData, newLevelData!);
      }

      res.json({
        success: true, username,
        score: rep.score,
        oldLevel, newLevel,
        levelName: newLevelData?.name ?? "Newbie",
        privileges: newLevelData ?? null,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/reputation/daily-batch — simulate the Java daily batch process
  // Mirrors ReputationServiceI.gatherAndProcess() → ScoreFinalSummary.scoreFile()
  // → UpdateScoreTable.process()
  // Computes a daily score from each user's current metrics, adds it to cumulative
  // score, and re-derives levels.
  app.post("/api/reputation/daily-batch", async (req, res) => {
    try {
      const [allUsers, levelTable] = await Promise.all([
        storage.getTopReputationUsers(10000, 0),
        getLevelTable(),
      ]);

      let processed = 0;
      let levelUps  = 0;

      for (const rep of allUsers) {
        const dailyScore   = computeScoreFromMetrics(rep);
        if (dailyScore === 0) continue;

        const oldLevelData = getLevelDataForScoreSync(rep.score, levelTable);
        const updated      = await storage.incrementReputationScore(rep.username, dailyScore);
        const newLevelData = getLevelDataForScoreSync(updated.score, levelTable);
        const newLevel     = newLevelData?.level ?? 1;
        const oldLevel     = oldLevelData?.level ?? 1;

        if (newLevel !== oldLevel) {
          await storage.updateReputationLevel(rep.username, newLevel);
          await onLevelChanged(rep.username, oldLevelData, newLevelData!);
          levelUps++;
        }
        processed++;
      }

      res.json({ success: true, processed, levelUps, ranAt: new Date().toISOString() });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ─── Level Threshold CRUD (admin) ──────────────────────────────────────────
  // Mirrors the reputationscoretolevel DB table management in the Java admin UI.

  // PUT /api/reputation/levels/:level — create or update a level threshold
  app.put("/api/reputation/levels/:level", async (req, res) => {
    const levelNum = parseInt(req.params.level);
    if (isNaN(levelNum) || levelNum < 1) return res.status(400).json({ error: "Invalid level number" });

    const schema = z.object({
      score:                  z.number().int().nonnegative(),
      name:                   z.string().optional(),
      image:                  z.string().optional().nullable(),
      chatRoomSize:           z.number().int().positive().optional().nullable(),
      groupSize:              z.number().int().positive().optional().nullable(),
      numGroupChatRooms:      z.number().int().nonnegative().optional().nullable(),
      createChatRoom:         z.boolean().optional(),
      createGroup:            z.boolean().optional(),
      publishPhoto:           z.boolean().optional(),
      postCommentLikeUserWall: z.boolean().optional(),
      addToPhotoWall:         z.boolean().optional(),
      enterPot:               z.boolean().optional(),
      numGroupModerators:     z.number().int().nonnegative().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await storage.upsertLevelThreshold({ level: levelNum, ...parsed.data });
      // Invalidate in-memory cache
      cachedLevelTable = [];
      res.json({ success: true, levelThreshold: result });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // DELETE /api/reputation/levels/:level — remove a level threshold
  app.delete("/api/reputation/levels/:level", async (req, res) => {
    const levelNum = parseInt(req.params.level);
    if (isNaN(levelNum)) return res.status(400).json({ error: "Invalid level number" });

    try {
      await storage.deleteLevelThreshold(levelNum);
      cachedLevelTable = [];
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
