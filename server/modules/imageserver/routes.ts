import type { Express } from "express";
import { z } from "zod";
import ImageKit from "imagekit";

const imagekit = new ImageKit({
  publicKey: process.env.IMAGEKIT_PUBLIC_KEY ?? "",
  privateKey: process.env.IMAGEKIT_PRIVATE_KEY ?? "",
  urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT ?? "",
});

// Mirrors com/projectgoth/fusion/imageserver/
// ImageServer.java: main image server
// ImageCache.java: caches image data (key, data, mimeType)
// ImageItem.java: image item with id, key, mimeType, size, content
// Connection.java: HTTP/S connection to image server
// ConnectionPurger.java: purges stale connections
// ImageServerAdminI.java: admin interface for purge, stats

export function registerImageServerRoutes(app: Express) {

  // ── POST /api/imageserver/upload ──────────────────────────────────────────────
  // Upload an image to ImageKit CDN (mirrors ImageServer store)
  // Body: { username, imageKey, mimeType, base64Data, description? }
  app.post("/api/imageserver/upload", async (req, res) => {
    const schema = z.object({
      username: z.string().min(1),
      imageKey: z.string().min(1),
      mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]).default("image/jpeg"),
      base64Data: z.string().min(1),
      description: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

    const { username, imageKey, mimeType, base64Data } = parsed.data;

    const sizeInBytes = Math.round(base64Data.length * 0.75);
    if (sizeInBytes > 10 * 1024 * 1024) {
      return res.status(413).json({ error: "Image too large. Max 10MB." });
    }

    const extMap: Record<string, string> = {
      "image/jpeg": "jpg",
      "image/png": "png",
      "image/gif": "gif",
      "image/webp": "webp",
    };
    const ext = extMap[mimeType] ?? "jpg";
    const folder = imageKey.startsWith("avatar_") ? "/migme/avatar" : "/migme/feed";
    const fileName = `${imageKey}.${ext}`;

    // Guard: reject early if credentials are not configured
    if (!process.env.IMAGEKIT_PUBLIC_KEY || !process.env.IMAGEKIT_PRIVATE_KEY || !process.env.IMAGEKIT_URL_ENDPOINT ||
        process.env.IMAGEKIT_PUBLIC_KEY.includes('xxxx') || process.env.IMAGEKIT_URL_ENDPOINT.includes('your_imagekit_id')) {
      return res.status(503).json({
        error: "ImageKit belum dikonfigurasi di server. Set environment variable IMAGEKIT_PUBLIC_KEY, IMAGEKIT_PRIVATE_KEY, dan IMAGEKIT_URL_ENDPOINT.",
      });
    }

    try {
      const result = await imagekit.upload({
        file: base64Data,
        fileName,
        folder,
        useUniqueFileName: true,
      });
      res.status(201).json({ success: true, imageId: result.fileId, imageKey: result.name, url: result.url });
    } catch (e: any) {
      console.error("[imageserver] ImageKit upload error:", e?.message ?? e);
      res.status(500).json({ error: e.message ?? "ImageKit upload failed" });
    }
  });

  // ── GET /api/imagekit/auth ────────────────────────────────────────────────────
  // Returns ImageKit authentication parameters for client-side use
  app.get("/api/imagekit/auth", (_req, res) => {
    try {
      const result = imagekit.getAuthenticationParameters();
      res.json({
        ...result,
        publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
        urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT,
      });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });
}
