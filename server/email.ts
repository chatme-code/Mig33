const SENDER_EMAIL = "noreply@migxchat.net";
const SENDER_NAME = "Migchat";
const BREVO_API_URL = "https://api.brevo.com/v3/smtp/email";

export async function sendVerificationEmail(
  toEmail: string,
  toName: string,
  verifyUrl: string
): Promise<void> {
  if (!process.env.BREVO_API_KEY) {
    console.warn("[Email] BREVO_API_KEY not set. Skipping email send.");
    console.log(`[Email] Verification URL for ${toEmail}: ${verifyUrl}`);
    return;
  }

  const payload = {
    sender: { name: SENDER_NAME, email: SENDER_EMAIL },
    to: [{ email: toEmail, name: toName }],
    subject: "Verifikasi Akun Migchat Kamu",
    htmlContent: `
<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Verifikasi Akun Mig33Reborn</title>
</head>
<body style="margin:0;padding:0;background:#09454A;font-family:Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#09454A;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.3);">
          <tr>
            <td style="background:#09454A;padding:32px;text-align:center;">
              <div style="width:64px;height:64px;background:#64B9A0;border-radius:32px;display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;">
                <span style="color:#fff;font-size:26px;font-weight:900;line-height:64px;display:block;">M</span>
              </div>
              <h1 style="color:#fff;margin:0;font-size:26px;font-weight:800;letter-spacing:-0.5px;">Mig33Reborn</h1>
              <p style="color:#64B9A0;margin:6px 0 0;font-size:13px;letter-spacing:2px;text-transform:uppercase;">Chat Platform</p>
            </td>
          </tr>
          <tr>
            <td style="padding:36px 40px;">
              <h2 style="color:#09454A;margin:0 0 12px;font-size:20px;font-weight:800;">Halo, ${toName}! 👋</h2>
              <p style="color:#546E7A;font-size:15px;line-height:1.6;margin:0 0 24px;">
                Terima kasih sudah mendaftar di <strong style="color:#09454A;">Mig33Reborn</strong>.
                Untuk mengaktifkan akun kamu, klik tombol verifikasi di bawah ini.
              </p>
              <div style="text-align:center;margin:32px 0;">
                <a href="${verifyUrl}"
                   style="background:#64B9A0;color:#fff;text-decoration:none;padding:14px 36px;border-radius:12px;font-size:16px;font-weight:700;display:inline-block;">
                  ✅ Verifikasi Akun
                </a>
              </div>
              <p style="color:#90A4AE;font-size:13px;line-height:1.6;margin:0 0 8px;">
                Link ini berlaku selama <strong style="color:#546E7A;">1 jam</strong>.
                Jika kamu tidak mendaftar di Migchat, abaikan email ini.
              </p>
              <p style="color:#B0BEC5;font-size:12px;margin:16px 0 0;word-break:break-all;">
                Atau copy link: <a href="${verifyUrl}" style="color:#64B9A0;">${verifyUrl}</a>
              </p>
            </td>
          </tr>
          <tr>
            <td style="background:#F5F5F5;padding:20px 40px;text-align:center;border-top:1px solid #E0E0E0;">
              <p style="color:#90A4AE;font-size:12px;margin:0;">
                © 2024 Mig33Reborn · noreply@migxchat.net
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
    `,
  };

  const response = await fetch(BREVO_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": process.env.BREVO_API_KEY,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Brevo API error ${response.status}: ${errorText}`);
  }

  console.log(`[Email] Verification email sent to ${toEmail}`);
}
