import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import { Deck, CricketCard, getCardType, getCardName, getCardEmoticon } from "./deck";

function fmt(n: number): string { return n.toFixed(2); }

const COMMAND_BOWL   = "!d";
const COMMAND_CANCEL = "!n";

export class Cricket extends BotBase {
  readonly gameType = "cricket";

  private minPlayers:         number;
  private maxPlayers:         number;
  private timeToJoinGame:     number;
  private timeToEndRound:     number;
  private decisionInterval:   number;
  private waitBetweenRound:   number;
  private idleMs:             number;
  private amountJoinPot:      number;
  private maxAmountJoinPot:   number;
  private finalRound:         number;

  private startPlayer = "";
  private round       = 0;

  private playerScores       = new Map<string, number>();
  private playerThirdUmpires = new Map<string, number>();
  private playerDecks        = new Map<string, Deck>();
  private playerDrawnCards   = new Map<string, CricketCard>();
  private playerOuts:          string[] = [];

  private decisionTimer:       NodeJS.Timeout | null = null;
  private roundTimer:          NodeJS.Timeout | null = null;
  private waitingPlayersTimer: NodeJS.Timeout | null = null;

  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minPlayers       = this.param("minPlayers",            2);
    this.maxPlayers       = this.param("maxPlayers",           10);
    this.timeToJoinGame   = this.param("timeToJoinGame",   60_000);
    this.timeToEndRound   = this.param("timeToEndRound",   20_000);
    this.decisionInterval = this.param("decisionInterval", 20_000);
    this.waitBetweenRound = this.param("waitBetweenRound",  5_000);
    this.idleMs           = this.param("IdleInterval",  1_800_000);
    this.amountJoinPot    = this.param("amountJoinPot",           500);
    this.maxAmountJoinPot = this.param("maxAmountJoinPot",   999_999_999);
    this.finalRound       = this.param("finalRound",            6);

