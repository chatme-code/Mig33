import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";

type Direction = "LEFT" | "CENTER" | "RIGHT";

function randomDir(): Direction {
  const dirs: Direction[] = ["LEFT", "CENTER", "RIGHT"];
  return dirs[Math.floor(Math.random() * dirs.length)];
}

function fmt(n: number): string { return n.toFixed(2); }

export class Football extends BotBase {
  readonly gameType = "football";

  private minPlayers:       number;
  private maxPlayers:       number;
  private waitForPlayerMs:  number;
  private countDownMs:      number;
  private nextRoundMs:      number;
  private idleMs:           number;
  private minCostToJoin:    number;
  private maxCostToJoin:    number;

  private costToJoin = 0;
  private playerKicks = new Map<string, Direction | "UNKNOWN">();
  private round = 1;
  private waitTimer:    NodeJS.Timeout | null = null;
  private roundTimer:   NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers      = this.param("MinPlayers", 2);
    this.maxPlayers      = this.param("MaxPlayers", 8);
    this.waitForPlayerMs = this.param("WaitForPlayerInterval", 30_000);
    this.countDownMs     = this.param("CountDownInterval", 15_000);
    this.nextRoundMs     = this.param("NextRoundInterval", 5_000);
    this.idleMs          = this.param("IdleInterval", 1_800_000);
    this.minCostToJoin   = this.param("MinCostToJoinGame", 0.05);
    this.maxCostToJoin   = this.param("MaxCostToJoinGame", 500);

