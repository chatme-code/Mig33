import { BotBase, BotContext } from "../../botBase";
import { BotState } from "../../types";
import {
  Card,
  BLUE, GREEN, RED, YELLOW, WILD_COLOR,
  WILD, DRAW_2, REVERSE, SKIP, WILD_DRAW_4, ANY,
  STR_WILD, STR_DRAW_2, STR_REVERSE, STR_SKIP, STR_WILD_DRAW_4,
  COLOR_CHARS, COLOR_EMOTICONS,
} from "./oneCard";
import { Player } from "./onePlayer";

function fmt(n: number): string { return n.toFixed(2); }

function randomInt(max: number): number {
  return Math.floor(Math.random() * max);
}

export class One extends BotBase {
  readonly gameType = "uno";

  private minCostToJoin:  number;
  private maxCostToJoin:  number;
  private timeToJoinGame: number;
  private idleMs:         number;

  private costToJoin = 0;
  private drawn       = false;
  private inProgress  = false;
  private dealer      = "";
  private wildColour  = WILD_COLOR;

  private playersList: Player[] = [];
  private playerNames: Record<string, boolean> = {};
  private cardDeck:    Card[]   = [];
  private discardPile: Card[]   = [];
  private cardInPlay:  Card | null = null;
  private nextPlayer:  Player | null = null;

  private waitTimer: NodeJS.Timeout | null = null;
  private timeLastGameFinished = Date.now();

  constructor(ctx: BotContext) {
    super(ctx);
    this.minCostToJoin  = this.param("MinCostToJoinGame",     500);
    this.maxCostToJoin  = this.param("MaxCostToJoinGame", 999_999_999);
    this.timeToJoinGame = this.param("TimeToJoinGame", 90_000);
    this.idleMs         = this.param("IdleInterval", 1_800_000);

    this.sendChannelMessage(
      `Bot ONE added. !start to play. Min entry: ${fmt(this.minCostToJoin)} credits. ` +
      "Commands: !deal, !p <card>, !d=draw, !s=pass, !h=hand, !c=counts"
    );
    this.sendChannelMessage(
      `Card format: !p <color><value>  Colors: b=Blue g=Green r=Red y=Yellow  ` +
      `Special: d2=Draw2 r=Reverse s=Skip  Wild: !p w <color>  WildDraw4: !p wd4 <color>`
    );
  }

  isIdle(): boolean {
    return this.state === BotState.NO_GAME && Date.now() - this.timeLastGameFinished > this.idleMs;
  }

  canBeStoppedNow(): boolean {
    return this.state !== BotState.PLAYING && this.state !== BotState.GAME_JOINING;
  }

  stopBot(): void {
    this.clearAllTimers();
    this.refundAll().catch(() => {});
    this.resetGame();
  }

  onUserJoinChannel(username: string): void {
    if (this.inProgress) {
      this.sendMessage(`ONE game in progress. Wait for next game!`, username);
    } else {
      this.sendMessage(
        `Play ONE! !start to begin. Min entry: ${fmt(this.minCostToJoin)} credits`,
        username
      );
    }
  }

  onUserLeaveChannel(username: string): void {
    this.removePlayer(username);
  }

  onMessage(username: string, text: string, _ts: number): void {
    const lower = text.toLowerCase().trim();
    if (lower.startsWith("!start")) { this.startGame(username, lower); return; }
    if (lower === "!j") { this.addPlayerCmd(username); return; }
    if (lower === "!deal") { this.dealGame(username); return; }
    if (lower === "!h") { this.sendHand(username); return; }
    if (lower === "!c") { this.count(); return; }
    if (lower.startsWith("!d") && this.inProgress && this.isPlayersTurn(username)) {
      this.draw(username); return;
    }
    if (lower.startsWith("!s") && this.inProgress && this.isPlayersTurn(username)) {
      this.pass(username); return;
    }
    if (lower.startsWith("!p") && this.inProgress) {
      if (this.isPlayersTurn(username)) {
        this.playCardCmd(username, lower); return;
      } else {
        this.sendMessage(`It is not your turn`, username); return;
      }
    }
    if (lower === "!reset" && username === this.gameStarter) {
      this.reset(username); return;
    }
    this.sendMessage(
      "Commands: !start, !j=join, !deal=start play, !p <card>=play, !d=draw, !s=pass, !h=hand, !c=counts, !reset",
      username
    );
  }

