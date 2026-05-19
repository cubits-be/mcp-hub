import type { CustomTool } from "../types.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const INFLUXDB_URL = process.env.INFLUXDB_URL ?? "http://192.168.1.12:1715";
const INFLUXDB_DB = process.env.INFLUXDB_DB ?? "health_connect_metrics";
/** Hours to add to UTC to get local time (used for overnight resting HR window). */
const TZ_OFFSET_H = parseInt(process.env.HEALTH_TZ_OFFSET_HOURS ?? "0", 10);

// ---------------------------------------------------------------------------
// InfluxDB 1.x HTTP client
// ---------------------------------------------------------------------------

interface InfluxSeries {
  name: string;
  columns: string[];
  values?: Array<Array<string | number | null>>;
}

interface InfluxResponse {
  results: Array<{ statement_id: number; series?: InfluxSeries[]; error?: string }>;
}

async function influxQuery(q: string): Promise<InfluxSeries[]> {
  const url = `${INFLUXDB_URL}/query?db=${encodeURIComponent(INFLUXDB_DB)}&q=${encodeURIComponent(q)}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`InfluxDB HTTP ${res.status}: ${await res.text()}`);
  }
  const body = (await res.json()) as InfluxResponse;
  const result = body.results[0];
  if (result?.error) throw new Error(`InfluxDB error: ${result.error}`);
  return result?.series ?? [];
}

/** Convert rows to objects keyed by column name. */
function toObjects(series: InfluxSeries): Array<Record<string, string | number | null>> {
  return (series.values ?? []).map((row) =>
    Object.fromEntries(series.columns.map((col, i) => [col, row[i]]))
  );
}

// ---------------------------------------------------------------------------
// Time range helpers
// ---------------------------------------------------------------------------

type Period = "today" | "yesterday" | "last_24h" | "last_7d" | "last_30d";

/**
 * Returns an InfluxQL WHERE time clause for a named period or ISO from/to.
 * All comparisons are against UTC timestamps (InfluxDB stores in UTC).
 */
function timeClause(period: Period | undefined, from?: string, to?: string): string {
  const now = new Date();

  if (from || to) {
    const parts: string[] = [];
    if (from) parts.push(`time >= '${new Date(from).toISOString()}'`);
    if (to) parts.push(`time <= '${new Date(to).toISOString()}'`);
    return parts.join(" AND ");
  }

  // Offset now to local time for day boundary calculations
  const localNow = new Date(now.getTime() + TZ_OFFSET_H * 3_600_000);

  const startOfLocalToday = new Date(
    Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate()) -
      TZ_OFFSET_H * 3_600_000
  );

  switch (period ?? "last_24h") {
    case "today":
      return `time >= '${startOfLocalToday.toISOString()}'`;
    case "yesterday": {
      const startYest = new Date(startOfLocalToday.getTime() - 86_400_000);
      return `time >= '${startYest.toISOString()}' AND time < '${startOfLocalToday.toISOString()}'`;
    }
    case "last_24h":
      return `time > now() - 24h`;
    case "last_7d":
      return `time > now() - 7d`;
    case "last_30d":
      return `time > now() - 30d`;
  }
}

function periodDescription(period: Period | undefined, from?: string, to?: string): string {
  if (from || to) return `${from ?? "start"} → ${to ?? "now"}`;
  const labels: Record<string, string> = {
    today: "today",
    yesterday: "yesterday",
    last_24h: "last 24 hours",
    last_7d: "last 7 days",
    last_30d: "last 30 days",
  };
  return labels[period ?? "last_24h"] ?? (period as string);
}

// ---------------------------------------------------------------------------
// Shared schema fragments
// ---------------------------------------------------------------------------

const periodSchema = {
  period: {
    type: "string",
    enum: ["today", "yesterday", "last_24h", "last_7d", "last_30d"],
    description: 'Predefined time range. Ignored if "from"/"to" are provided. Default: last_24h.',
  },
  from: {
    type: "string",
    description: "Custom range start (ISO 8601). Overrides period.",
  },
  to: {
    type: "string",
    description: "Custom range end (ISO 8601). Defaults to now.",
  },
};

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

// ---------------------------------------------------------------------------
// Tool: heart_rate_summary
// ---------------------------------------------------------------------------

const heartRateSummaryTool: CustomTool = {
  definition: {
    name: "health__heart_rate_summary",
    description:
      "Returns heart rate statistics (average, min, max, count) for a given time range. " +
      "Useful for a quick overview of heart rate during a period.",
    inputSchema: {
      type: "object",
      properties: periodSchema,
      required: [],
    },
  },
  handler: async (args) => {
    const where = timeClause(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    const q = `SELECT MEAN(bpm) AS mean, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(bpm) AS count FROM heart_rate WHERE ${where}`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No heart rate data found for this period.");
    }
    const row = toObjects(series[0])[0];
    const mean = typeof row.mean === "number" ? row.mean.toFixed(1) : "n/a";
    const label = periodDescription(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    return text(
      `Heart rate summary — ${label}\n` +
        `  Average : ${mean} bpm\n` +
        `  Min     : ${row.min ?? "n/a"} bpm\n` +
        `  Max     : ${row.max ?? "n/a"} bpm\n` +
        `  Readings: ${row.count ?? 0}`
    );
  },
};

// ---------------------------------------------------------------------------
// Tool: heart_rate_trend (daily averages)
// ---------------------------------------------------------------------------

const heartRateTrendTool: CustomTool = {
  definition: {
    name: "health__heart_rate_trend",
    description:
      "Returns daily average heart rate for the last N days. " +
      "Useful for spotting upward or downward trends over time.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days to look back (default: 7, max: 90).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const days = Math.min(Math.max(1, (args.days as number | undefined) ?? 7), 90);
    const q =
      `SELECT MEAN(bpm) AS mean, MIN(bpm) AS min, MAX(bpm) AS max, COUNT(bpm) AS count ` +
      `FROM heart_rate WHERE time > now() - ${days}d GROUP BY time(1d) FILL(null)`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No heart rate data found.");
    }
    const rows = toObjects(series[0]).filter((r) => r.count !== null && r.count !== 0);
    if (!rows.length) return text("No heart rate data found for this period.");

    const lines = rows.map((r) => {
      const date = typeof r.time === "string" ? r.time.slice(0, 10) : "?";
      const mean = typeof r.mean === "number" ? r.mean.toFixed(1) : "n/a";
      return `  ${date}  avg ${mean} bpm  (min ${r.min ?? "?"} / max ${r.max ?? "?"}, ${r.count} readings)`;
    });
    return text(`Daily heart rate trend — last ${days} days:\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Tool: resting_heart_rate (overnight window)
// ---------------------------------------------------------------------------

const restingHeartRateTool: CustomTool = {
  definition: {
    name: "health__resting_heart_rate",
    description:
      "Returns estimated resting heart rate by averaging readings taken between midnight and 6 AM local time, " +
      "per night over the last N days. Lower resting HR generally indicates better cardiovascular fitness.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of nights to look back (default: 7).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const days = Math.min(Math.max(1, (args.days as number | undefined) ?? 7), 30);

    // InfluxDB 1.x doesn't support time::hour filtering in WHERE, so fetch all
    // raw points for the period and filter by UTC hour client-side.
    const utcStart = ((0 - TZ_OFFSET_H) % 24 + 24) % 24; // local midnight in UTC
    const utcEnd = ((6 - TZ_OFFSET_H) % 24 + 24) % 24;   // local 06:00 in UTC

    const q = `SELECT bpm FROM heart_rate WHERE time > now() - ${days}d ORDER BY time ASC`;
    const series = await influxQuery(q);
    if (!series.length) return text("No overnight heart rate data found.");

    // Filter to overnight window and bucket by local date
    const byLocalDate = new Map<string, number[]>();
    for (const row of toObjects(series[0])) {
      if (typeof row.time !== "string" || typeof row.bpm !== "number") continue;
      const ts = new Date(row.time);
      const utcHour = ts.getUTCHours();
      const inWindow =
        utcStart < utcEnd
          ? utcHour >= utcStart && utcHour < utcEnd
          : utcHour >= utcStart || utcHour < utcEnd;
      if (!inWindow) continue;
      // Assign to local date (adjust by TZ offset)
      const localTs = new Date(ts.getTime() + TZ_OFFSET_H * 3_600_000);
      const localDate = localTs.toISOString().slice(0, 10);
      const bucket = byLocalDate.get(localDate) ?? [];
      bucket.push(row.bpm);
      byLocalDate.set(localDate, bucket);
    }

    if (byLocalDate.size === 0) {
      return text(
        "No overnight readings found. The watch may not have been worn during sleep, " +
          `or the timezone offset (currently ${TZ_OFFSET_H}h) may need adjusting via HEALTH_TZ_OFFSET_HOURS.`
      );
    }

    const entries = [...byLocalDate.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines = entries.map(([date, bpms]) => {
      const avg = (bpms.reduce((a, b) => a + b, 0) / bpms.length).toFixed(1);
      const min = Math.min(...bpms);
      return `  ${date}  resting avg ${avg} bpm  (min ${min}, ${bpms.length} readings)`;
    });

    const allBpms = entries.flatMap(([, bpms]) => bpms);
    const overallAvg = (allBpms.reduce((a, b) => a + b, 0) / allBpms.length).toFixed(1);

    return text(
      `Estimated resting heart rate (midnight–6 AM local, last ${days} nights):\n` +
        lines.join("\n") +
        `\n\n  Overall resting average: ${overallAvg} bpm`
    );
  },
};

// ---------------------------------------------------------------------------
// Tool: heart_rate_zones
// ---------------------------------------------------------------------------

const heartRateZonesTool: CustomTool = {
  definition: {
    name: "health__heart_rate_zones",
    description:
      "Shows the distribution of heart rate readings across zones: " +
      "bradycardia (<60 bpm), normal (60–100 bpm), and elevated (>100 bpm). " +
      "Useful for understanding activity intensity over a period.",
    inputSchema: {
      type: "object",
      properties: periodSchema,
      required: [],
    },
  },
  handler: async (args) => {
    const where = timeClause(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );

    // Three separate count queries using WHERE + bpm filter
    const [seriesTotal, seriesBrady, seriesElevated] = await Promise.all([
      influxQuery(`SELECT COUNT(bpm) AS total FROM heart_rate WHERE ${where}`),
      influxQuery(`SELECT COUNT(bpm) AS brady FROM heart_rate WHERE ${where} AND bpm < 60`),
      influxQuery(`SELECT COUNT(bpm) AS elevated FROM heart_rate WHERE ${where} AND bpm > 100`),
    ]);

    const total = (toObjects(seriesTotal[0] ?? { columns: [], values: [] })[0]?.total as number) ?? 0;
    const brady = (toObjects(seriesBrady[0] ?? { columns: [], values: [] })[0]?.brady as number) ?? 0;
    const elevated = (toObjects(seriesElevated[0] ?? { columns: [], values: [] })[0]?.elevated as number) ?? 0;
    const normal = Math.max(0, total - brady - elevated);

    if (total === 0) return text("No heart rate data found for this period.");

    const pct = (n: number) => ((n / total) * 100).toFixed(1);
    const label = periodDescription(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );

    return text(
      `Heart rate zone distribution — ${label} (${total} readings):\n` +
        `  Bradycardia  (<60 bpm) : ${brady.toString().padStart(4)} readings  ${pct(brady)}%\n` +
        `  Normal    (60–100 bpm) : ${normal.toString().padStart(4)} readings  ${pct(normal)}%\n` +
        `  Elevated    (>100 bpm) : ${elevated.toString().padStart(4)} readings  ${pct(elevated)}%`
    );
  },
};

// ---------------------------------------------------------------------------
// Tool: steps_summary
// ---------------------------------------------------------------------------

const stepsSummaryTool: CustomTool = {
  definition: {
    name: "health__steps_summary",
    description: "Returns total step count and number of recorded sessions for a given time range.",
    inputSchema: {
      type: "object",
      properties: periodSchema,
      required: [],
    },
  },
  handler: async (args) => {
    const where = timeClause(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    const q = `SELECT SUM(count) AS total, COUNT(count) AS sessions FROM steps WHERE ${where}`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No steps data found for this period.");
    }
    const row = toObjects(series[0])[0];
    const label = periodDescription(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    return text(
      `Steps summary — ${label}\n` +
        `  Total steps : ${row.total ?? 0}\n` +
        `  Sessions    : ${row.sessions ?? 0}`
    );
  },
};

// ---------------------------------------------------------------------------
// Tool: steps_trend (daily totals)
// ---------------------------------------------------------------------------

const stepsTrendTool: CustomTool = {
  definition: {
    name: "health__steps_trend",
    description: "Returns daily step counts for the last N days.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of days to look back (default: 7, max: 90).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const days = Math.min(Math.max(1, (args.days as number | undefined) ?? 7), 90);
    const q =
      `SELECT SUM(count) AS total FROM steps ` +
      `WHERE time > now() - ${days}d GROUP BY time(1d) FILL(0)`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No steps data found.");
    }
    const rows = toObjects(series[0]).filter((r) => (r.total as number) > 0);
    if (!rows.length) return text("No steps data found for this period.");
    const lines = rows.map((r) => {
      const date = typeof r.time === "string" ? r.time.slice(0, 10) : "?";
      return `  ${date}  ${r.total ?? 0} steps`;
    });
    return text(`Daily steps — last ${days} days:\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Helpers shared by sleep tools
// ---------------------------------------------------------------------------

function fmtDuration(ms: number): string {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return `${h}h${m.toString().padStart(2, "0")}m`;
}

const SLEEP_AWAKE_STAGES = new Set(["AWAKE", "OUT_OF_BED"]);
const SLEEP_STAGE_ORDER = ["LIGHT", "DEEP", "REM", "SLEEPING", "AWAKE", "OUT_OF_BED", "SESSION", "UNKNOWN"];

// ---------------------------------------------------------------------------
// Tool: sleep_summary
// ---------------------------------------------------------------------------

const sleepSummaryTool: CustomTool = {
  definition: {
    name: "health__sleep_summary",
    description:
      "Returns total sleep duration and a breakdown by stage (light, deep, REM, awake) " +
      "for a given time range.",
    inputSchema: {
      type: "object",
      properties: periodSchema,
      required: [],
    },
  },
  handler: async (args) => {
    const where = timeClause(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    const q = `SELECT stage, stage_end FROM sleep WHERE ${where}`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No sleep data found for this period.");
    }

    const durationByStage = new Map<string, number>();
    let totalAsleepMs = 0;

    for (const row of toObjects(series[0])) {
      const startMs = row.time ? new Date(row.time as string).getTime() : null;
      const endMs = typeof row.stage_end === "number" ? row.stage_end : null;
      if (startMs === null || endMs === null) continue;
      const durMs = endMs - startMs;
      if (durMs <= 0) continue;
      const stage = (row.stage as string) || "UNKNOWN";
      durationByStage.set(stage, (durationByStage.get(stage) ?? 0) + durMs);
      if (!SLEEP_AWAKE_STAGES.has(stage)) totalAsleepMs += durMs;
    }

    if (durationByStage.size === 0) return text("No sleep data found for this period.");

    const label = periodDescription(
      args.period as Period | undefined,
      args.from as string | undefined,
      args.to as string | undefined
    );
    const stageLines = SLEEP_STAGE_ORDER.filter((s) => durationByStage.has(s)).map(
      (s) => `    ${s.padEnd(12)} ${fmtDuration(durationByStage.get(s)!)}`
    );

    return text(
      `Sleep summary — ${label}\n` +
        `  Total asleep : ${fmtDuration(totalAsleepMs)}\n` +
        `  By stage:\n${stageLines.join("\n")}`
    );
  },
};

// ---------------------------------------------------------------------------
// Tool: sleep_trend (nightly durations)
// ---------------------------------------------------------------------------

const sleepTrendTool: CustomTool = {
  definition: {
    name: "health__sleep_trend",
    description: "Returns nightly total sleep time and stage breakdown for the last N days.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Number of nights to look back (default: 7, max: 30).",
        },
      },
      required: [],
    },
  },
  handler: async (args) => {
    const days = Math.min(Math.max(1, (args.days as number | undefined) ?? 7), 30);
    const q = `SELECT stage, stage_end FROM sleep WHERE time > now() - ${days}d`;
    const series = await influxQuery(q);
    if (!series.length || !series[0].values?.length) {
      return text("No sleep data found.");
    }

    type DayEntry = { total: number; deep: number; rem: number; light: number; awake: number };
    const byDate = new Map<string, DayEntry>();

    for (const row of toObjects(series[0])) {
      const startMs = row.time ? new Date(row.time as string).getTime() : null;
      const endMs = typeof row.stage_end === "number" ? row.stage_end : null;
      if (startMs === null || endMs === null) continue;
      const durMs = endMs - startMs;
      if (durMs <= 0) continue;

      const localTs = new Date(startMs + TZ_OFFSET_H * 3_600_000);
      const date = localTs.toISOString().slice(0, 10);
      const e = byDate.get(date) ?? { total: 0, deep: 0, rem: 0, light: 0, awake: 0 };
      const stage = row.stage as string;

      if (!SLEEP_AWAKE_STAGES.has(stage)) e.total += durMs;
      if (stage === "DEEP")  e.deep  += durMs;
      if (stage === "REM")   e.rem   += durMs;
      if (stage === "LIGHT") e.light += durMs;
      if (stage === "AWAKE") e.awake += durMs;
      byDate.set(date, e);
    }

    if (byDate.size === 0) return text("No sleep data found for this period.");

    const lines = [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, e]) =>
        `  ${date}  ${fmtDuration(e.total).padEnd(8)}` +
        `  deep ${fmtDuration(e.deep)} | REM ${fmtDuration(e.rem)} | light ${fmtDuration(e.light)} | awake ${fmtDuration(e.awake)}`
      );

    return text(`Sleep trend — last ${days} nights:\n${lines.join("\n")}`);
  },
};

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const healthTools: CustomTool[] = [
  heartRateSummaryTool,
  heartRateTrendTool,
  restingHeartRateTool,
  heartRateZonesTool,
  stepsSummaryTool,
  stepsTrendTool,
  sleepSummaryTool,
  sleepTrendTool,
];
