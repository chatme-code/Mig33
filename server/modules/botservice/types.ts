export enum BotState {
  NO_GAME       = "NO_GAME",
  GAME_STARTING = "GAME_STARTING",
  GAME_JOINING  = "GAME_JOINING",
  PLAYING       = "PLAYING",
}

export type GameType =
  | "headsortails"
  | "dice"
  | "rockpaperscissors"
  | "russianroulette"
  | "blackjack"
  | "baccarat"
  | "trivia"
  | "vampire"
  | "esp"
  | "cricket"
  | "football"
  | "knockout"
  | "icarus"
  | "lowcard"
  | "warriors"
  | "werewolf"
  | "questionbot"
  | "uno"
  | "chatterbot"
  | "girlfriend"
  | "boyfriend";

export const GAME_TYPES: GameType[] = [
  "headsortails",
  "dice",
  "rockpaperscissors",
  "russianroulette",
  "blackjack",
  "baccarat",
  "trivia",
  "vampire",
  "esp",
  "cricket",
  "football",
  "knockout",
  "icarus",
  "lowcard",
  "warriors",
  "werewolf",
  "questionbot",
  "uno",
  "chatterbot",
  "girlfriend",
  "boyfriend",
];
