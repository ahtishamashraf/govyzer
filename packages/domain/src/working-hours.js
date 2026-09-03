/**
 * Minimal working-hours calculator used by SLA scheduling and workflow waits. Hours are
 * expressed in the tenant timezone as { mon: [['09:00','18:00']], ... }.
 */
const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

export const DEFAULT_WORKING_HOURS = Object.freeze({
  mon: [['09:00', '18:00']],
  tue: [['09:00', '18:00']],
  wed: [['09:00', '18:00']],
  thu: [['09:00', '18:00']],
  fri: [['09:00', '13:00']],
  sat: [['10:00', '16:00']],
  sun: [],
});

function parseTime(value) {
  const [hours, minutes] = value.split(':').map((part) => Number.parseInt(part, 10));
  return hours * 60 + minutes;
}

function minutesOfDay(date) {
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function windowsFor(date, workingHours) {
  return workingHours[DAY_KEYS[date.getUTCDay()]] ?? [];
}

export function isWithinWorkingHours(date, workingHours = DEFAULT_WORKING_HOURS) {
  const minute = minutesOfDay(date);
  return windowsFor(date, workingHours).some(
    ([start, end]) => minute >= parseTime(start) && minute < parseTime(end)
  );
}

/**
 * Adds `minutes` of working time to `from`, skipping closed periods. Falls back to plain
 * wall-clock addition when the schedule has no open window at all.
 */
export function addWorkingMinutes(from, minutes, workingHours = DEFAULT_WORKING_HOURS) {
  const hasAnyWindow = Object.values(workingHours).some((windows) => windows.length > 0);
  if (!hasAnyWindow) return new Date(from.getTime() + minutes * 60_000);

  let remaining = minutes;
  let cursor = new Date(from.getTime());
  let guard = 0;

  while (remaining > 0 && guard < 14 * 24 * 60) {
    guard += 1;
    const windows = windowsFor(cursor, workingHours);
    const minute = minutesOfDay(cursor);
    const openWindow = windows.find(
      ([start, end]) => minute >= parseTime(start) && minute < parseTime(end)
    );

    if (openWindow) {
      const available = parseTime(openWindow[1]) - minute;
      const consumed = Math.min(available, remaining);
      cursor = new Date(cursor.getTime() + consumed * 60_000);
      remaining -= consumed;
      continue;
    }

    const nextStart = windows
      .map(([start]) => parseTime(start))
      .filter((start) => start > minute)
      .sort((a, b) => a - b)[0];

    if (nextStart !== undefined) {
      cursor = new Date(cursor.getTime() + (nextStart - minute) * 60_000);
    } else {
      const nextDay = new Date(cursor.getTime());
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      nextDay.setUTCHours(0, 0, 0, 0);
      cursor = nextDay;
    }
  }
  return cursor;
}