  private async startGame(username: string, msg: string): Promise<void> {
    if (this.state !== BotState.NO_GAME) {
      if (this.state === BotState.GAME_JOINING || this.inProgress) {
        this.sendMessage(`ONE game already running. ${this.inProgress ? "In play!" : "Joining: !j to join."}`, username);
      }
      return;
    }
    const parts = msg.trim().split(/\s+/);
    let cost = this.minCostToJoin;
    if (parts.length > 1) {
      const rawInput = parseFloat(parts[1]);
      const parsed = rawInput / 100;
      if (isNaN(parsed)) { this.sendMessage(`${parts[1]} is not a valid amount`, username); return; }
      if (parsed > 0 && parsed < this.minCostToJoin) {
        this.sendMessage(`Minimum entry is ${fmt(this.minCostToJoin)} credits`, username); return;
      }
      if (rawInput > this.maxCostToJoin) { this.sendMessage(`Maximum bet is ${this.maxCostToJoin} IDR`, username); return; }
      cost = parsed > 0 ? parsed : 0;
    }
    if (cost > 0 && !(await this.userCanAfford(username, cost))) return;
    if (cost > 0) await this.chargeUser(username, cost);
    this.costToJoin = cost;
    this.gameStarter = username;
    this.state = BotState.GAME_JOINING;
    this.addPlayerInternal(username);
    const secs = Math.round(this.timeToJoinGame / 1000);
    this.sendChannelMessage(
      `${username} started ONE! !j to join. Entry: ${fmt(this.costToJoin)} credits. ` +
      `${secs}s to join. !deal to start when ready. Min 2 players.`
    );
    this.waitTimer = setTimeout(() => this.beginPlay(), this.timeToJoinGame);
  }

  private async addPlayerCmd(username: string): Promise<void> {
    if (this.playersList.length >= 4) {
      this.sendMessage("Game is full (max 4 players). Wait for next game", username); return;
    }
    if (this.playerNames[username] !== undefined) {
      this.sendMessage("You already joined. Please wait", username); return;
    }
    if (this.state !== BotState.GAME_JOINING) {
      this.sendMessage(
        this.inProgress ? "Game already in progress!" : "No game to join. Use !start",
        username
      ); return;
    }
    if (this.costToJoin > 0 && username !== this.gameStarter) {
      if (!(await this.userCanAfford(username, this.costToJoin))) return;
      await this.chargeUser(username, this.costToJoin);
    }
    this.addPlayerInternal(username);
    this.sendChannelMessage(`${username} joined ONE`);
    this.sendMessage(
      `You joined! Entry: ${fmt(this.costToJoin)} credits. Wait for !deal from ${this.dealer}`,
      username
    );
  }

  private addPlayerInternal(username: string): void {
    const player = new Player(username);
    this.playersList.push(player);
    if (!this.dealer) {
      this.dealer = username;
      this.playerNames[username] = true;
    } else {
      this.playerNames[username] = false;
    }
  }

