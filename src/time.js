const SINGAPORE_OFFSET_HOURS = 8;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

export function parseDateOnly(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
  if (!match) {
    throw new Error(`Invalid date "${value}". Use YYYY-MM-DD.`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`Invalid calendar date "${value}".`);
  }

  return { year, month, day, date };
}

export function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
  if (!match) {
    throw new Error(`Invalid time "${value}". Use 24-hour HH:mm.`);
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 23 || minute > 59) {
    throw new Error(`Invalid time "${value}". Use 24-hour HH:mm.`);
  }
  return { hour, minute };
}

export function formatReboksDate(value) {
  const { date, year, day } = parseDateOnly(value);
  return `${WEEKDAYS[date.getUTCDay()]}, ${day} ${MONTHS[date.getUTCMonth()]} ${year}`;
}

export function releaseAtForDate(
  targetDate,
  { advanceDays = 13, releaseTime = "12:00" } = {},
) {
  const { date } = parseDateOnly(targetDate);
  const { hour, minute } = parseClock(releaseTime);
  const releaseDay = new Date(date.getTime() - advanceDays * 86_400_000);

  return new Date(
    Date.UTC(
      releaseDay.getUTCFullYear(),
      releaseDay.getUTCMonth(),
      releaseDay.getUTCDate(),
      hour - SINGAPORE_OFFSET_HOURS,
      minute,
    ),
  );
}

export function parseRunAt(value) {
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    const [date, time] = value.split("T");
    const { date: parsedDate } = parseDateOnly(date);
    const { hour, minute } = parseClock(time);
    return new Date(
      Date.UTC(
        parsedDate.getUTCFullYear(),
        parsedDate.getUTCMonth(),
        parsedDate.getUTCDate(),
        hour - SINGAPORE_OFFSET_HOURS,
        minute,
      ),
    );
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Invalid --run-at "${value}". Use YYYY-MM-DDTHH:mm for Singapore time or an ISO timestamp.`,
    );
  }
  return parsed;
}

export function formatSingaporeTimestamp(value) {
  return new Intl.DateTimeFormat("en-SG", {
    timeZone: "Asia/Singapore",
    dateStyle: "medium",
    timeStyle: "medium",
    hour12: false,
  }).format(new Date(value));
}

export function clockToMinutes(value) {
  const { hour, minute } = parseClock(value);
  return hour * 60 + minute;
}

export function timeTokens(value) {
  const minutes = clockToMinutes(value);
  const hour24 = Math.floor(minutes / 60);
  const minute = minutes % 60;
  const hour12 = hour24 % 12 || 12;
  const suffix = hour24 >= 12 ? "pm" : "am";
  const minuteText = String(minute).padStart(2, "0");
  return [
    `${String(hour24).padStart(2, "0")}:${minuteText}`,
    `${hour24}:${minuteText}`,
    `${hour12}:${minuteText} ${suffix}`,
    `${hour12}.${minuteText} ${suffix}`,
  ];
}

export function textContainsTime(text, value) {
  const normalized = String(text).toLowerCase().replace(/\s+/g, " ");
  return timeTokens(value).some((token) => normalized.includes(token));
}
