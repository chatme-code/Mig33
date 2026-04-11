import type { Express, Request, Response } from "express";
import { z } from "zod";
import { storage } from "../../storage";
import { CREDIT_TRANSACTION_TYPE } from "@shared/schema";

// Mirrors com/projectgoth/fusion/restapi/resource/StoreResource.java:
//   purchaseFusionSession()    → POST /store/item/{id}/purchase
//   getStoreItemCategory()     → GET /store/category/{id}/items
//   getStoreItemType()         → GET /store/type/{id}/items
//   getStoreItem()             → GET /store/item/{id}
//   getStoreCategories()       → GET /store/categories/{id}
//   searchStoreItems()         → GET /store/search/items
//
// StoreItemData.TypeEnum: VIRTUAL_GIFT=1, AVATAR=2, STICKER/EMOTICON=3,4,5, THEME=6
// Purchase flow mirrors: ContentBean.buyVirtualGiftForMultipleUsers() for VIRTUAL_GIFT type
//                        ContentBean.buyEmoticonPack() for STICKER/EMOTICON type

export function registerStoreRoutes(app: Express): void {

  // ── GET /api/store/gifts ─────────────────────────────────────────────────
  // Mirrors: GiftStoreFragment.refreshData() → GET /store/type/1/items
  // Returns all virtual gifts (status=1), sorted by sortOrder
  app.get("/api/store/gifts", async (_req: Request, res: Response) => {
    try {
      const gifts = await storage.getVirtualGifts();
      return res.status(200).json({ gifts });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/store/stickers ──────────────────────────────────────────────
  // Mirrors: StickerStoreFragment → GET /store/type/3/items?forSale=true
  // Returns sticker packs where forSale=1, status=0 (active)
  app.get("/api/store/stickers", async (_req: Request, res: Response) => {
    try {
      const packs = await storage.getEmoticonPacks(false);
      const forSale = packs.filter(p => p.forSale === 1 && p.status === 0);
      return res.status(200).json({ stickers: forSale });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/store/item/:id ──────────────────────────────────────────────
  // Mirrors: StoreResource.getStoreItem() → GET /store/item/{id}
  // Returns a single gift or sticker pack by ID and type
  // Query: ?type=gift|sticker
  app.get("/api/store/item/:id", async (req: Request, res: Response) => {
    const id = parseInt(req.params.id, 10);
    const type = (req.query.type as string) ?? "gift";
    if (isNaN(id)) return res.status(400).json({ message: "Invalid item ID" });
    try {
      if (type === "sticker") {
        const pack = await storage.getEmoticonPack(id);
        if (!pack) return res.status(404).json({ message: "Sticker pack not found" });
        return res.status(200).json({ item: pack, itemType: "sticker" });
      } else {
        const gifts = await storage.getVirtualGifts();
        const gift = gifts.find(g => g.id === id);
        if (!gift) return res.status(404).json({ message: "Gift not found" });
        return res.status(200).json({ item: gift, itemType: "gift" });
      }
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/store/search ────────────────────────────────────────────────
  // Mirrors: StoreResource.searchStoreItems() → GET /store/search/items?query=&type=&minPrice=&maxPrice=
  // Searches gifts and/or sticker packs by keyword and optional filters
  app.get("/api/store/search", async (req: Request, res: Response) => {
    const q = (req.query.q as string)?.trim();
    const type = req.query.type as string | undefined;
    const minPrice = parseFloat(req.query.minPrice as string) || 0;
    const maxPrice = parseFloat(req.query.maxPrice as string) || Infinity;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 50);

    if (!q || q.length < 2) {
      return res.status(400).json({ message: "Query pencarian minimal 2 karakter" });
    }

    try {
      const results: Record<string, unknown[]> = {};

      if (!type || type === "gift") {
        const gifts = await storage.searchVirtualGifts(q, limit);
        results.gifts = gifts.filter(g => g.price >= minPrice && g.price <= maxPrice);
      }

      if (!type || type === "sticker") {
        const packs = await storage.getEmoticonPacks(false);
        const ql = q.toLowerCase();
        results.stickers = packs.filter(p =>
          p.forSale === 1 &&
          (p.name.toLowerCase().includes(ql) || (p.description ?? "").toLowerCase().includes(ql)) &&
          p.price >= minPrice && p.price <= maxPrice
        ).slice(0, limit);
      }

      return res.status(200).json({ query: q, results });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── GET /api/store/categories ────────────────────────────────────────────
  // Mirrors: StoreResource.getStoreCategories() → GET /store/categories/{id}
  // Returns store categories (Gifts, Stickers, Avatars, Themes)
  // These map to StoreItemData.TypeEnum in Java
  app.get("/api/store/categories", async (_req: Request, res: Response) => {
    const STORE_CATEGORIES = [
      { id: 1, name: "Virtual Gifts", type: "gift",    icon: "gift-outline",   sortOrder: 1 },
      { id: 2, name: "Sticker Packs", type: "sticker", icon: "happy-outline",  sortOrder: 2 },
      { id: 3, name: "Avatars",       type: "avatar",  icon: "person-outline", sortOrder: 3 },
      { id: 4, name: "Themes",        type: "theme",   icon: "color-palette-outline", sortOrder: 4 },
    ];
    return res.status(200).json({ categories: STORE_CATEGORIES });
  });

  // ── POST /api/gifts/send ─────────────────────────────────────────────────
  // Records a gift sent from private/room chat directly into virtual_gifts_received.
  // Uses virtualGiftId=0 as a "chat gift" marker (no credit deduction).
  app.post("/api/gifts/send", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });

    const bodySchema = z.object({
      recipientUsername: z.string().min(1),
      giftName: z.string().min(1),
      giftEmoji: z.string().optional().default(""),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid" });
    const { recipientUsername, giftName, giftEmoji } = parsed.data;

    try {
      const me = await storage.getUser(req.session.userId);
      if (!me) return res.status(401).json({ message: "User tidak ditemukan" });

      await storage.createVirtualGiftReceived({
        username: recipientUsername,
        sender: me.username,
        virtualGiftId: 0,
        message: `${giftName} ${giftEmoji}`.trim(),
        isPrivate: 0,
      });

      return res.status(200).json({ success: true });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/store/purchase/gift/:id ────────────────────────────────────
  // Mirrors: StoreResource.purchase() → POST /store/item/{id}/purchase
  // Item type = VIRTUAL_GIFT → ContentBean.buyVirtualGiftForMultipleUsers()
  //   - Deducts MIG credits from sender (VIRTUAL_GIFT_PURCHASE transaction type)
  //   - Records in virtual_gifts_received for each recipient
  //   - Body: { recipientUsername?, message?, isPrivate? }
  app.post("/api/store/purchase/gift/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });

    const giftId = parseInt(req.params.id, 10);
    if (isNaN(giftId)) return res.status(400).json({ message: "Invalid gift ID" });

    const bodySchema = z.object({
      recipientUsername: z.string().optional(),
      message: z.string().max(200).optional(),
      isPrivate: z.boolean().optional().default(false),
    });
    const parsed = bodySchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Invalid request" });
    const { recipientUsername, message, isPrivate } = parsed.data;

    try {
      const me = await storage.getUser(req.session.userId);
      if (!me) return res.status(401).json({ message: "User not found" });

      const gifts = await storage.getVirtualGifts();
      const gift = gifts.find(g => g.id === giftId);
      if (!gift) return res.status(404).json({ message: "Gift not found" });

      const acct = await storage.getCreditAccount(me.username);
      if (acct.balance < gift.price) {
        return res.status(402).json({
          message: "Kredit tidak cukup",
          required: gift.price,
          balance: acct.balance,
        });
      }

      const updated = await storage.adjustBalance(me.username, -gift.price);

      // Mirrors: AccountEntryTypeEnum.VIRTUAL_GIFT_PURCHASE (41)
      await storage.createCreditTransaction({
        username: me.username,
        type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
        reference: `STORE-GIFT-${giftId}-${Date.now()}`,
        description: recipientUsername
          ? `Gift "${gift.name}" dikirim ke @${recipientUsername}`
          : `Beli gift: ${gift.name}`,
        currency: acct.currency,
        amount: -gift.price,
        fundedAmount: 0,
        tax: 0,
        runningBalance: updated.balance,
      });

      // Mirrors: ContentBean.buyVirtualGiftForMultipleUsers()
      // Records in virtual_gifts_received table
      const recipient = recipientUsername?.trim() || me.username;
      await storage.createVirtualGiftReceived({
        username: recipient,
        sender: me.username,
        virtualGiftId: giftId,
        message: message ?? null,
        isPrivate: isPrivate ? 1 : 0,
      });

      return res.status(200).json({
        success: true,
        gift,
        newBalance: updated.balance,
        recipient,
        message: recipientUsername
          ? `Gift "${gift.name}" berhasil dikirim ke @${recipientUsername}!`
          : `Gift "${gift.name}" berhasil dibeli!`,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });

  // ── POST /api/store/purchase/sticker/:id ─────────────────────────────────
  // Mirrors: StoreResource.purchase() → POST /store/item/{id}/purchase
  // Item type = EMOTICON/STICKER → ContentBean.buyEmoticonPack()
  app.post("/api/store/purchase/sticker/:id", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });

    const packId = parseInt(req.params.id, 10);
    if (isNaN(packId)) return res.status(400).json({ message: "Invalid pack ID" });

    try {
      const me = await storage.getUser(req.session.userId);
      if (!me) return res.status(401).json({ message: "User not found" });

      const pack = await storage.getEmoticonPack(packId);
      if (!pack) return res.status(404).json({ message: "Sticker pack not found" });
      if (pack.forSale !== 1) return res.status(400).json({ message: "Pack ini tidak dijual" });

      if (pack.price <= 0) {
        return res.status(200).json({
          success: true,
          pack,
          newBalance: (await storage.getCreditAccount(me.username)).balance,
          message: `Pack "${pack.name}" berhasil didapatkan!`,
        });
      }

      const acct = await storage.getCreditAccount(me.username);
      if (acct.balance < pack.price) {
        return res.status(402).json({
          message: "Kredit tidak cukup",
          required: pack.price,
          balance: acct.balance,
        });
      }

      const updated = await storage.adjustBalance(me.username, -pack.price);

      // Mirrors: AccountEntryTypeEnum.EMOTICON_PACK_PURCHASE (type for stickers)
      await storage.createCreditTransaction({
        username: me.username,
        type: CREDIT_TRANSACTION_TYPE.VIRTUAL_GIFT_PURCHASE,
        reference: `STORE-STICKER-${packId}-${Date.now()}`,
        description: `Beli sticker pack: ${pack.name}`,
        currency: acct.currency,
        amount: -pack.price,
        fundedAmount: 0,
        tax: 0,
        runningBalance: updated.balance,
      });

      return res.status(200).json({
        success: true,
        pack,
        newBalance: updated.balance,
        message: `Pack "${pack.name}" berhasil dibeli!`,
      });
    } catch (e: any) {
      return res.status(500).json({ message: e.message });
    }
  });
}