  private dealGame(username: string): void {
    if (username.toLowerCase() !== this.dealer.toLowerCase()) return;
    if (this.inProgress) return;
    if (this.playersList.length < 2) {
      this.sendChannelMessage(`Need at least 1 more player! ${this.playersList.length}/2 players.`); return;
    }
    if (this.waitTimer) { clearTimeout(this.waitTimer); this.waitTimer = null; }
    this.inProgress = true;
    this.state = BotState.PLAYING;
    this.setNextPlayer(this.playersList[1]);
    this.deal();
    this.cardInPlay = this.drawFromDeck();
    if (this.cardInPlay) this.discardPile.push(this.cardInPlay);

    while (this.cardInPlay && (this.cardInPlay.getValue() === WILD || this.cardInPlay.getValue() === WILD_DRAW_4)) {
      this.cardInPlay = this.drawFromDeck();
      if (this.cardInPlay) this.discardPile.push(this.cardInPlay);
    }

    if (this.cardInPlay) {
      const v = this.cardInPlay.getValue();
      if (v === REVERSE) {
        if (this.playersList.length > 2) this.advanceNextPlayer(-1);
        this.reversePlayerOrder();
      } else if (v === SKIP) {
        this.sendChannelMessage(`${this.nextPlayer!.getName()} is SKIPPED by the first card!`);
        this.advanceNextPlayer(1);
      } else if (v === DRAW_2) {
        this.drawCards(this.nextPlayer!.getName(), 2);
        this.sendChannelMessage(`${this.nextPlayer!.getName()} draws 2 and is SKIPPED!`);
        this.advanceNextPlayer(1);
      }
    }
    this.showTopCard();
  }

  private beginPlay(): void {
    this.waitTimer = null;
    if (this.playersList.length < 2) {
      this.sendChannelMessage("Not enough players joined. Enter !start to try again");
      this.refundAll().then(() => this.resetGame());
      return;
    }
    this.sendChannelMessage(
      `Time's up for joining! Game has ${this.playersList.length} player${this.playersList.length > 1 ? "s" : ""}. ` +
      `${this.dealer}: use !deal to start!`
    );
  }

  private deal(): void {
    this.initDeck();
    for (const player of this.playersList) {
      for (let x = 0; x < 7; x++) {
        const idx = randomInt(this.cardDeck.length);
        player.addCard(this.cardDeck[idx]);
        this.cardDeck.splice(idx, 1);
      }
      this.sendMessage(`Your cards: ${player.toString()}`, player.getName());
    }
  }

  private initDeck(): void {
    this.cardDeck = [];
    const colors = [BLUE, GREEN, RED, YELLOW];
    for (const col of colors) this.cardDeck.push(new Card(col, 0));
    for (let y = 0; y <= 1; y++) {
      for (let v = 1; v <= 9; v++) {
        for (const col of colors) this.cardDeck.push(new Card(col, v));
      }
    }
    for (let x = 0; x < 2; x++) {
      for (const col of colors) {
        this.cardDeck.push(new Card(col, DRAW_2));
        this.cardDeck.push(new Card(col, REVERSE));
        this.cardDeck.push(new Card(col, SKIP));
      }
    }
    for (let x = 0; x < 4; x++) {
      this.cardDeck.push(new Card(WILD_COLOR, WILD));
      this.cardDeck.push(new Card(WILD_COLOR, WILD_DRAW_4));
    }
    this.wildColour = WILD_COLOR;
    this.discardPile = [];
  }

  private redeal(): void {
    this.wildColour = WILD_COLOR;
    const colors = [BLUE, GREEN, RED, YELLOW];
    for (const col of colors) this.cardDeck.push(new Card(col, 0));
    for (let y = 0; y <= 1; y++) {
      for (let v = 1; v <= 9; v++) {
        for (const col of colors) this.cardDeck.push(new Card(col, v));
      }
    }
    for (let x = 0; x < 2; x++) {
      for (const col of colors) {
        this.cardDeck.push(new Card(col, DRAW_2));
        this.cardDeck.push(new Card(col, REVERSE));
        this.cardDeck.push(new Card(col, SKIP));
      }
    }
    for (let x = 0; x < 4; x++) {
      this.cardDeck.push(new Card(WILD_COLOR, WILD));
      this.cardDeck.push(new Card(WILD_COLOR, WILD_DRAW_4));
    }
    for (const p of this.playersList) {
      for (const c of p.getCards()) {
        const idx = this.cardDeck.findIndex(dc => dc.equals(c));
        if (idx !== -1) this.cardDeck.splice(idx, 1);
      }
    }
  }

