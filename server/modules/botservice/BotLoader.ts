import type { BotContext } from "./botBase";
import type { BotBase } from "./botBase";
import { GameType } from "./types";
import { loadBotParams } from "./botDAO";

import { HeadsOrTails }     from "./games/headsOrTails/headsOrTails";
import { Dice }              from "./games/dice/dice";
import { RockPaperScissors } from "./games/rockPaperScissors/rockPaperScissors";
import { RussianRoulette }   from "./games/russianRoulette/russianRoulette";
import { Blackjack }         from "./games/blackjack/blackjack";
import { Baccarat }          from "./games/baccarat/baccarat";
import { Trivia }            from "./games/trivia/trivia";
import { Vampire }           from "./games/vampire/vampire";
import { Esp }               from "./games/esp/esp";
import { Cricket }           from "./games/cricket/cricket";
import { Football }          from "./games/football/football";
import { KnockOut }          from "./games/knockout/knockout";
import { Icarus }            from "./games/icarus/icarus";
import { LowCard }           from "./games/lowcard/lowcard";
import { Warriors }          from "./games/warriors/warriors";
import { Werewolf }          from "./games/werewolf/werewolf";
import { QuestionBot }       from "./games/questionbot/questionbot";
import { One }               from "./games/one/one";
import { ChatterBot }        from "./games/chatterbot/chatterbot";
import { GirlFriend }        from "./games/girlfriend/girlfriend";
import { BoyFriend }         from "./games/boyfriend/boyfriend";

/**
 * BotLoader.ts
 *
 * Factory yang membuat instance bot game berdasarkan gameType.
 * Di Java, BotLoader menggunakan URLClassLoader untuk load class secara dinamis
 * dari library path. Di TypeScript, kita gunakan registry statis karena
 * semua game sudah di-import secara eksplisit.
 *
 * Mirrors: com.projectgoth.fusion.botservice.BotLoader (Java)
 *
 * Sekarang juga memuat params dari tabel `bot_configs` di DB (via BotDAO),
 * sehingga konfigurasi bot dapat diubah tanpa restart server.
 * Mirrors: Bot.loadConfig() → botDAO.getBotConfig(botData.getId())
 */

type BotConstructor = new (ctx: BotContext) => BotBase;

const BOT_REGISTRY: Record<GameType, BotConstructor> = {
  headsortails:      HeadsOrTails,
  dice:              Dice,
  rockpaperscissors: RockPaperScissors,
  russianroulette:   RussianRoulette,
  blackjack:         Blackjack,
  baccarat:          Baccarat,
  trivia:            Trivia,
  vampire:           Vampire,
  esp:               Esp,
  cricket:           Cricket,
  football:          Football,
  knockout:          KnockOut,
  icarus:            Icarus,
  lowcard:           LowCard,
  warriors:          Warriors,
  werewolf:          Werewolf,
  questionbot:       QuestionBot,
  uno:               One,
  chatterbot:        ChatterBot,
  girlfriend:        GirlFriend,
  boyfriend:         BoyFriend,
};

/**
 * Buat instance bot untuk channel tertentu.
 * Mirrors: BotLoader.addBotToChannel(executor, botData, channelProxy, botDAO, starter, lang)
 *
 * Async agar bisa memuat config dari DB sebelum konstruksi.
 * DB params di-merge dengan params yang sudah ada di ctx (ctx.params menang).
 *
 * @param gameType       - Tipe game (key dari GAME_TYPES)
 * @param ctx            - BotContext (roomId, starterUsername, params)
 * @returns              - Instance BotBase yang siap dijalankan
 * @throws Error         - Jika gameType tidak dikenal
 */
export async function addBotToChannel(gameType: GameType, ctx: BotContext): Promise<BotBase> {
  const BotClass = BOT_REGISTRY[gameType];
  if (!BotClass) {
    throw new Error(`[BotLoader] Unknown gameType: "${gameType}"`);
  }

  // Load params from DB (mirrors Bot.loadConfig → botDAO.getBotConfig)
  // DB values are the base; ctx.params (caller overrides) take precedence.
  const dbParams = await loadBotParams(gameType).catch(() => ({}));
  const mergedParams = { ...dbParams, ...ctx.params };

  return new BotClass({ ...ctx, params: mergedParams });
}

/**
 * Cek apakah gameType terdaftar di registry.
 */
export function isRegisteredGame(gameType: string): gameType is GameType {
  return gameType in BOT_REGISTRY;
}

/**
 * Kembalikan semua gameType yang terdaftar.
 */
export function getRegisteredGames(): GameType[] {
  return Object.keys(BOT_REGISTRY) as GameType[];
}
