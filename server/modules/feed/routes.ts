import type { Express, Request, Response } from "express";
import { requireVerified } from "../../middleware/accessControl";
import { storage } from "../../storage";
import { insertWallPostSchema, WALL_POST_STATUS } from "@shared/schema";
import { z } from "zod";

function normalizeDisplayPicture(url: string | null | undefined): string | null {
  if (!url) return null;
  if (/\/api\/imageserver\/image\/[^/]+$/.test(url)) return url + '/data';
  return url;
}

async function enrichPosts(posts: import('@shared/schema').WallPost[], origin?: string) {
  return Promise.all(posts.map(async (post) => {
    const author = await storage.getUserByUsername(post.authorUsername);
    const profile = author ? await storage.getUserProfile(author.id) : null;

    // Normalize imageUrl: ensure it's an absolute URL (mirrors Android ImageHandler)
    let imageUrl = post.imageUrl ?? null;
    if (imageUrl && !imageUrl.startsWith('http') && origin) {
      imageUrl = origin + imageUrl;
    }
    // Add /data suffix if the URL points to imageserver without it
    if (imageUrl && /\/api\/imageserver\/image\/[^/]+$/.test(imageUrl)) {
      imageUrl = imageUrl + '/data';
    }

    return {
      ...post,
      imageUrl,
      authorDisplayPicture: normalizeDisplayPicture(profile?.displayPicture),
    };
  }));
}

export function registerFeedRoutes(app: Express): void {
  app.get("/api/feed", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const origin = `${req.protocol}://${req.get('host')}`;
    const limit  = Math.min(parseInt(String(req.query.limit  ?? 15), 10) || 15, 50);
    const offset = parseInt(String(req.query.offset ?? 0),  10) || 0;
    const { posts, hasMore } = await storage.getFeedPosts(req.session.userId, limit, offset);
    return res.status(200).json({ posts: await enrichPosts(posts, origin), hasMore });
  });

  app.get("/api/feed/user/:userId", async (req: Request, res: Response) => {
    const origin = `${req.protocol}://${req.get('host')}`;
    const limit  = Math.min(parseInt(String(req.query.limit  ?? 15), 10) || 15, 50);
    const offset = parseInt(String(req.query.offset ?? 0),  10) || 0;
    const { posts, hasMore } = await storage.getWallPosts(req.params.userId, limit, offset);
    return res.status(200).json({ posts: await enrichPosts(posts, origin), hasMore });
  });

  // AccessControl: CREATE_USER_POST_IN_GROUPS (emailVerified required)
  app.post("/api/feed/post", requireVerified("CREATE_USER_POST_IN_GROUPS"), async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });

    const { comment, type, targetUserId, imageUrl, repostId } = req.body;
    if ((!comment || comment.trim() === "") && !imageUrl && !repostId) {
      return res.status(400).json({ message: "Komentar tidak boleh kosong" });
    }

    let repostAuthorUsername: string | undefined;
    let repostComment: string | undefined;
    if (repostId) {
      const original = await storage.getWallPost(repostId);
      if (original) {
        repostAuthorUsername = original.authorUsername;
        repostComment = original.comment;
      }
    }

    const post = await storage.createWallPost({
      userId: targetUserId || req.session.userId,
      authorUserId: req.session.userId,
      authorUsername: user.username,
      comment: (comment || "").trim(),
      imageUrl: imageUrl || null,
      type: repostId ? 3 : (type || 1),
      repostId: repostId || null,
      repostAuthorUsername: repostAuthorUsername || null,
      repostComment: repostComment || null,
    });
    return res.status(201).json({ post });
  });

  app.post("/api/feed/post/:postId/like", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.likeWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    return res.status(200).json({ post });
  });

  app.post("/api/feed/post/:postId/dislike", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.dislikeWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    return res.status(200).json({ post });
  });

  app.delete("/api/feed/post/:postId", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const post = await storage.getWallPost(req.params.postId);
    if (!post) return res.status(404).json({ message: "Post tidak ditemukan" });
    if (post.authorUserId !== req.session.userId && post.userId !== req.session.userId) {
      return res.status(403).json({ message: "Tidak diizinkan menghapus post ini" });
    }
    await storage.removeWallPost(req.params.postId);
    return res.status(200).json({ message: "Post dihapus" });
  });

  app.get("/api/feed/post/:postId/comments", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const comments = await storage.getPostComments(req.params.postId);
    return res.status(200).json({ comments });
  });

  app.post("/api/feed/post/:postId/comment", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "Belum login" });
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User tidak valid" });
    const schema = z.object({ text: z.string().min(1) });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Teks komentar tidak boleh kosong" });
    const comment = await storage.createPostComment({
      postId: req.params.postId,
      authorUserId: req.session.userId,
      authorUsername: user.username,
      text: parsed.data.text.trim(),
    });
    return res.status(201).json({ comment });
  });
}
