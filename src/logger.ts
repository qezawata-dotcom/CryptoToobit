import pino from "pino";

/**
 * Application logger. Secrets (API keys, tokens, signature, the raw query
 * string that carries the signed params) are redacted at the serialiser level
 * so they can never reach the logs even when a caller logs a request object
 * verbatim.
 */
const SENSITIVE_PATHS = [
  "apiKey",
  "api_key",
  "secret",
  "secretKey",
  "secret_key",
  "token",
  "signature",
  "X-BB-APIKEY",
  "headers",
];

function redactKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    SENSITIVE_PATHS.some(
      (p) => lower === p || lower.endsWith(`.${p}`) || lower.includes(p),
    ) || lower.includes("query")
  );
}

function sanitize(value: unknown, seen: Set<unknown> = new Set()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string") return value;
  if (t === "number" || t === "boolean") return value;
  if (Array.isArray(value)) {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    return value.map((v) => sanitize(v, seen));
  }
  if (t === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (redactKey(k)) {
        out[k] = typeof v === "string" && v.length > 0 ? "[REDACTED]" : v;
        continue;
      }
      out[k] = sanitize(v, seen);
    }
    return out;
  }
  return value;
}

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",
  base: undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
  serializers: {
    err: pino.stdSerializers.err,
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    payload: sanitize,
    params: sanitize,
    headers: () => "[REDACTED]",
  },
});

export function redact(obj: unknown): unknown {
  return sanitize(obj);
}