    this.sendChannelMessage(
      `Bot Football added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "For custom entry: !start <amount>"
    );
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state === BotState.NO_GAME;
  }

  stopBot(): void {
    this.clearAllTimers();
    this.refundAll().catch(() => {});
    this.resetGame();
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(`Play Football. !start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username);
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(`Football forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`, username);
        break;
      case BotState.PLAYING:
        this.sendMessage("Football is on. Get ready for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(username: string): void {
    if (this.playerKicks.has(username) && this.state !== BotState.NO_GAME) {
      this.playerKicks.delete(username);
      this.refundUser(username, this.costToJoin).catch(() => {});
      this.sendChannelMessage(`${username} left the game`);
    }
  }

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();
    if (msg.startsWith("!start")) { this.startNewGame(username, msg); return; }
    if (msg === "!j") { this.joinGame(username); return; }
    if (msg === "!l") { this.kick(username, "LEFT");   return; }
    if (msg === "!c") { this.kick(username, "CENTER"); return; }
    if (msg === "!r") { this.kick(username, "RIGHT");  return; }
    this.sendMessage(`${text} is not a valid command. Use !l, !c, !r to kick`, username);
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Football forming. !j to join. Entry: ${fmt(this.costToJoin)} credits`
          : "A game is in progress. Wait for next game",
        username
      );
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = this.minCostToJoin;
    if (parts.length > 1) {
      const rawInput = parseFloat(parts[1]);
      const parsed = rawInput / 100;
      if (isNaN(parsed)) { this.sendMessage(`${parts[1]} is not a valid amount`, username); return; }
      if (parsed < this.minCostToJoin) { this.sendMessage(`Minimum entry is ${fmt(this.minCostToJoin)} credits`, username); return; }
      if (rawInput > this.maxCostToJoin) { this.sendMessage(`Maximum bet is ${this.maxCostToJoin} IDR`, username); return; }
      cost = parsed;
    }
    if (!(await this.userCanAfford(username, cost))) return;
    await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.round = 1;
    this.playerKicks.clear();
    this.playerKicks.set(username, "UNKNOWN");
    this.sendChannelMessage(`${username} started Football!`);
    this.waitForPlayers();
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Min entry: ${fmt(this.minCostToJoin)} credits`, username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.playerKicks.has(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.playerKicks.size >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.costToJoin))) return;
    await this.chargeUser(username, this.costToJoin);
    this.playerKicks.set(username, "UNKNOWN");
    this.sendChannelMessage(`${username} joined Football`);
  }

  private kick(username: string, dir: Direction): void {
    if (this.state !== BotState.PLAYING) {
      this.sendMessage("No active round", username); return;
    }
    if (!this.playerKicks.has(username)) {
      this.sendMessage("You are not in the game", username); return;
    }
    const existing = this.playerKicks.get(username);
    if (existing !== "UNKNOWN") {
      this.sendMessage(`You already kicked to ${existing}`, username); return;
    }
    this.playerKicks.set(username, dir);
    this.sendMessage(`You kicked to ${dir}`, username);
  }

  private waitForPlayers(): void {
    this.state = BotState.GAME_JOINING;
    this.sendChannelMessage(
      `Waiting for players. !j to join. Entry: ${fmt(this.costToJoin)} credits. ` +
      `${Math.round(this.waitForPlayerMs / 1000)}s to join.`
    );
    this.waitTimer = setTimeout(() => this.beginGame(), this.waitForPlayerMs);
  }

  private async beginGame(): Promise<void> {
    this.waitTimer = null;
    if (this.playerKicks.size < this.minPlayers) {
      await this.refundAll();
      this.resetGame();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      return;
    }
    this.countDown();
  }

  private countDown(): void {
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Round ${this.round++}. Kick the ball! !l=LEFT  !c=CENTER  !r=RIGHT. ` +
      `${Math.round(this.countDownMs / 1000)}s to decide.`
    );
    for (const player of this.playerKicks.keys()) {
      this.playerKicks.set(player, "UNKNOWN");
    }
    this.roundTimer = setTimeout(() => this.pickWinner(), this.countDownMs);
  }

  private async pickWinner(): Promise<void> {
    this.roundTimer = null;
    const left: string[] = [], center: string[] = [], right: string[] = [];
    for (const [player, dir] of this.playerKicks) {
      const chosen = dir === "UNKNOWN" ? randomDir() : dir;
      if (dir === "UNKNOWN") this.sendMessage(`You didn't kick. Bot kicked to ${chosen} for you`, player);
      if (chosen === "LEFT")   left.push(player);
      else if (chosen === "CENTER") center.push(player);
      else right.push(player);
    }

    this.sendChannelMessage(
      `LEFT [${left.join(", ")}]  CENTER [${center.join(", ")}]  RIGHT [${right.join(", ")}]`
    );

    const botDir = randomDir();
    this.sendChannelMessage(`Bot defends ${botDir}`);

    const losers = botDir === "LEFT" ? left : botDir === "CENTER" ? center : right;

    if (losers.length === this.playerKicks.size) {
      this.sendChannelMessage("Bot stopped everyone! All out. Enter !start to play again");
      this.resetGame();
      return;
    }

    for (const loser of losers) {
      this.sendMessage("You are out!", loser);
      await this.refundUser(loser, 0).catch(() => {});
      this.playerKicks.delete(loser);
    }

    if (this.playerKicks.size === 1) {
      const winner = [...this.playerKicks.keys()][0];
      const pot = (losers.length + 1) * this.costToJoin;
      if (pot > 0) await this.refundUser(winner, pot).catch(() => {});
      this.sendChannelMessage(
        `${winner} wins${pot > 0 ? ` ${fmt(pot)} credits` : ""}! Enter !start to play again`
      );
      this.resetGame();
      return;
    }

    this.sendChannelMessage(
      `${this.playerKicks.size} players left [${[...this.playerKicks.keys()].join(", ")}]. ` +
      `Next round in ${Math.round(this.nextRoundMs / 1000)}s`
    );
    this.roundTimer = setTimeout(() => this.countDown(), this.nextRoundMs);
  }

  private async refundAll(): Promise<void> {
    for (const player of this.playerKicks.keys()) {
      if (this.costToJoin > 0) await this.refundUser(player, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.playerKicks.clear();
  }
}
