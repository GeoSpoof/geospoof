/**
 * Metrics (CloudWatch Embedded Metric Format) and the one failure logger.
 *
 * EMF lines go to stdout via `process.stdout.write`, not console.log: with the
 * Lambda JSON log format, console output is wrapped and would no longer be
 * parsed as EMF. Lambda gives a level-less line INFO, so the function's
 * application log level must stay at INFO or these are filtered out.
 *
 * Each line carries ONLY `_aws`, its dimension values and its metric values -
 * no request data. Dimensions are low-cardinality enums (each custom metric
 * stream costs $0.30/month; see the cost comment in cdk/lib/config/app.ts):
 *   ApnsResponse{Status} + aggregate   APNs status bucket, or timeout/network
 *   ApnsNon2xx (aggregate)             0 or 1 per APNs attempt; the alarm's numerator
 *   RelayRejected{Reason}              the relay's own refusals (schema, unauthorized, ...)
 *   RelayFault{Reason} + aggregate     relay-side failures; any one pages
 *   SessionIssued (aggregate)
 */
import type { RelayErrorCode } from "./http";
import type { RelayFaultReason } from "./secrets";

export const METRIC_NAMESPACE = "GeoSpoof/ApnsRelay";

export type StatusBucket =
  | "200"
  | "400"
  | "403"
  | "404"
  | "405"
  | "410"
  | "413"
  | "429"
  | "500"
  | "503"
  | "other"
  | "timeout"
  | "network";

const KNOWN_STATUSES: ReadonlySet<number> = new Set([
  200, 400, 403, 404, 405, 410, 413, 429, 500, 503,
]);

export function statusBucket(status: number): StatusBucket {
  return KNOWN_STATUSES.has(status) ? (String(status) as StatusBucket) : "other";
}

export interface MetricSink {
  apnsOutcome(status: StatusBucket): void;
  rejected(reason: RelayErrorCode): void;
  fault(reason: RelayFaultReason): void;
  sessionIssued(): void;
}

interface Directive {
  readonly dimensions: string[][];
  readonly metrics: readonly string[];
}

export function emfSink(
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
  nowMs: () => number = Date.now
): MetricSink {
  const emit = (
    directives: readonly Directive[],
    dims: Record<string, string>,
    values: Record<string, number>
  ) => {
    const line = {
      _aws: {
        Timestamp: nowMs(),
        CloudWatchMetrics: directives.map((d) => ({
          Namespace: METRIC_NAMESPACE,
          Dimensions: d.dimensions,
          Metrics: d.metrics.map((Name) => ({ Name, Unit: "Count" })),
        })),
      },
      ...dims,
      ...values,
    };
    write(`${JSON.stringify(line)}\n`);
  };

  return {
    apnsOutcome: (status) =>
      emit(
        [
          { dimensions: [["Status"], []], metrics: ["ApnsResponse"] },
          { dimensions: [[]], metrics: ["ApnsNon2xx"] },
        ],
        { Status: status },
        { ApnsResponse: 1, ApnsNon2xx: status === "200" ? 0 : 1 }
      ),
    rejected: (reason) =>
      emit(
        [{ dimensions: [["Reason"]], metrics: ["RelayRejected"] }],
        { Reason: reason },
        { RelayRejected: 1 }
      ),
    fault: (reason) =>
      emit(
        [{ dimensions: [["Reason"], []], metrics: ["RelayFault"] }],
        { Reason: reason },
        { RelayFault: 1 }
      ),
    sessionIssued: () =>
      emit([{ dimensions: [[]], metrics: ["SessionIssued"] }], {}, { SessionIssued: 1 }),
  };
}

export interface FailureFields {
  readonly route: "session" | "push";
  readonly error: RelayErrorCode;
  readonly apnsStatus?: number;
  readonly apnsReason?: string;
  readonly apnsId?: string;
  readonly fault?: RelayFaultReason;
}

const REASON_RE = /^[A-Za-z]{1,64}$/;
const APNS_ID_RE = /^[0-9A-Fa-f-]{36}$/;

/**
 * Log a failure, and only these whitelisted fields. Never the entitlement JWS,
 * the push token, the session token, the provider JWT, a request body or the
 * content state: they are credentials or customer data. Every field is
 * re-checked here so a caller cannot widen the whitelist by accident.
 */
export function logFailure(fields: FailureFields): void {
  const out: Record<string, string | number> = { route: fields.route, error: fields.error };
  if (typeof fields.apnsStatus === "number" && Number.isInteger(fields.apnsStatus)) {
    out.apnsStatus = fields.apnsStatus;
  }
  if (typeof fields.apnsReason === "string" && REASON_RE.test(fields.apnsReason)) {
    out.apnsReason = fields.apnsReason;
  }
  if (typeof fields.apnsId === "string" && APNS_ID_RE.test(fields.apnsId)) {
    out.apnsId = fields.apnsId;
  }
  if (typeof fields.fault === "string") out.fault = fields.fault;
  console.warn(JSON.stringify(out));
}
