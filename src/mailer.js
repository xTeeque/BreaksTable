
import { Resend } from "resend";

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const FROM = process.env.MAIL_FROM || "no-reply@example.com";
const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

export async function sendPasswordReset(to, token) {
  if (!resend) return;
  const url = `${BASE_URL}/reset/${token}`;
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "איפוס סיסמה",
      html: `<p>קיבלת בקשה לאיפוס סיסמה.</p><p><a href="${url}">לחץ/י כאן לאיפוס</a></p><p>אם לא אתה ביקשת – אפשר להתעלם.</p>`,
    });
  } catch (e) {
    console.error("sendPasswordReset error:", e);
  }
}

export async function sendWelcome(to, firstName, lastName) {
  if (!resend) return;
  try {
    await resend.emails.send({
      from: FROM,
      to,
      subject: "ברוך/ה הבא/ה!",
      html: `<p>שלום ${firstName} ${lastName},</p><p>ההרשמה הושלמה בהצלחה. שמחים שהצטרפת.</p>`,
    });
  } catch (e) {
    console.error("sendWelcome error:", e);
  }
}
