export type SimpleScheduleKind = "minute" | "hour" | "day" | "week" | "month";

export interface SimpleSchedule {
  kind: SimpleScheduleKind;
  interval: number;
  minute: number;
  hour: number;
  weekday: number;
  dayOfMonth: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function defaultSimpleSchedule(): SimpleSchedule {
  return {
    kind: "hour",
    interval: 1,
    minute: 0,
    hour: 9,
    weekday: 1,
    dayOfMonth: 1,
  };
}

export function parseSimpleSchedule(cron: string): SimpleSchedule | null {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [minute, hour, dayOfMonth, month, weekday] = parts;

  if (minute === "*" && hour === "*" && dayOfMonth === "*" && month === "*" && weekday === "*") {
    return { ...defaultSimpleSchedule(), kind: "minute", interval: 1 };
  }

  if (dayOfMonth === "*" && month === "*" && weekday === "*") {
    if (minute.startsWith("*/") && hour === "*") {
      return {
        ...defaultSimpleSchedule(),
        kind: "minute",
        interval: clamp(parseStep(minute), 1, 59),
      };
    }
    if (isNumber(minute) && hour === "*") {
      return {
        ...defaultSimpleSchedule(),
        kind: "hour",
        interval: 1,
        minute: clamp(Number(minute), 0, 59),
      };
    }
    if (isNumber(minute) && hour.startsWith("*/")) {
      return {
        ...defaultSimpleSchedule(),
        kind: "hour",
        interval: clamp(parseStep(hour), 1, 23),
        minute: clamp(Number(minute), 0, 59),
      };
    }
    if (isNumber(minute) && isNumber(hour)) {
      return {
        ...defaultSimpleSchedule(),
        kind: "day",
        interval: 1,
        minute: clamp(Number(minute), 0, 59),
        hour: clamp(Number(hour), 0, 23),
      };
    }
    if (isNumber(minute) && isNumber(hour) && dayOfMonth.startsWith("*/")) {
      return {
        ...defaultSimpleSchedule(),
        kind: "day",
        interval: clamp(parseStep(dayOfMonth), 1, 31),
        minute: clamp(Number(minute), 0, 59),
        hour: clamp(Number(hour), 0, 23),
      };
    }
  }

  if (isNumber(minute) && isNumber(hour) && dayOfMonth.startsWith("*/") && month === "*" && weekday === "*") {
    return {
      ...defaultSimpleSchedule(),
      kind: "day",
      interval: clamp(parseStep(dayOfMonth), 1, 31),
      minute: clamp(Number(minute), 0, 59),
      hour: clamp(Number(hour), 0, 23),
    };
  }

  if (isNumber(minute) && isNumber(hour) && dayOfMonth === "*" && month === "*" && isWeekday(weekday)) {
    return {
      ...defaultSimpleSchedule(),
      kind: "week",
      minute: clamp(Number(minute), 0, 59),
      hour: clamp(Number(hour), 0, 23),
      weekday: normalizeWeekday(Number(weekday)),
    };
  }

  if (isNumber(minute) && isNumber(hour) && isNumber(dayOfMonth) && weekday === "*") {
    return {
      ...defaultSimpleSchedule(),
      kind: "month",
      interval: month.startsWith("*/") ? clamp(parseStep(month), 1, 12) : 1,
      minute: clamp(Number(minute), 0, 59),
      hour: clamp(Number(hour), 0, 23),
      dayOfMonth: clamp(Number(dayOfMonth), 1, 31),
    };
  }

  return null;
}

export function cronFromSimpleSchedule(schedule: SimpleSchedule): string {
  const minute = clamp(schedule.minute, 0, 59);
  const hour = clamp(schedule.hour, 0, 23);
  const interval = Math.max(1, Math.floor(schedule.interval || 1));
  const weekday = normalizeWeekday(schedule.weekday);
  const dayOfMonth = clamp(schedule.dayOfMonth, 1, 31);

  switch (schedule.kind) {
    case "minute":
      return interval === 1 ? "* * * * *" : `*/${interval} * * * *`;
    case "hour":
      return interval === 1 ? `${minute} * * * *` : `${minute} */${interval} * * *`;
    case "day":
      return interval === 1 ? `${minute} ${hour} * * *` : `${minute} ${hour} */${interval} * *`;
    case "week":
      return `${minute} ${hour} * * ${weekday}`;
    case "month":
      return `${minute} ${hour} ${dayOfMonth} ${interval === 1 ? "*" : `*/${interval}`} *`;
    default:
      return "* * * * *";
  }
}

export function describeCronSchedule(cron: string): string {
  const simple = parseSimpleSchedule(cron);
  if (!simple) return `Cron ${cron}`;
  switch (simple.kind) {
    case "minute":
      return simple.interval === 1 ? "Every minute" : `Every ${simple.interval}m`;
    case "hour":
      return `${simple.interval === 1 ? "Every 1h" : `Every ${simple.interval}h`} at ${formatMinute(simple.minute)}`;
    case "day":
      return `${simple.interval === 1 ? "Every day" : `Every ${simple.interval} days`} at ${formatTime(simple.hour, simple.minute)}`;
    case "week":
      return `Every ${WEEKDAYS[simple.weekday]} at ${formatTime(simple.hour, simple.minute)}`;
    case "month":
      return `${simple.interval === 1 ? "Every month" : `Every ${simple.interval} months`} on day ${simple.dayOfMonth} at ${formatTime(simple.hour, simple.minute)}`;
    default:
      return cron;
  }
}

export function isSimpleCron(cron: string): boolean {
  return !!parseSimpleSchedule(cron);
}

export function formatTime(hour: number, minute: number) {
  return `${String(clamp(hour, 0, 23)).padStart(2, "0")}:${String(clamp(minute, 0, 59)).padStart(2, "0")}`;
}

export function parseTime(value: string): { hour: number; minute: number } {
  const [hour, minute] = value.split(":").map((part) => Number(part));
  return {
    hour: clamp(Number.isFinite(hour) ? hour : 0, 0, 23),
    minute: clamp(Number.isFinite(minute) ? minute : 0, 0, 59),
  };
}

export function weekdayLabel(weekday: number) {
  return WEEKDAYS[normalizeWeekday(weekday)];
}

function formatMinute(minute: number) {
  return `:${String(clamp(minute, 0, 59)).padStart(2, "0")}`;
}

function parseStep(value: string) {
  const parts = value.split("/");
  return Number(parts[1] || 1);
}

function isNumber(value: string) {
  return /^\d+$/.test(value);
}

function isWeekday(value: string) {
  return /^\d+$/.test(value) && Number(value) >= 0 && Number(value) <= 7;
}

function normalizeWeekday(value: number) {
  return value === 7 ? 0 : clamp(Math.floor(value || 0), 0, 6);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Math.floor(value)));
}
