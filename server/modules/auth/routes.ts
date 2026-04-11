import type { Express, Request, Response } from "express";
import { storage } from "../../storage";
import { loginSchema, insertUserSchema } from "@shared/schema";
import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import { sendVerificationEmail } from "../../email";
import { createTcpToken } from "../../gateway/tcpTokens";
import { signJwt } from "../../middleware/jwtAuth";
import {
  trackFailedAuth,
  getFailedAuthCount,
  resetFailedAuth,
  cacheUserHash,
  getUserHash,
  FIELD,
} from "../../redis";

const scryptAsync = promisify(scrypt);

// Max failed login attempts before temporary block (matches backend app settings)
const MAX_FAILED_ATTEMPTS = 10;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  return `${buf.toString("hex")}.${salt}`;
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  const [hashed, salt] = hash.split(".");
  if (!hashed || !salt) return false;
  const buf = (await scryptAsync(password, salt, 64)) as Buffer;
  const hashedBuf = Buffer.from(hashed, "hex");
  if (buf.length !== hashedBuf.length) return false;
  return timingSafeEqual(buf, hashedBuf);
}

function getBaseUrl(req: Request): string {
  const proto = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${proto}://${host}`;
}

function getClientIp(req: Request): string {
  return (
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}

// Maps country code to the credit currency used in that country.
// Indonesia uses IDR; all others use USD.
function currencyForCountryCode(countryCode: string | null): string {
  if (!countryCode) return "USD";
  if (countryCode.toUpperCase() === "ID") return "IDR";
  return "USD";
}

// Formats a credit balance for display, based on currency.
// IDR → Indonesian Rupiah format (IDR 5.000)
// USD → US Dollar format (USD 5.00)
export function formatCreditBalance(balance: number, currency: string): string {
  if (currency === "IDR") return `IDR ${Math.round(balance).toLocaleString("id-ID")}`;
  if (currency === "USD") return `USD ${balance.toFixed(2)}`;
  return `IDR ${Math.round(balance).toLocaleString("id-ID")}`;
}

interface CountryInfo {
  country: string;
  countryCode: string;
}

// Mirrors Android's onLocationCountryReceived — resolves country + country code from client IP.
// Uses ip-api.com free tier (no API key needed, max 45 req/min).
async function detectCountryFromIp(ip: string): Promise<CountryInfo | null> {
  if (!ip || ip === "unknown" || ip === "::1" || ip.startsWith("127.") || ip.startsWith("10.") || ip.startsWith("192.168.")) {
    return null;
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const resp = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode`, {
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json() as { status: string; country?: string; countryCode?: string };
    if (data.status === "success" && data.country && data.countryCode) {
      return { country: data.country, countryCode: data.countryCode };
    }
  } catch {
    // Network error or timeout — silently ignore, same as Android's error handler
  }
  return null;
}

// ── GET /verify-email ──────────────────────────────────────────────────────
// Browser landing page for email verification links.
// Mirrors Android SignupEmailResult*Fragment states:
//   TOKEN_SUCCESS, TOKEN_EXPIRED, TOKEN_INVALID/TOKEN_USED, already-verified.
function verifyEmailPage(state: 'verifying' | 'success' | 'expired' | 'used' | 'error', message = ''): string {
  const icons: Record<string, string> = {
    verifying: '⏳',
    success:   '✅',
    expired:   '⏰',
    used:      'ℹ️',
    error:     '❌',
  };
  const colors: Record<string, string> = {
    verifying: '#64B9A0',
    success:   '#27AE60',
    expired:   '#E67E22',
    used:      '#2980B9',
    error:     '#E53935',
  };
  const titles: Record<string, string> = {
    verifying: 'Memverifikasi...',
    success:   'Email Terverifikasi!',
    expired:   'Link Kadaluarsa',
    used:      'Sudah Diverifikasi',
    error:     'Verifikasi Gagal',
  };
  const messages: Record<string, string> = {
    verifying: 'Harap tunggu, kami sedang memverifikasi akun kamu...',
    success:   'Akun kamu berhasil diverifikasi. Silakan login di aplikasi.',
    expired:   'Link verifikasi sudah kadaluarsa. Silakan daftar ulang.',
    used:      'Email kamu sudah diverifikasi sebelumnya. Silakan login.',
    error:     message || 'Token tidak valid atau sudah digunakan.',
  };
  const showLogin = state === 'success' || state === 'used';
  const showRegister = state === 'expired';
  const icon = icons[state];
  const color = colors[state];
  const title = titles[state];
  const msg = messages[state];

  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Verifikasi Email — Mig33Reborn</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{min-height:100vh;display:flex;align-items:center;justify-content:center;background:#09454A;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;padding:20px}
    .card{background:#fff;border-radius:20px;padding:40px 32px;max-width:420px;width:100%;text-align:center;box-shadow:0 20px 60px rgba(0,0,0,0.3)}
    .logo{width:72px;height:72px;border-radius:36px;background:#09454A;display:flex;align-items:center;justify-content:center;margin:0 auto 24px;font-size:28px;font-weight:900;color:#fff;letter-spacing:-1px}
    .brand{font-size:13px;color:#64B9A0;font-weight:600;letter-spacing:2px;text-transform:uppercase;margin-bottom:28px}
    .icon-wrap{font-size:56px;margin-bottom:20px;display:block}
    .state-bar{height:4px;border-radius:2px;background:${color};margin-bottom:28px;width:60px;margin-left:auto;margin-right:auto}
    h1{font-size:22px;font-weight:800;color:#09454A;margin-bottom:12px}
    p{font-size:15px;color:#546E7A;line-height:1.6;margin-bottom:28px}
    .btn{display:inline-block;background:#64B9A0;color:#fff;text-decoration:none;padding:14px 32px;border-radius:12px;font-size:16px;font-weight:700;border:none;cursor:pointer;width:100%;margin-bottom:10px}
    .btn:hover{background:#4a9480}
    .btn-outline{background:transparent;border:2px solid #64B9A0;color:#64B9A0}
    .btn-outline:hover{background:#64B9A0;color:#fff}
    .spinner{width:48px;height:48px;border:4px solid #E0F2EF;border-top:4px solid #64B9A0;border-radius:50%;animation:spin 0.8s linear infinite;margin:8px auto 20px}
    @keyframes spin{to{transform:rotate(360deg)}}
    .footer{margin-top:24px;font-size:12px;color:#90A4AE}
  </style>
  ${state === 'verifying' ? `<script>
    window.addEventListener('DOMContentLoaded', function() {
      var token = new URLSearchParams(window.location.search).get('token');
      if (!token) { location.href = location.pathname + '?error=missing'; return; }
      fetch('/api/auth/verify-email?token=' + encodeURIComponent(token))
        .then(function(r){ return r.json().then(function(d){ return {ok:r.ok, status:r.status, data:d}; }); })
        .then(function(result) {
          var s = result.status;
          if (result.ok || result.data.alreadyVerified) {
            var key = result.data.alreadyVerified ? 'used' : 'success';
            location.href = location.pathname + '?state=' + key;
          } else if (s === 410) {
            location.href = location.pathname + '?state=expired';
          } else if (s === 404) {
            location.href = location.pathname + '?state=error&msg=' + encodeURIComponent(result.data.message || '');
          } else {
            location.href = location.pathname + '?state=error&msg=' + encodeURIComponent(result.data.message || '');
          }
        })
        .catch(function() { location.href = location.pathname + '?state=error'; });
    });
  </script>` : ''}
</head>
<body>
  <div class="card">
    <div class="logo">M</div>
    <div class="brand">Mig33Reborn</div>

    ${state === 'verifying' ? `
      <div class="spinner"></div>
      <div class="state-bar"></div>
      <h1>Memverifikasi Email</h1>
      <p>Harap tunggu, kami sedang memverifikasi akun kamu...</p>
    ` : `
      <span class="icon-wrap">${icon}</span>
      <div class="state-bar" style="background:${color}"></div>
      <h1>${title}</h1>
      <p>${msg}</p>
      ${showLogin ? `<a class="btn" href="/">Buka Aplikasi</a>` : ''}
      ${showRegister ? `<a class="btn btn-outline" href="/">Daftar Ulang</a>` : ''}
      ${!showLogin && !showRegister ? `<a class="btn" href="/">Kembali ke Beranda</a>` : ''}
    `}

    <div class="footer">© 2024 Mig33Reborn · mig33reborn.com</div>
  </div>
</body>
</html>`;
}

export function registerAuthRoutes(app: Express): void {
  // ── Browser email verification landing page ──
  // Called when user clicks the verification link in their email.
  // Mirrors the Android SignupEmailResult*Fragment flow.
  app.get("/verify-email", (req: Request, res: Response) => {
    const state = req.query.state as string | undefined;
    const msg   = req.query.msg as string | undefined;

    // If ?state= is set it means we already completed the API call (client-side redirect)
    if (state === 'success') return res.send(verifyEmailPage('success'));
    if (state === 'expired') return res.send(verifyEmailPage('expired'));
    if (state === 'used')    return res.send(verifyEmailPage('used'));
    if (state === 'error')   return res.send(verifyEmailPage('error', msg));

    // First load with ?token= → show the verifying spinner and kick off the API call via JS
    return res.send(verifyEmailPage('verifying'));
  });

  app.post("/api/auth/register", async (req: Request, res: Response) => {
    const parsed = insertUserSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid data", errors: parsed.error.flatten() });
    }
    const { username, email, password, displayName } = parsed.data;

    const existingUsername = await storage.getUserByUsername(username);
    if (existingUsername) return res.status(409).json({ message: "Username already in use" });

    const existingEmail = await storage.getUserByEmail(email);
    if (existingEmail) return res.status(409).json({ message: "Email is already registered" });

    const hashedPassword = await hashPassword(password);
    const verifyToken = randomBytes(32).toString("hex");
    const verifyTokenExpiry = new Date(Date.now() + 60 * 60 * 1000);

    const user = await storage.createUser({
      username,
      displayName: displayName || username,
      email,
      password: hashedPassword,
      verifyToken,
      verifyTokenExpiry,
    });

    // Detect country from IP before awarding welcome credits so we can pick the right currency.
    // Mirrors Android createNewUser() + onLocationCountryReceived flow.
    // We wait up to 2 s; if detection fails we fall back to MIG.
    const clientIp = getClientIp(req);
    let countryInfo: { country: string; countryCode: string } | null = null;
    try {
      countryInfo = await Promise.race([
        detectCountryFromIp(clientIp),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
      ]);
    } catch {
      // silently ignore
    }

    const creditCurrency = currencyForCountryCode(countryInfo?.countryCode ?? null);

    // Welcome bonus: 500 credits for every new user, in the local currency
    // IDR for Indonesian users, MIG for everyone else
    const welcomeAcct = await storage.adjustBalance(username, 500, creditCurrency);
    await storage.createCreditTransaction({
      username,
      currency: creditCurrency,
      amount: 500,
      fundedAmount: 500,
      tax: 0,
      runningBalance: welcomeAcct.balance,
      description: "Welcome bonus",
      type: 9, // BONUS_CREDIT — AccountEntryData.TypeEnum.BONUS_CREDIT
      reference: null,
    });

    // Save detected country to profile asynchronously
    if (countryInfo) {
      storage.upsertUserProfile(user.id, { userId: user.id, country: countryInfo.country }).catch((e) => {
        console.error("[Register] Country profile save error:", e);
      });
    }

    const verifyUrl = `${getBaseUrl(req)}/verify-email?token=${verifyToken}`;
    try {
      await sendVerificationEmail(email, displayName || username, verifyUrl);
    } catch (e) {
      console.error("[Register] Email send error:", e);
    }

    return res.status(201).json({
      message: "Your account has been created. Please check your email to verify it.",
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
    });
  });

  app.get("/api/auth/verify-email", async (req: Request, res: Response) => {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ message: "Invalid authentication token" });

    const user = await storage.getUserByVerifyToken(token);
    if (!user) return res.status(404).json({ message: "Token tidak ditemukan atau sudah digunakan" });

    if (user.emailVerified) {
      return res.status(200).json({ message: "Email sudah terverifikasi sebelumnya", alreadyVerified: true });
    }

    if (user.verifyTokenExpiry && user.verifyTokenExpiry < new Date()) {
      return res.status(410).json({ message: "Link verifikasi sudah kadaluarsa. Silakan daftar ulang." });
    }

    await storage.updateUser(user.id, { emailVerified: true, verifyToken: null, verifyTokenExpiry: null });
    return res.status(200).json({ message: "Email berhasil diverifikasi! Silakan login." });
  });

  // Login with Redis-backed failed auth tracking (DecayingFailedAuthsByIPScore equivalent)
  app.post("/api/auth/login", async (req: Request, res: Response) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ message: "Data tidak valid" });

    const clientIp = getClientIp(req);
    const failedCount = await getFailedAuthCount(clientIp);

    // Block IP if exceeded max attempts (matches FAILED_AUTHS_PER_IP gate in backend)
    if (failedCount >= MAX_FAILED_ATTEMPTS) {
      return res.status(429).json({
        message: "Too many login attempts. Please try again in a few minutes.",
        retryAfter: 900,
      });
    }

    const { username, password } = parsed.data;
    const user = await storage.getUserByUsername(username);

    if (!user) {
      await trackFailedAuth(clientIp);
      return res.status(401).json({ message: "Invalid username or password." });
    }

    const valid = await verifyPassword(password, user.password);
    if (!valid) {
      await trackFailedAuth(clientIp);
      return res.status(401).json({ message: "The username or password is incorrect." });
    }

    if (!user.emailVerified) {
      return res.status(403).json({ message: "Please verify your account. Check your email" });
    }

    // Login success — reset failed count and cache user profile
    await resetFailedAuth(clientIp);

    const profile = await storage.getUserProfile(user.id);
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]:     user.username,
      [FIELD.DISPLAY_NAME]: user.displayName ?? user.username,
      [FIELD.MIG_LEVEL]:    String(profile?.migLevel ?? 1),
      [FIELD.STATUS]:       "online",
    });

    req.session.userId = user.id;
    const tcpToken = createTcpToken(user.id, user.username);
    const authToken = signJwt({ userId: user.id, username: user.username });
    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
      tcpToken,
      authToken,
    });
  });

  app.get("/api/auth/me", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });

    // Try Redis cache first (User:{id} hash)
    const cached = await getUserHash(req.session.userId);
    if (cached && cached[FIELD.USERNAME]) {
      return res.status(200).json({
        user: {
          id:          req.session.userId,
          username:    cached[FIELD.USERNAME],
          displayName: cached[FIELD.DISPLAY_NAME] || cached[FIELD.USERNAME],
        },
        fromCache: true,
      });
    }

    const user = await storage.getUser(req.session.userId);
    if (!user) {
      req.session.destroy(() => {});
      return res.status(401).json({ message: "Invalid session" });
    }

    // Populate cache for next time
    await cacheUserHash(user.id, {
      [FIELD.USERNAME]:     user.username,
      [FIELD.DISPLAY_NAME]: user.displayName ?? user.username,
      [FIELD.STATUS]:       "online",
    });

    return res.status(200).json({
      user: { id: user.id, username: user.username, displayName: user.displayName, email: user.email },
    });
  });

  app.post("/api/auth/logout", (req: Request, res: Response) => {
    req.session.destroy(() => {
      res.clearCookie("connect.sid");
      return res.status(200).json({ message: "You have been logged out" });
    });
  });

  app.post("/api/auth/change-password", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) {
      return res.status(400).json({ message: "Both old and new passwords must be filled in" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });

    const valid = await verifyPassword(currentPassword, user.password);
    if (!valid) return res.status(401).json({ message: "The old password is incorrect" });

    const hashed = await hashPassword(newPassword);
    await storage.updateUser(user.id, { password: hashed });
    return res.status(200).json({ message: "Your password has been successfully updated" });
  });

  app.post("/api/auth/change-email", async (req: Request, res: Response) => {
    if (!req.session.userId) return res.status(401).json({ message: "You are not logged in" });
    const { newEmail } = req.body;
    if (!newEmail || !newEmail.includes("@")) {
      return res.status(400).json({ message: "Please enter a valid email address" });
    }
    const user = await storage.getUser(req.session.userId);
    if (!user) return res.status(401).json({ message: "User not found" });

    await storage.updateUser(user.id, { email: newEmail });
    return res.status(200).json({ message: "Email address has been successfully updated" });
  });
}
