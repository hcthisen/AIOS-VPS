import React, { useEffect, useMemo, useState } from "react";
import {
  SimpleSchedule,
  cronFromSimpleSchedule,
  defaultSimpleSchedule,
  describeCronSchedule,
  formatTime,
  parseSimpleSchedule,
  parseTime,
  weekdayLabel,
} from "../lib/cron";

export function ScheduleField({
  value,
  onChange,
  label = "Schedule",
}: {
  value: string;
  onChange: (next: string) => void;
  label?: string;
}) {
  const parsed = useMemo(() => parseSimpleSchedule(value), [value]);
  const [mode, setMode] = useState<"simple" | "cron">(parsed ? "simple" : "cron");
  const [simple, setSimple] = useState<SimpleSchedule>(parsed || defaultSimpleSchedule());

  useEffect(() => {
    const nextParsed = parseSimpleSchedule(value);
    if (nextParsed) {
      setSimple(nextParsed);
      if (mode !== "cron") setMode("simple");
      return;
    }
    setMode("cron");
  }, [value]);

  const updateSimple = (patch: Partial<SimpleSchedule>) => {
    const next = { ...simple, ...patch };
    setSimple(next);
    onChange(cronFromSimpleSchedule(next));
  };

  return (
    <div className="col">
      <div className="row" style={{ justifyContent: "space-between", alignItems: "flex-end" }}>
        <label className="small muted">{label}</label>
        <div className="row">
          <button type="button" className={mode === "simple" ? "primary" : ""} onClick={() => {
            const fallback = parsed || simple || defaultSimpleSchedule();
            setSimple(fallback);
            setMode("simple");
            onChange(cronFromSimpleSchedule(fallback));
          }}>
            Simple
          </button>
          <button type="button" className={mode === "cron" ? "primary" : ""} onClick={() => setMode("cron")}>
            Cron
          </button>
        </div>
      </div>

      {mode === "simple" ? (
        <SimpleScheduleEditor schedule={simple} onChange={updateSimple} />
      ) : (
        <>
          <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="* * * * *" />
          <div className="small muted">Use cron for irregular patterns, advanced calendars, or yearly schedules.</div>
        </>
      )}

      <div className="small muted">Preview: {describeCronSchedule(value)}</div>
    </div>
  );
}

function SimpleScheduleEditor({
  schedule,
  onChange,
}: {
  schedule: SimpleSchedule;
  onChange: (patch: Partial<SimpleSchedule>) => void;
}) {
  const time = formatTime(schedule.hour, schedule.minute);

  return (
    <div className="grid-2 schedule-simple-grid">
      <SelectField
        label="Pattern"
        value={schedule.kind}
        onChange={(kind) => onChange({ kind: kind as SimpleSchedule["kind"] })}
      >
        <option value="minute">Every n minutes</option>
        <option value="hour">Every n hours</option>
        <option value="day">Every n days</option>
        <option value="week">Weekly</option>
        <option value="month">Monthly</option>
      </SelectField>

      {schedule.kind === "minute" && (
        <NumberField label="Interval" min={1} max={59} value={schedule.interval} onChange={(interval) => onChange({ interval })} suffix="minute(s)" />
      )}

      {schedule.kind === "hour" && (
        <>
          <NumberField label="Interval" min={1} max={23} value={schedule.interval} onChange={(interval) => onChange({ interval })} suffix="hour(s)" />
          <NumberField label="Minute" min={0} max={59} value={schedule.minute} onChange={(minute) => onChange({ minute })} suffix="past the hour" />
        </>
      )}

      {schedule.kind === "day" && (
        <>
          <NumberField label="Interval" min={1} max={31} value={schedule.interval} onChange={(interval) => onChange({ interval })} suffix="day(s)" />
          <TimeField value={time} onChange={(next) => onChange(parseTime(next))} />
        </>
      )}

      {schedule.kind === "week" && (
        <>
          <SelectField
            label="Day of week"
            value={String(schedule.weekday)}
            onChange={(weekday) => onChange({ weekday: Number(weekday) })}
          >
            {Array.from({ length: 7 }).map((_, day) => (
              <option key={day} value={day}>{weekdayLabel(day)}</option>
            ))}
          </SelectField>
          <TimeField value={time} onChange={(next) => onChange(parseTime(next))} />
        </>
      )}

      {schedule.kind === "month" && (
        <>
          <NumberField label="Interval" min={1} max={12} value={schedule.interval} onChange={(interval) => onChange({ interval })} suffix="month(s)" />
          <NumberField label="Day of month" min={1} max={31} value={schedule.dayOfMonth} onChange={(dayOfMonth) => onChange({ dayOfMonth })} />
          <TimeField value={time} onChange={(next) => onChange(parseTime(next))} />
        </>
      )}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: React.ReactNode;
}) {
  return (
    <label className="col">
      <span className="small muted">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {children}
      </select>
    </label>
  );
}

function NumberField({
  label,
  value,
  onChange,
  min,
  max,
  suffix,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  suffix?: string;
}) {
  return (
    <label className="col">
      <span className="small muted">{label}</span>
      <div className="row nowrap schedule-inline-field">
        <input
          type="number"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value || min))}
        />
        {suffix && <span className="small muted schedule-inline-suffix">{suffix}</span>}
      </div>
    </label>
  );
}

function TimeField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <label className="col">
      <span className="small muted">Time</span>
      <input type="time" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}