    this.sendChannelMessage(
      `Bot Cricket added. !start to play. Entry: ${fmt(this.amountJoinPot)} credits. ` +
      `Type ${COMMAND_BOWL} to draw a card when playing.`
    );
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME &&
      Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state !== BotState.PLAYING &&
      this.state !== BotState.GAME_JOINING &&
      this.state !== BotState.GAME_STARTING;
  }

  stopBot(): void {
    this.clearAllTimers();
    this.refundAll().catch(() => {});
    this.resetGame();
  }

  onUserJoinChannel(username: string): void {
    switch (this.state) {
      case BotState.NO_GAME:
        this.sendMessage(
          `Play Cricket. !start to start. Entry: ${fmt(this.amountJoinPot)} credits`, username
        );
        break;
      case BotState.GAME_JOINING:
        this.sendMessage(
          `Cricket forming. !j to join. Entry: ${fmt(this.amountJoinPot)} credits`, username
        );
        break;
      case BotState.PLAYING:
        this.sendMessage("Cricket is in play. Wait for next game!", username);
        break;
    }
  }

  onUserLeaveChannel(_username: string): void {}

  onMessage(username: string, text: string, _ts: number): void {
    const msg = text.toLowerCase().trim();

    if (msg.startsWith("!start")) { this.startNewGame(username, msg); return; }
    if (msg === "!j")             { this.joinGame(username);          return; }
    if (msg === COMMAND_CANCEL)   { this.processCancel(username);     return; }

    if (msg.startsWith(COMMAND_BOWL)) {
      if (this.state === BotState.PLAYING) {
        if (!this.playerScores.has(username)) {
          this.sendMessage("You are not in this game", username);
        } else {
          this.draw(username);
        }
      } else {
        this.sendMessage("No active game. Type !start to begin", username);
      }
      return;
    }
  }

  private async startNewGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      this.sendMessage(
        this.state === BotState.GAME_JOINING
          ? `Cricket forming. !j to join. Entry: ${fmt(this.amountJoinPot)} credits`
          : "A game is in progress. Wait for next game",
        username
      );
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = this.amountJoinPot;
    if (parts.length > 1) {
      const parsed = parseFloat(parts[1]);
      if (!isNaN(parsed) && parsed > 0) {
        if (parsed > this.maxAmountJoinPot) {
          this.sendMessage(`Maximum bet is ${this.maxAmountJoinPot} credits`, username); return;
        }
        cost = parsed;
      }
    }
    if (!(await this.userCanAfford(username, cost))) return;
    await this.chargeUser(username, cost);

    this.amountJoinPot = cost;
    this.startPlayer   = username;
    this.round         = 0;
    this.playerScores.clear();
    this.playerThirdUmpires.clear();
    this.playerDecks.clear();
    this.playerDrawnCards.clear();
    this.playerOuts = [];

    this.addPlayer(username);
    this.state = BotState.GAME_STARTING;
    this.sendChannelMessage(
      `${username} started Cricket! Entry: ${fmt(this.amountJoinPot)} credits. ` +
      `!j to join. ${Math.round(this.timeToJoinGame / 1000)}s to join.`
    );
    this.state = BotState.GAME_JOINING;
    this.waitingPlayersTimer = setTimeout(() => this.beginGame(), this.timeToJoinGame);
  }

  private async joinGame(username: string): Promise<void> {
    if (this.state === BotState.NO_GAME) {
      this.sendMessage(`!start to start. Entry: ${fmt(this.amountJoinPot)} credits`, username);
      return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage("A game is in progress. Wait for next game", username); return;
    }
    if (this.playerScores.has(username)) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.playerScores.size >= this.maxPlayers) {
      this.sendMessage("Game is full. Wait for next game", username); return;
    }
    if (!(await this.userCanAfford(username, this.amountJoinPot))) return;
    await this.chargeUser(username, this.amountJoinPot);
    this.addPlayer(username);
    this.sendChannelMessage(`${username} joined Cricket`);
  }

  private addPlayer(username: string): void {
    this.playerScores.set(username, 0);
    this.playerThirdUmpires.set(username, 0);
    const deck = new Deck();
    deck.init();
    this.playerDecks.set(username, deck);
  }

  private processCancel(username: string): void {
    if (this.state === BotState.GAME_JOINING && username === this.startPlayer) {
      this.clearAllTimers();
      this.refundAll().catch(() => {});
      this.sendChannelMessage("Game cancelled");
      this.resetGame();
    }
  }

  private async beginGame(): Promise<void> {
    this.waitingPlayersTimer = null;
    if (this.playerScores.size < this.minPlayers) {
      await this.refundAll();
      this.sendChannelMessage("Not enough players. Enter !start to try again");
      this.resetGame();
      return;
    }
    this.state = BotState.PLAYING;
    this.sendChannelMessage(
      `Cricket starts! ${this.playerScores.size} players. ` +
      `Round 1 of ${this.finalRound}. Type ${COMMAND_BOWL} to draw your card!`
    );
    this.nextRound();
  }

  private nextRound(): void {
    if (this.playerScores.size <= 1) {
      this.resolveGame();
      return;
    }
    this.round++;
    if (this.round > this.finalRound) {
      this.resolveGame();
      return;
    }
    this.playerDrawnCards.clear();
    this.sendChannelMessage(
      `Round ${this.round}/${this.finalRound}. ` +
      `Players: [${[...this.playerScores.keys()].join(", ")}]. ` +
      `Type ${COMMAND_BOWL} to draw! ${Math.round(this.decisionInterval / 1000)}s`
    );
    this.decisionTimer = setTimeout(() => this.autoDrawRemaining(), this.decisionInterval);
  }

  private draw(username: string): void {
    if (this.playerDrawnCards.has(username)) {
      this.sendMessage("You already drew this round!", username); return;
    }
    const deck = this.playerDecks.get(username)!;
    let card = deck.draw();
    if (card === null) {
      deck.init();
      card = deck.draw()!;
    }
    this.playerDrawnCards.set(username, card);
    const type = getCardType(card);
    const name = getCardName(card);
    const emoticon = getCardEmoticon(card);

    if (type === "O") {
      const thirdUmpires = this.playerThirdUmpires.get(username) ?? 0;
      if (thirdUmpires > 0) {
        this.playerThirdUmpires.set(username, thirdUmpires - 1);
        this.sendMessage(
          `${emoticon} ${name}! Third Umpire review saves you! ` +
          `(${thirdUmpires - 1} Third Umpire${thirdUmpires - 1 !== 1 ? "s" : ""} left)`,
          username
        );
        this.sendChannelMessage(`${username} drew ${emoticon} ${name} but was saved by Third Umpire!`);
      } else {
        this.sendChannelMessage(`${username} drew ${emoticon} ${name}! OUT!`);
        this.playerOuts.push(username);
      }
    } else if (type === "U") {
      const current = this.playerThirdUmpires.get(username) ?? 0;
      this.playerThirdUmpires.set(username, current + 1);
      this.sendMessage(
        `${emoticon} Third Umpire saved! You now have ${current + 1} Third Umpire lifeline${current + 1 !== 1 ? "s" : ""}`,
        username
      );
      this.sendChannelMessage(`${username} drew ${emoticon} Third Umpire!`);
    } else {
      const runs = parseInt(type, 10);
      const current = this.playerScores.get(username) ?? 0;
      this.playerScores.set(username, current + runs);
      this.sendChannelMessage(
        `${username} drew ${emoticon} ${name}! +${runs} runs. Total: ${current + runs}`
      );
    }

    if (this.playerDrawnCards.size >= this.playerScores.size) {
      if (this.decisionTimer) { clearTimeout(this.decisionTimer); this.decisionTimer = null; }
      this.roundTimer = setTimeout(() => this.endRound(), 1000);
    }
  }

  private autoDrawRemaining(): void {
    this.decisionTimer = null;
    for (const username of this.playerScores.keys()) {
      if (!this.playerDrawnCards.has(username)) {
        this.draw(username);
      }
    }
    this.roundTimer = setTimeout(() => this.endRound(), 500);
  }

  private endRound(): void {
    this.roundTimer = null;
    for (const out of this.playerOuts) {
      this.playerScores.delete(out);
      this.playerDecks.delete(out);
      this.playerThirdUmpires.delete(out);
    }
    this.playerOuts = [];

    if (this.playerScores.size > 1) {
      const scores = [...this.playerScores.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([p, s]) => `${p}: ${s}`)
        .join(", ");
      this.sendChannelMessage(`Scores: ${scores}`);
    }

    this.roundTimer = setTimeout(() => this.nextRound(), this.waitBetweenRound);
  }

  private async resolveGame(): Promise<void> {
    if (this.playerScores.size === 0) {
      this.sendChannelMessage("No more players left in the game. Enter !start to start a new game");
      await this.endGame(false);
      return;
    }
    if (this.playerScores.size === 1) {
      const winner = [...this.playerScores.keys()][0];
      this.sendChannelMessage(`${winner} is the last player in.`);
      await this.endGame(true, winner);
      return;
    }

    const sorted = [...this.playerScores.entries()].sort((a, b) => b[1] - a[1]);
    const maxScore = sorted[0][1];
    const winners  = sorted.filter(([, s]) => s === maxScore).map(([p]) => p);

    this.sendChannelMessage("Cricket game over! Final scores:");
    for (const [player, score] of sorted) {
      this.sendChannelMessage(`  ${player}: ${score} runs`);
    }

    if (winners.length > 1) {
      this.sendChannelMessage(`Tie! ${winners.join(", ")} share the pot.`);
    }
    await this.endGame(true, ...winners);
  }

  private async endGame(payOut: boolean, ...winners: string[]): Promise<void> {
    if (payOut && winners.length > 0) {
      const totalPot = this.playerScores.size > 0
        ? [...this.playerScores.keys()].length * this.amountJoinPot
        : 0;
      const share = totalPot / winners.length;
      if (share > 0) {
        for (const w of winners) {
          await this.refundUser(w, share).catch(() => {});
        }
        const winnerStr = winners.join(", ");
        this.sendChannelMessage(
          `${winnerStr} win${winners.length > 1 ? "" : "s"} ${fmt(share)} credits! Enter !start to play again`
        );
      }
    }
    this.resetGame();
    setTimeout(() => {
      this.sendChannelMessage(`Bot Cricket ready. Entry: ${fmt(this.amountJoinPot)} credits. !start to play`);
    }, 5_000);
  }

  private async refundAll(): Promise<void> {
    for (const player of this.playerScores.keys()) {
      if (this.amountJoinPot > 0) {
        await this.refundUser(player, this.amountJoinPot).catch(() => {});
      }
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state = BotState.NO_GAME;
    this.round = 0;
    this.playerScores.clear();
    this.playerThirdUmpires.clear();
    this.playerDecks.clear();
    this.playerDrawnCards.clear();
    this.playerOuts = [];
    this.startPlayer = "";
  }

  private clearAllTimers(): void {
    if (this.decisionTimer)       { clearTimeout(this.decisionTimer);       this.decisionTimer       = null; }
    if (this.roundTimer)          { clearTimeout(this.roundTimer);           this.roundTimer          = null; }
    if (this.waitingPlayersTimer) { clearTimeout(this.waitingPlayersTimer);  this.waitingPlayersTimer = null; }
  }
}
