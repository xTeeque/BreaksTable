// src/db.js (הוסף פונקציה זו)
export async function normalizeSlotsToFour() {
  // מצא את כל ה-times בטבלה
  const timesRes = await pool.query(`SELECT DISTINCT time_label FROM slots ORDER BY time_label ASC`);
  const times = timesRes.rows.map(r => r.time_label);

  // אם אין כלל – אפשר לזרוע ברירות מחדל
  if (times.length === 0) {
    await seedSlotsIfEmpty();
    return;
  }

  // נקבע row_index קבוע לכל שעה: אם קיים – נשמר, אם לא – נייצר חדש עוקב
  const maxRowRes = await pool.query(`SELECT COALESCE(MAX(row_index),0)::int AS max_row FROM slots`);
  let nextRow = maxRowRes.rows[0].max_row + 1;

  for (const time of times) {
    // קח row_index קיים (אם יש), אחרת קבע חדש
    const rowRes = await pool.query(`SELECT row_index FROM slots WHERE time_label=$1 ORDER BY row_index ASC LIMIT 1`, [time]);
    const rowIndex = rowRes.rows[0]?.row_index ?? nextRow++;

    // ודא שיש בדיוק col_index 1..4
    for (let ci = 1; ci <= 4; ci++) {
      const { rows } = await pool.query(
        `SELECT id FROM slots WHERE time_label=$1 AND col_index=$2 LIMIT 1`,
        [time, ci]
      );
      if (rows.length === 0) {
        // חסרה משבצת – יוצרים חדשה
        const isActive = ci <= 2; // 2 פתוחות, 2 סגורות
        await pool.query(
          `INSERT INTO slots (label, color, time_label, col_index, row_index, active)
           VALUES ('', '#e5e7eb', $1, $2, $3, $4)`,
          [time, ci, rowIndex, isActive]
        );
      }
    }

    // אם יש יותר מ-4 (נתונים ישנים), נשמור רק 1..4 ונמחק עודפים
    await pool.query(
      `DELETE FROM slots WHERE time_label=$1 AND (col_index < 1 OR col_index > 4)`,
      [time]
    );
  }
}
