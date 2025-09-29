// src/mailer.js
import nodemailer from "nodemailer";

/** בסיס לינקים במיילים (לינק איפוס) */
const BASE_URL = (process.env.APP_BASE_URL || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");

/** כתובת From: עדיף "BreaksTable <your@gmail.com>" או אליאס מאומת בג'ימייל */
const FROM = process.env.MAIL_FROM || process.env.SMTP_FROM || process.env.SMTP_USER;

/** הגדרות SMTP (ברירת מחדל חכמה ל-Gmail) */
const SMTP_USER = process.env.SMTP_USER; // חייב להיות your@gmail.com שלנו
const SMTP_PASS = process.env.SMTP_PASS; // App Password בן 16 תווים
const SMTP_HOST = process.env.SMTP_HOST || (SMTP_USER?.includes("@gmail.com") ? "smtp.gmail.com" : undefined);
const SMTP_PORT = Number(process.env.SMTP_PORT || (SMTP_HOST === "smtp.gmail.com" ? 465 : 587));
const SMTP_SECURE = (process.env.SMTP_SECURE ? process.env.SMTP_SECURE === "1" : SMTP_PORT === 465);

/** בדיקות קונפיג */
function assertConfig() {
  const missing = [];
  if (!SMTP_USER) missing.push("SMTP_USER");
  if (!SMTP_PASS) missing.push("SMTP_PASS");
  if (!SMTP_HOST) missing.push("SMTP_HOST");
  if (missing.length) {
    const msg = `[MAIL] חסרים משתני סביבה: ${missing.join(", ")}. עבור Gmail יש לקבוע:
      SMTP_USER=your@gmail.com
      SMTP_PASS=<App Password>
      (אופציונלי אבל מומלץ) SMTP_HOST=smtp.gmail.com
      SMTP_PORT=465
      SMTP_SECURE=1
      MAIL_FROM="BreaksTable <your@gmail.com>"`;
    console.warn(msg);
    throw new Error("SMTP configuration missing");
  }
}
assertConfig();

/** יצירת טרנספורטר */
const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_SECURE, // 465=true (TLS), 587=false (STARTTLS)
  auth: { user: SMTP_USER, pass: SMTP_PASS },
});

// בדיקת חיבור בעת עליית השרת (לא מפיל את האפליקציה)
transporter.verify().then(() => {
  console.log(`[MAIL] SMTP ready (${SMTP_HOST}:${SMTP_PORT}, secure=${SMTP_SECURE})`);
}).catch(err => {
  console.warn("[MAIL] transporter.verify failed:", err?.message || err);
});

/** שליחה כללית */
async function sendMail(to, subject, html, text) {
  if (!to) throw new Error("Missing recipient");
  const info = await transporter.sendMail({
    from: FROM,
    to,
    subject,
    text: text || html?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(),
    html,
  });
  console.log("[MAIL] sent:", subject, "->", to, "id:", info.messageId);
  return info;
}

/** מייל איפוס סיסמה */
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

/** מייל Welcome (רשות) */
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