  private drawFromDeck(): Card | null {
    if (this.cardDeck.length === 0) return null;
    const idx = randomInt(this.cardDeck.length);
    const card = this.cardDeck[idx];
    this.cardDeck.splice(idx, 1);
    return card;
  }

  private noCardsLeft(): void {
    this.sendChannelMessage("Shuffling cards back in...");
    this.redeal();
  }

  private drawCards(playerName: string, numCards: number): boolean {
    const player = this.getPlayer(playerName);
    if (!player || !this.cardDeck) return false;
    if (this.cardDeck.length === 0) {
      if (this.discardPile.length >= numCards) {
        this.cardDeck = [...this.discardPile];
        this.discardPile = [];
      } else {
        return false;
      }
    }
    let drawnStr = "You drew: ";
    for (let x = 0; x < numCards; x++) {
      if (this.cardDeck.length === 0) return false;
      const card = this.drawFromDeck()!;
      player.addCard(card);
      drawnStr += card.toString() + " ";
    }
    this.sendMessage(drawnStr.trim(), playerName);
    return true;
  }

  private draw(sender: string): void {
    if (this.drawCards(sender, 1)) {
      this.sendChannelMessage(`${sender} drew a card`);
    } else {
      this.noCardsLeft();
      this.drawCards(sender, 1);
      this.sendChannelMessage(`${sender} drew a card`);
    }
    this.drawn = true;
  }

  private pass(sender: string): void {
    if (this.drawn) {
      this.sendChannelMessage(`${sender} passes`);
      this.advanceNextPlayer(1);
      this.showTopCard();
      this.drawn = false;
    } else {
      this.sendMessage("You must draw a card first with !d, then pass with !s", sender);
    }
  }

  private sendHand(playerName: string): void {
    const player = this.getPlayer(playerName);
    if (player) this.sendMessage(player.toString(), playerName);
  }

  private count(): void {
    let res = "Card counts: ";
    for (const p of this.playersList) {
      res += `${p.getName()}: (${p.cardCount()})  `;
    }
    this.sendChannelMessage(res.trim());
  }

  private reset(sender: string): void {
    this.endGame(true, null);
    this.sendChannelMessage(`${sender} reset the game. Enter !start to play again`);
  }

  private playCardCmd(sender: string, message: string): void {
    const valid = this.playCard(sender, message);
    if (!valid) return;

    const player = this.getPlayer(sender);
    if (!player) return;

    if (player.hasWon()) {
      let totalScore = 0;
      for (const p of this.playersList) {
        if (p.getName().toLowerCase() === sender.toLowerCase()) continue;
        totalScore += p.getPoints();
        this.sendChannelMessage(p.toString());
      }
      const msg = totalScore > 0 ? `${sender} wins ONE with ${totalScore} points from opponents!` : `${sender} wins ONE!`;
      this.sendChannelMessage(msg);
      this.endGame(false, sender);
      return;
    }

    if (player.hasUno()) {
      this.sendChannelMessage(`ONE! ${sender} has only 1 card left!`);
    }
    this.showTopCard();
    this.drawn = false;
  }

