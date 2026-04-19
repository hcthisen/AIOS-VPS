// Small logger that redacts anything that looks like a refresh token.
// The Phase 3 recipe is emphatic: never log raw refresh tokens.

const REFRESH_RE = /(refresh[_-]?token["':\s=]*)[A-Za-z0-9._~+/=\-]{10,}/gi;

function redact(s: string): string {
  return s.replace(REFRESH_RE, "$1<redacted>");
}

function fmt(level: string, args: unknown[]): string {
  const ts = new Date().toISOString();
  const body = args
    .map((a) => (typeof a === "string" ? a : JSON.stringify(a, null, 0)))
    .join(" ");
  return `${ts} ${level} ${redact(body)}`;
}

export const log = {
  info:  (...a: unknown[]) => console.log(fmt("info", a)),
  warn:  (...a: unknown[]) => console.warn(fmt("warn", a)),
  error: (...a: unknown[]) => console.error(fmt("error", a)),
  debug: (...a: unknown[]) => {
    if (process.env.AIOS_DEBUG) console.log(fmt("debug", a));
  },
};
