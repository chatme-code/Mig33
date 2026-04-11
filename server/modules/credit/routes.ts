import type { Express } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { z } from "zod";
import { storage } from "../../storage";
import { insertRewardProgramSchema, insertVoucherBatchSchema, CREDIT_TRANSACTION_TYPE, VOUCHER_STATUS } from "@shared/schema";
import { formatCreditBalance } from "../auth/routes";

export function registerCreditRoutes(app: Express) {

  // ── GET /api/credit/balance ──────────────────────────────────────────────
  // Get credit balance for a user
  // Query: ?username=xxx  (if omitted uses session, for demo requires ?username=)
  app.get("/api/credit/balance/:username", async (req, res) => {
    try {
      const { username } = req.params;
      const acct = await storage.getCreditAccount(username);
      res.json({
        username: acct.username,
        currency: acct.currency,
        balance: acct.balance,
        fundedBalance: acct.fundedBalance,
        formatted: formatCreditBalance(acct.balance, acct.currency),
        updatedAt: acct.updatedAt,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/balance ──────────────────────────────────────────────
  // Shorthand with ?username= query param
  app.get("/api/credit/balance", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    try {
      const acct = await storage.getCreditAccount(username);
      res.json({
        username: acct.username,
        currency: acct.currency,
        balance: acct.balance,
        fundedBalance: acct.fundedBalance,
        formatted: formatCreditBalance(acct.balance, acct.currency),
        updatedAt: acct.updatedAt,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/credit/transfer ─────────────────────────────────────────────
  // Transfer MIG credits from one user to another — no fee, full amount delivered
  // Body: { fromUsername, toUsername, amount }
  // AccessControl: TRANSFER_CREDIT_OUT (emailVerified required)
  app.post("/api/credit/transfer", requireVerified("TRANSFER_CREDIT_OUT"), async (req, res) => {
    const schema = z.object({
      fromUsername: z.string().min(1),
      toUsername: z.string().min(1),
      amount: z.number().positive("Amount must be positive"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { fromUsername, toUsername, amount } = parsed.data;
    if (fromUsername === toUsername) return res.status(400).json({ error: "Cannot transfer to yourself" });

    try {
      const result = await storage.transferCredit(fromUsername, toUsername, amount);
      res.json({
        success: true,
        fromUsername,
        toUsername,
        transferAmount: amount,
        fee: result.fee,
        netReceived: Math.round((amount - result.fee) * 100) / 100,
        fromBalance: result.from.balance,
        toBalance: result.to.balance,
        currency: result.from.currency,
      });
    } catch (e: any) {
      const status = e.message === "Insufficient balance" ? 402 : 500;
      res.status(status).json({ error: e.message });
    }
  });

  // ── GET /api/credit/transactions ──────────────────────────────────────────
  // Get transaction history for a user
  // Query: ?username=xxx&limit=50
  app.get("/api/credit/transactions", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    const limit = parseInt(req.query.limit as string) || 50;
    try {
      const txns = await storage.getCreditTransactions(username, limit);
      const txTypeNames: Record<number, string> = {
        [CREDIT_TRANSACTION_TYPE.CREDIT_CARD]: "Credit Card",
        [CREDIT_TRANSACTION_TYPE.VOUCHER_RECHARGE]: "Voucher Recharge",
        [CREDIT_TRANSACTION_TYPE.BONUS_CREDIT]: "Bonus Credit",
        [CREDIT_TRANSACTION_TYPE.REFERRAL_CREDIT]: "Referral Credit",
        [CREDIT_TRANSACTION_TYPE.ACTIVATION_CREDIT]: "Activation Credit",
        [CREDIT_TRANSACTION_TYPE.USER_TO_USER_TRANSFER]: "User Transfer",
        [CREDIT_TRANSACTION_TYPE.TRANSFER_CREDIT_FEE]: "Transfer Fee",
        [CREDIT_TRANSACTION_TYPE.MARKETING_REWARD]: "Marketing Reward",
        [CREDIT_TRANSACTION_TYPE.GAME_BET]: "Game Bet",
        [CREDIT_TRANSACTION_TYPE.GAME_REWARD]: "Game Win",
        [CREDIT_TRANSACTION_TYPE.GAME_REFUND]: "Game Win",
        [CREDIT_TRANSACTION_TYPE.REFUND]: "Refund",
        [CREDIT_TRANSACTION_TYPE.CREDIT_EXPIRED]: "Credit Expired",
        [CREDIT_TRANSACTION_TYPE.CREDIT_WRITE_OFF]: "Credit Write-off",
        [CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE]: "Virtual Gift Purchase",
        [CREDIT_TRANSACTION_TYPE.PRODUCT_PURCHASE]: "Product Purchase",
        [CREDIT_TRANSACTION_TYPE.BANK_TRANSFER]: "Bank Transfer",
      };
      res.json({
        username,
        count: txns.length,
        transactions: txns.map((t) => ({
          ...t,
          typeName: txTypeNames[t.type] ?? `Type ${t.type}`,
        })),
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/transactions/:id ─────────────────────────────────────
  app.get("/api/credit/transactions/:id", async (req, res) => {
    const tx = await storage.getCreditTransaction(req.params.id);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });
    res.json(tx);
  });

  // ── POST /api/credit/transactions/reverse ────────────────────────────────
  // Reverse (refund) a transaction — creates a reversal entry
  app.post("/api/credit/transactions/reverse", async (req, res) => {
    const schema = z.object({
      transactionId: z.string().min(1),
      misUsername: z.string().min(1).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const tx = await storage.getCreditTransaction(parsed.data.transactionId);
    if (!tx) return res.status(404).json({ error: "Transaction not found" });

    try {
      await storage.adjustBalance(tx.username, -tx.amount, tx.currency);
      const acct = await storage.getCreditAccount(tx.username);
      const reversal = await storage.createCreditTransaction({
        username: tx.username,
        type: CREDIT_TRANSACTION_TYPE.REFUND,
        reference: tx.id,
        description: `Reversal of ${tx.description ?? tx.id}`,
        currency: tx.currency,
        amount: -tx.amount,
        fundedAmount: 0,
        tax: 0,
        runningBalance: acct.balance,
      });
      res.json({ success: true, reversal });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/vouchers/batches ─────────────────────────────────────
  // List all voucher batches (optionally filter by creator)
  app.get("/api/credit/vouchers/batches", async (req, res) => {
    const username = req.query.username as string | undefined;
    const batches = await storage.getVoucherBatches(username);
    res.json({ count: batches.length, batches });
  });

  // ── GET /api/credit/vouchers/batches/:id ─────────────────────────────────
  app.get("/api/credit/vouchers/batches/:id", async (req, res) => {
    const batch = await storage.getVoucherBatch(req.params.id);
    if (!batch) return res.status(404).json({ error: "Voucher batch not found" });
    const vouchers = await storage.getVouchers(batch.id);
    res.json({ batch, vouchers });
  });

  // ── POST /api/credit/vouchers/batch ──────────────────────────────────────
  // Create a new voucher batch (admin — requires creator username)
  app.post("/api/credit/vouchers/batch", async (req, res) => {
    const schema = insertVoucherBatchSchema.extend({
      createdByUsername: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const result = await storage.createVoucherBatch(parsed.data);
      res.status(201).json({
        success: true,
        batch: result.batch,
        vouchers: result.vouchers,
        totalCreated: result.vouchers.length,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/credit/vouchers/redeem ─────────────────────────────────────
  // Redeem a voucher code
  app.post("/api/credit/vouchers/redeem", async (req, res) => {
    const schema = z.object({
      code: z.string().min(1),
      username: z.string().min(1),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    try {
      const voucher = await storage.redeemVoucher(parsed.data.code, parsed.data.username);
      const acct = await storage.getCreditAccount(parsed.data.username);
      res.json({
        success: true,
        voucher,
        rewardedAmount: voucher.amount,
        currency: voucher.currency,
        newBalance: acct.balance,
        formatted: `${acct.balance.toFixed(2)} ${acct.currency}`,
      });
    } catch (e: any) {
      const status = e.message === "Voucher not found" ? 404 : 400;
      res.status(status).json({ error: e.message });
    }
  });

  // ── POST /api/credit/vouchers/:id/cancel ─────────────────────────────────
  app.post("/api/credit/vouchers/:id/cancel", async (req, res) => {
    const voucher = await storage.cancelVoucher(req.params.id);
    if (!voucher) return res.status(404).json({ error: "Voucher not found or not active" });
    res.json({ success: true, voucher });
  });

  // ── GET /api/credit/rewards ───────────────────────────────────────────────
  // List active reward programs
  app.get("/api/credit/rewards", async (_req, res) => {
    const programs = await storage.getRewardPrograms();
    const categoryNames: Record<number, string> = {
      1: "Referral", 2: "Activity", 3: "Purchase", 4: "Engagement", 5: "First Time",
    };
    const typeNames: Record<number, string> = {
      1: "Quantity Based", 2: "Amount Based", 3: "One Time",
    };
    res.json({
      count: programs.length,
      programs: programs.map((p) => ({
        ...p,
        typeName: typeNames[p.type] ?? `Type ${p.type}`,
        categoryName: categoryNames[p.category] ?? `Category ${p.category}`,
      })),
    });
  });

  // ── GET /api/credit/rewards/:id ───────────────────────────────────────────
  app.get("/api/credit/rewards/:id", async (req, res) => {
    const program = await storage.getRewardProgram(req.params.id);
    if (!program) return res.status(404).json({ error: "Reward program not found" });
    res.json(program);
  });

  // ── POST /api/credit/rewards ──────────────────────────────────────────────
  // Create a new reward program (admin)
  app.post("/api/credit/rewards", async (req, res) => {
    const parsed = insertRewardProgramSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });
    try {
      const program = await storage.createRewardProgram(parsed.data);
      res.status(201).json(program);
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── PATCH /api/credit/rewards/:id ─────────────────────────────────────────
  app.patch("/api/credit/rewards/:id", async (req, res) => {
    const program = await storage.updateRewardProgram(req.params.id, req.body);
    if (!program) return res.status(404).json({ error: "Reward program not found" });
    res.json(program);
  });

  // ── GET /api/credit/rewards/history ──────────────────────────────────────
  // Get reward history for a user
  app.get("/api/credit/rewards/history", async (req, res) => {
    const username = req.query.username as string;
    if (!username) return res.status(400).json({ error: "username query param required" });
    const history = await storage.getUserRewardHistory(username);
    res.json({ username, count: history.length, history });
  });

  // ── POST /api/credit/rewards/trigger ─────────────────────────────────────
  // Trigger a reward event for a user
  // rewardType: "MIG_CREDIT" | "SCORE" | "LEVEL"
  app.post("/api/credit/rewards/trigger", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      programId: z.string().optional(),
      rewardType: z.enum(["MIG_CREDIT", "SCORE", "LEVEL", "BADGE"]),
      migCreditAmount: z.number().positive().optional(),
      migCreditCurrency: z.string().optional().default("IDR"),
      scoreAmount: z.number().int().positive().optional(),
      levelAmount: z.number().int().positive().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, programId, rewardType, migCreditAmount, migCreditCurrency, scoreAmount, levelAmount } = parsed.data;

    let programName: string | undefined;
    if (programId) {
      const prog = await storage.getRewardProgram(programId);
      if (!prog) return res.status(404).json({ error: "Reward program not found" });
      programName = prog.name;
    }

    try {
      const reward = await storage.addUserReward({
        username,
        programId: programId ?? null,
        programName: programName ?? null,
        rewardType,
        migCreditAmount: migCreditAmount ?? null,
        migCreditCurrency: migCreditCurrency ?? null,
        scoreAmount: scoreAmount ?? null,
        levelAmount: levelAmount ?? null,
      });

      const acct = await storage.getCreditAccount(username);
      res.json({
        success: true,
        reward,
        newBalance: acct.balance,
        currency: acct.currency,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── POST /api/admin/credit/topup ─────────────────────────────────────────
  // Admin: Add credits directly to a user account
  // Body: { username, amount, currency?, description? }
  app.post("/api/admin/credit/topup", async (req, res) => {
    const schema = z.object({
      username:    z.string().min(1),
      amount:      z.number().positive("Amount must be positive"),
      currency:    z.string().optional(),
      description: z.string().optional().default("Admin top-up"),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, amount, currency, description } = parsed.data;
    try {
      const updated = await storage.adjustBalance(username, amount, currency);
      await storage.createCreditTransaction({
        username,
        type: CREDIT_TRANSACTION_TYPE.BONUS_CREDIT,
        reference: `TOPUP-${Date.now()}`,
        description,
        currency: updated.currency,
        amount,
        fundedAmount: amount,
        tax: 0,
        runningBalance: updated.balance,
      });
      res.json({
        success: true,
        username,
        added: amount,
        newBalance: updated.balance,
        currency: updated.currency,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  // ── GET /api/credit/transaction-types ────────────────────────────────────
  // List all available transaction types (reference)
  app.get("/api/credit/transaction-types", (_req, res) => {
    const types = Object.entries(CREDIT_TRANSACTION_TYPE).map(([name, value]) => ({ value, name }));
    res.json({ types });
  });

  // ── GET /api/credit/voucher-statuses ─────────────────────────────────────
  // List all voucher status codes (reference)
  app.get("/api/credit/voucher-statuses", (_req, res) => {
    const statuses = Object.entries(VOUCHER_STATUS).map(([name, value]) => ({ value, name }));
    res.json({ statuses });
  });
}
