import type { BusinessHours } from "./types";

export function addBusinessMinutes(from: Date, minutes: number, hours: BusinessHours): Date {
  const cursor = new Date(from.getTime());
  if (minutes <= 0) return cursor;
  const [sh, sm] = hours.start.split(":").map(Number);
  const [eh, em] = hours.end.split(":").map(Number);
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  if (!hours.days.length || endMin <= startMin) {
    cursor.setMinutes(cursor.getMinutes() + minutes);
    return cursor;
  }
  let left = minutes;
  for (let guard = 0; guard < 366 * 24 && left > 0; guard += 1) {
    const day = cursor.getDay();
    const curMin = cursor.getHours() * 60 + cursor.getMinutes();
    if (hours.days.includes(day) && curMin < endMin) {
      const open = Math.max(curMin, startMin);
      if (open < endMin) {
        if (curMin < startMin) cursor.setHours(sh, sm, 0, 0);
        const take = Math.min(endMin - open, left);
        cursor.setMinutes(cursor.getMinutes() + take);
        left -= take;
        if (left === 0) return cursor;
      }
    }
    cursor.setDate(cursor.getDate() + 1);
    cursor.setHours(sh, sm, 0, 0);
  }
  return cursor;
}