  private playCard(sender: string, message: string): boolean {
    const player = this.getPlayer(sender);
    if (!player) return false;

    const cardToPlay = message.toLowerCase().substring("!p".length).trim();
    let cardValue  = -1;
    let cardColour = -1;
    let cardColourStr = "";

    try {
      if (cardToPlay.indexOf(STR_WILD_DRAW_4) !== -1 && cardToPlay.length === 5) {
        cardValue = WILD_DRAW_4;
        cardColourStr = cardToPlay.charAt(4);
      } else if (cardToPlay.indexOf(STR_DRAW_2) !== -1 && cardToPlay.length === 4) {
        cardValue = DRAW_2;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.charAt(2) === "r" && cardToPlay.indexOf(STR_WILD) === -1 && cardToPlay.length === 3) {
        cardValue = REVERSE;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.indexOf(STR_SKIP) !== -1 && cardToPlay.length === 3) {
        cardValue = SKIP;
        cardColourStr = cardToPlay.charAt(0);
      } else if (cardToPlay.indexOf(STR_WILD) !== -1 && cardToPlay.length === 3) {
        cardValue = WILD;
        cardColourStr = cardToPlay.charAt(2);
      } else {
        cardValue = parseInt(cardToPlay.charAt(1), 10);
        cardColourStr = cardToPlay.charAt(0);
      }

      if (!["b", "g", "r", "y"].includes(cardColourStr)) {
        this.sendMessage(`Invalid color '${cardColourStr}'. Use b=Blue g=Green r=Red y=Yellow`, sender);
        return false;
      }
      cardColour = COLOR_CHARS[cardColourStr];

    } catch {
      this.sendMessage("Invalid card format. Try: !p b5  !p rd2  !p gr  !p ys  !p w b  !p wd4 r", sender);
      return false;
    }

    if (cardColour === this.cardInPlay?.getColour() ||
        cardColour === this.wildColour ||
        cardValue  === this.cardInPlay?.getValue() ||
        cardValue  === WILD ||
        cardValue  === WILD_DRAW_4) {

      const card = player.getCard(cardValue, cardColour);
      if (!card) {
        this.sendMessage(
          `You don't have that card. !h to see your hand. ` +
          `Top: ${this.cardInPlay?.toString()}${this.wildColour !== WILD_COLOR ? " (color: " + COLOR_EMOTICONS[this.wildColour] + ")" : ""}`,
          sender
        );
        return false;
      }

      this.discardPile.push(card);
      this.cardInPlay = card;
      player.removeCard(card);
      let additionalInfo = ".";

      if (cardValue === WILD_DRAW_4) {
        this.wildColour = cardColour;
        this.advanceNextPlayer(1);
        if (!this.drawCards(this.nextPlayer!.getName(), 4)) {
          this.noCardsLeft();
        }
        const colorCard = new Card(cardColour, ANY);
        additionalInfo = ` changes color to ${colorCard}. ${this.nextPlayer!.getName()} draws 4 and is SKIPPED`;
        this.advanceNextPlayer(1);

      } else if (cardValue === DRAW_2) {
        this.advanceNextPlayer(1);
        if (!this.drawCards(this.nextPlayer!.getName(), 2)) {
          this.noCardsLeft();
        }
        additionalInfo = ` ${this.nextPlayer!.getName()} draws 2 and is SKIPPED`;
        this.advanceNextPlayer(1);

      } else if (cardValue === REVERSE) {
        if (this.playersList.length > 2) this.advanceNextPlayer(-1);
        additionalInfo = ` — direction reversed! Turn back to ${this.nextPlayer!.getName()}`;
        this.reversePlayerOrder();

      } else if (cardValue === SKIP) {
        this.advanceNextPlayer(1);
        additionalInfo = `, ${this.nextPlayer!.getName()} is SKIPPED`;
        this.advanceNextPlayer(1);

      } else if (cardValue === WILD) {
        this.wildColour = cardColour;
        const colorCard = new Card(cardColour, ANY);
        additionalInfo = ` changes color to ${colorCard}`;
        this.advanceNextPlayer(1);

      } else {
        this.advanceNextPlayer(1);
        this.wildColour = WILD_COLOR;
      }

      this.sendChannelMessage(`${sender} plays ${this.cardInPlay}${additionalInfo}`);
      return true;
    }

    if (!player.hasCardWithValue(cardValue) && !player.hasCardWithColour(cardColour)) {
      this.sendMessage("Invalid card. You don't have that card.", sender);
    } else {
      this.sendMessage(
        `You can't play that. Must match color or value of top card: ` +
        `${this.cardInPlay?.toString()}${this.wildColour !== WILD_COLOR ? " (color: " + COLOR_EMOTICONS[this.wildColour] + ")" : ""}`,
        sender
      );
    }
    return false;
  }

  private reversePlayerOrder(): void {
    this.playersList = [...this.playersList].reverse();
  }

