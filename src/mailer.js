// src/mailer.js
import nodemailer from "nodemailer";

const BASE_URL = (process.env.APP_BASE_URL || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
const FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;

// === SMTP config (מוכן ל-Gmail) ===
const SMTP_USER   = process.env.SMTP_USER;               // your@gmail.com
const SMTP_PASS   = process.env.SMTP_PASS;               // App Password
const ENV_HOST    = process.env.SMTP_HOST;
const ENV_PORT    = process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined;
const ENV_SECURE  = process.env.SMTP_SECURE === "1" || (process.env.SMTP_SECURE === "true");
const DEFAULT_HOST = SMTP_USER?.includes("@gmail.com") ? "smtp.gmail.com" : (ENV_HOST || "smtp.gmail.com");

// פרופיל ראשי: 465/TLS אם לא הוגדר אחרת
const PRIMARY = {
  host: ENV_HOST || DEFAULT_HOST,
  port: ENV_PORT ?? (DEFAULT_HOST === "smtp.gmail.com" ? 465 : 587),
  secure: ENV_PORT ? (ENV_PORT === 465) : (DEFAULT_HOST === "smtp.gmail.com"),
};

// פרופיל fallback: 587/STARTTLS
const FALLBACK = {
  host: ENV_HOST || DEFAULT_HOST,
  port: 587,
  secure: false,
  requireTLS: true,
};

// איחוד פרמטרים משותפים
function transportOptions(base) {
  return {
    ...base,
    secure: base.secure,
    requireTLS: base.requireTLS ?? false,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    // טיימאאוטים קצרים כדי לא להיתקע 2 דקות
    connectionTimeout: 15000,
    greetingTimeout: 10000,
    socketTimeout: 20000,
    // לוג בסיסי
    logger: true,
    // לעתים IPv6 ב-PaaS חסום → עדיף IPv4 תחילה (ראה גם NODE_OPTIONS למטה)
    tls: {
      minVersion: "TLSv1.2",
      // servername לסניקי TLS נכון מאחורי פרוקסים
      servername: (ENV_HOST || DEFAULT_HOST),
    },
  };
}

function missing(...vars) {
  return vars.filter(Boolean).length === 0;
}

if (missing(SMTP_USER, SMTP_PASS)) {
  console.warn("[MAIL] חסרים SMTP_USER/SMTP_PASS. ודא שהגדרת App Password של Gmail.");
}

let transporter = null;

/** יוצר טרנספורטר עם fallback אוטומטי ל-587 אם 465 נכשל (או להפך אם ביקשת 587 במפורש) */
async function buildTransport() {
  // אם המשתמש הכריח secure באמצעות SMTP_SECURE – כבדו זאת
  if (process.env.SMTP_SECURE) {
    PRIMARY.secure = ENV_SECURE;
  }
  if (ENV_PORT != null) {
    PRIMARY.port = ENV_PORT;
    if (process.env.SMTP_SECURE == null) {
      // אם המשתמש נתן פורט בלי SECURE, נסיק לפי הפורט
      PRIMARY.secure = ENV_PORT === 465;
    }
  }

  // ניסיון ראשון
  let t = nodemailer.createTransport(transportOptions(PRIMARY));
  try {
    await t.verify();
    console.log(`[MAIL] SMTP ready on ${PRIMARY.host}:${PRIMARY.port} (secure=${PRIMARY.secure})`);
    return t;
  } catch (e) {
    console.warn(`[MAIL] primary transport failed:`, e?.code || e?.message || e);
  }

  // ניסיון שני (fallback)
  const fb = nodemailer.createTransport(transportOptions(FALLBACK));
  try {
    await fb.verify();
    console.log(`[MAIL] SMTP fallback ready on ${FALLBACK.host}:${FALLBACK.port} (secure=${FALLBACK.secure})`);
    return fb;
  } catch (e) {
    console.error(`[MAIL] fallback transport failed:`, e?.code || e?.message || e);
    throw e;
  }
}

// נבנה את הטרנספורטר בעת טעינת המודול
transporter = await buildTransport().catch((e) => {
  console.error("[MAIL] SMTP init failed:", e?.message || e);
  // נשאיר transporter=null ונזרוק בשעת שליחה
  return null;
});

async function sendMail(to, subject, html, text) {
  if (!to) throw new Error("Missing recipient");
  if (!transporter) {
    // נסה להיבנות מחדש (למקרה שבוט אסינכרוני נכשל קודם)
    transporter = await buildTransport();
  }

  try {
    const info = await transporter.sendMail({
      from: FROM,
      to,
      subject,
      text: text || html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
      html,
    });
    console.log("[MAIL] sent:", subject, "->", to, "id:", info.messageId);
    return info;
  } catch (err) {
    // אם נכשל בטיימאאוט/קונקשן — נסה פרופיל חלופי חד־פעמי
    const transient = ["ETIMEDOUT", "ECONNECTION", "ECONNRESET", "EAI_AGAIN", "ENOTFOUND"];
    if (transient.includes(err?.code)) {
      console.warn("[MAIL] transient error, retrying with opposite profile…", err?.code);
      const retryProfile = (transporter.options.port === 465) ? transportOptions(FALLBACK) : transportOptions(PRIMARY);
      const tmp = nodemailer.createTransport(retryProfile);
      const info = await tmp.sendMail({
        from: FROM, to, subject,
        text: text || html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
        html,
      });
      console.log("[MAIL] sent (retry):", subject, "->", to, "id:", info.messageId);
      return info;
    }
    throw err;
  }
}

export async function sendPasswordReset(to, token) {
  const url = `${BASE_URL}/reset/${token}`;
  const subject = "איפוס סיסמה";
  const text = `שלום,\n\nלהגדרת סיסמה חדשה כנס/י לקישור:\n${url}\n\nהקישור תקף לשעה.`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
      <p>שלום,</p>
      <p>להגדרת סיסמה חדשה לחצו על הקישור:</p>
      <p><a href="${url}">${url}</a></p>
      <p style="color:#6b7280">הקישור תקף לשעה.</p>
    </div>
  `;
  return sendMail(to, subject, html, text);
}

export async function sendWelcome(to, firstName = "", lastName = "") {
  const subject = "ברוך/ה הבא/ה!";
  const text = `שלום ${firstName} ${lastName},\n\nההרשמה הושלמה בהצלחה. שמחים שהצטרפת!`;
  const html = `
    <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial">
      <p>שלום ${firstName} ${lastName},</p>
      <p>ההרשמה הושלמה בהצלחה. שמחים שהצטרפת!</p>
    </div>
  `;
  return sendMail(to, subject, html, text);
}
