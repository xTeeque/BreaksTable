// src/mailer.js
import nodemailer from "nodemailer";

const BASE_URL = process.env.BASE_URL || "http://localhost:3000";
const FROM = process.env.MAIL_FROM || process.env.SMTP_USER;

const SMTP_HOST = process.env.SMTP_HOST;
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER;
const SMTP_PASS = process.env.SMTP_PASS;

if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
  console.warn("[MAIL] SMTP not fully configured (SMTP_HOST/USER/PASS). Emails will fail.");
}

const transporter = nodemailer.createTransport({
  host: SMTP_HOST,
  port: SMTP_PORT,
  secure: SMTP_PORT === 465, // true ל-TLS מלא (465), false ל-STARTTLS (587)
  auth: { user: SMTP_USER, pass: SMTP_PASS }
});

// פונקציה כללית לשליחה
async function sendMail(to, subject, html) {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    throw new Error("SMTP configuration missing");
  }
  const info = await transporter.sendMail({ from: FROM, to, subject, html });
  console.log("[MAIL] sent:", subject, "->", to, "id:", info.messageId);
  return info;
}

export async function sendPasswordReset(to, token) {
  const url = `${BASE_URL}/reset/${token}`;
  const html = `
    <p>שלום,</p>
    <p>התקבלה בקשה לאיפוס הסיסמה שלך.</p>
    <p><a href="${url}">${url}</a></p>
    <p>אם לא ביקשת זאת, אפשר להתעלם מהודעה זו.</p>
  `;
  return sendMail(to, "איפוס סיסמה", html);
}

export async function sendWelcome(to, firstName, lastName) {
  const html = `
    <p>שלום ${firstName} ${lastName},</p>
    <p>ההרשמה הושלמה בהצלחה. שמחים שהצטרפת!</p>
  `;
  return sendMail(to, "ברוך/ה הבא/ה!", html);
}