  private advanceNextPlayer(increment: number): void {
    if (!this.nextPlayer || this.playersList.length === 0) return;
    let idx = this.playersList.indexOf(this.nextPlayer);
    idx += increment;
    if (idx > this.playersList.length - 1) {
      this.nextPlayer = this.playersList[0];
    } else if (idx < 0) {
      this.nextPlayer = this.playersList[this.playersList.length - 1];
    } else {
      this.nextPlayer = this.playersList[idx];
    }
  }

  private setNextPlayer(player: Player): void {
    this.nextPlayer = player;
  }

  private getPlayer(name: string): Player | null {
    return this.playersList.find(p => p.getName().toLowerCase() === name.toLowerCase()) ?? null;
  }

  private isPlayersTurn(sender: string): boolean {
    return this.nextPlayer !== null &&
           this.nextPlayer.getName().toLowerCase() === sender.toLowerCase();
  }

  private showTopCard(): void {
    if (!this.cardInPlay || !this.nextPlayer) return;
    let colorInfo = "";
    if ([BLUE, GREEN, RED, YELLOW].includes(this.wildColour)) {
      colorInfo = ` (active color: ${COLOR_EMOTICONS[this.wildColour]}*)`;
    }
    this.sendChannelMessage(
      `${this.nextPlayer.getName()}'s turn. Top card: ${this.cardInPlay}${colorInfo}`
    );
    this.sendMessage(
      `Your turn! Top: ${this.cardInPlay}${colorInfo}. Your hand: ${this.getPlayer(this.nextPlayer.getName())?.toString() ?? ""}`,
      this.nextPlayer.getName()
    );
  }

  private removePlayer(name: string): void {
    const player = this.getPlayer(name);
    if (!player) return;

    delete this.playerNames[name];

    if (this.nextPlayer && this.nextPlayer.getName().toLowerCase() === name.toLowerCase()) {
      this.advanceNextPlayer(1);
    }

    if (this.costToJoin > 0) {
      this.refundUser(name, this.costToJoin).catch(() => {});
    }

    this.discardPile.push(...player.getCards());
    this.playersList = this.playersList.filter(p => p !== player);

    if (this.nextPlayer) {
      this.sendChannelMessage(`${name} left. Next: ${this.nextPlayer.getName()}`);
    }

    if (this.playersList.length === 1 && this.inProgress) {
      const winner = this.playersList[0].getName();
      const pot = Object.keys(this.playerNames).length * this.costToJoin + this.costToJoin;
      if (pot > 0) this.refundUser(winner, pot).catch(() => {});
      this.sendChannelMessage(
        `${winner} wins by default${pot > 0 ? ` — ${fmt(pot)} credits` : ""}! Enter !start to play again`
      );
      this.endGame(false, winner);
    } else if (this.playersList.length === 0) {
      this.sendChannelMessage("No players left. Game over.");
      this.endGame(true, null);
    }
  }

  private endGame(cancelPot: boolean, winner: string | null): void {
    if (!cancelPot && winner && this.costToJoin > 0) {
      const totalPlayers = Object.keys(this.playerNames).length;
      const pot = totalPlayers * this.costToJoin;
      if (pot > 0) this.refundUser(winner, pot).catch(() => {});
    }
    this.resetGame();
    this.sendChannelMessage(`Game ended. Entry: ${fmt(this.minCostToJoin)} credits. !start to play again`);
  }

  private async refundAll(): Promise<void> {
    if (this.costToJoin <= 0) return;
    for (const name of Object.keys(this.playerNames)) {
      await this.refundUser(name, this.costToJoin).catch(() => {});
    }
  }

  private resetGame(): void {
    this.clearAllTimers();
    this.timeLastGameFinished = Date.now();
    this.state      = BotState.NO_GAME;
    this.inProgress = false;
    this.drawn      = false;
    this.dealer     = "";
    this.wildColour = WILD_COLOR;
    this.playersList = [];
    this.playerNames = {};
    this.cardDeck    = [];
    this.discardPile = [];
    this.cardInPlay  = null;
    this.nextPlayer  = null;
  }
}
