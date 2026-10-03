// speculation/sessions.ts – the four trading sessions a speculation report covers, with per-session
// characteristics and bet limits. Times are LOCAL (default Europe/Warsaw, UTC+2 in summer, UTC+1 in winter),
// converted to UTC with the IANA time zone so daylight saving is handled. Pure core plus a CLI:
//   node speculation/sessions.ts [ISO now]    prints the session to report on and the upcoming ones.
//
// The "profile" text is a set of HEURISTICS (typical behaviour), not measured facts. The scorecard breaks
// results down per session so we can see whether they help.

import { fileURLToPath } from "node:url";

export type SessionId = "europe_open" | "eu_us_overlap" | "us" | "night_asia";

export type InvestorId = "retail_asia" | "retail_leveraged" | "institutions_us" | "institutions_eu" | "market_makers" | "whales_otc" | "systematic";
export type Weight = "high" | "medium" | "low";

export interface InvestorProfile {
  id: InvestorId;
  name: string;
  behavior: string; // how this group typically trades
  footprint: string; // what in the data shows them (or "not measurable with our tools")
  implication: string; // what that means for entries, stops and holding time
}

// Heuristic catalogue of the participant types; the sessions below say how much each matters.
export const INVESTORS: Record<InvestorId, InvestorProfile> = {
  retail_asia: {
    id: "retail_asia",
    name: "Asian retail (Korea, Japan, Southeast Asia)",
    behavior: "Spot- and altcoin-heavy, momentum chasing, reacts fast to local news and listings; strongest when Asian markets are open.",
    footprint: "Altcoin volume spikes in the Asian window; premium of Korean exchanges over global (not measurable with our tools: unknown unless a source is added).",
    implication: "Altcoin pumps/fades are common and short-lived; fade extended alt moves, do not hold them for hours.",
  },
  retail_leveraged: {
    id: "retail_leveraged",
    name: "Leveraged perp traders (global retail)",
    behavior: "High leverage, crowd the same side, add on strength; positions get liquidated in cascades.",
    footprint: "Funding rate, open-interest change, long/short ratio, liquidation bursts (Coinalyze tools).",
    implication: "Crowded side plus rising OI means squeeze/cascade risk against the crowd; stops sit just beyond obvious levels and get hunted.",
  },
  institutions_us: {
    id: "institutions_us",
    name: "US institutions (ETF flows, funds, basis traders)",
    behavior: "Trade US hours, correlate with Nasdaq/rates, react to US data and Fed; flows are large and persistent.",
    footprint: "Moves aligned with Nasdaq futures and DXY/US10Y around 14:30-22:00 local; ETF flow headlines; CME basis (flows not measurable with our tools).",
    implication: "Trend continuation after data is more likely than in Asian hours; use the equity index as a confirmation signal.",
  },
  institutions_eu: {
    id: "institutions_eu",
    name: "European institutions and banks",
    behavior: "Trade European hours, react to ECB/EU data, DXY and Bund moves; smaller crypto footprint than the US.",
    footprint: "Moves at the European open following DXY/Bund/equity futures.",
    implication: "Macro-driven direction at the open; fades if the US does not confirm.",
  },
  market_makers: {
    id: "market_makers",
    name: "Market makers / HFT",
    behavior: "Provide liquidity everywhere; in thin hours they widen spreads and thin depth, and price moves through stops easily.",
    footprint: "Spread and top-of-book depth (Kraken order-book tool).",
    implication: "Thin book means wicks: use wide stops and small size, avoid tight stops at obvious levels.",
  },
  whales_otc: {
    id: "whales_otc",
    name: "Whales / OTC desks / large holders",
    behavior: "Move size through OTC or in thin books; one print can move price when the book is thin.",
    footprint: "Large prints and exchange in/outflows (not measurable with our tools).",
    implication: "Treat sudden one-sided moves in thin hours as possibly non-informational; do not extrapolate them.",
  },
  systematic: {
    id: "systematic",
    name: "Systematic / trend-following / bots",
    behavior: "Trade breakouts and range edges, rebalance near session boundaries and the daily close.",
    footprint: "Breakouts of prior-day / Asian-range levels, moves around 00:00 UTC.",
    implication: "Levels at prior highs/lows and the daily open attract orders; expect sweeps then continuation or failure.",
  },
};

export interface RegionRole {
  region: string;
  role: "dominant" | "significant" | "fading" | "low";
  note: string;
}

export interface SessionDef {
  id: SessionId;
  label: string;
  localStart: string; // HH:MM
  localEnd: string; // HH:MM, on the next day when <= localStart
  entryDeadlineMinutes: number; // limit entry must be touched within this long after the window start
  maxTtlMinutes: number;
  maxEntryDeviation: number; // fraction of last price
  maxBets: number;
  minRewardRisk: number;
  profile: string[]; // typical behaviour, heuristics
  watch: string[]; // what to look at and what can move the market in this session
  caution: string[];
  regions: RegionRole[]; // which world regions generate the volume in this session (heuristic)
  investors: { id: InvestorId; weight: Weight }[]; // who matters most here
}

export const DEFAULT_TZ = "Europe/Warsaw";
export const DEFAULT_LEAD_MINUTES = 20; // the report is generated this long before the window opens

export const SESSIONS: SessionDef[] = [
  {
    id: "europe_open",
    label: "Europe open",
    localStart: "08:00",
    localEnd: "12:00",
    entryDeadlineMinutes: 60,
    maxTtlMinutes: 180,
    maxEntryDeviation: 0.008,
    maxBets: 3,
    minRewardRisk: 1.2,
    regions: [
      { region: "Europe (London, Frankfurt, Zurich)", role: "dominant", note: "Volume rebuilds as Europe comes online." },
      { region: "Asia", role: "fading", note: "Asian participants are leaving; their range is the reference." },
      { region: "US", role: "low", note: "Not yet active; US futures give direction." },
    ],
    investors: [
      { id: "institutions_eu", weight: "high" }, { id: "systematic", weight: "high" }, { id: "market_makers", weight: "medium" },
      { id: "retail_leveraged", weight: "medium" }, { id: "whales_otc", weight: "low" }, { id: "retail_asia", weight: "low" },
    ],
    profile: [
      "Liquidity returns after the thin Asian night; the first hour often probes (sweeps) the high or low of the Asian range before a direction is chosen.",
      "The overnight Asian range, the previous day's high/low and the 00:00 UTC daily open are the natural reference levels.",
      "Europe-driven macro (PMIs, inflation prints, ECB speakers) and the DXY / Bund / equity-futures open set the tone; crypto often follows the first European equity hour.",
    ],
    watch: [
      "Asian-session range and where price sits in it; funding and open interest change since the Asian open.",
      "European data releases and central-bank speakers in the next 4 hours; DXY, US10Y and equity futures direction.",
      "Weekly/monthly option expiries and the 08:00 UTC funding/settlement timing of the venues (verify, do not assume).",
    ],
    caution: ["The first 30 minutes are noisy: prefer limit entries at range edges over chasing the first move.", "On weekends there is no equity-market open, so this session is quieter."],
  },
  {
    id: "eu_us_overlap",
    label: "Europe/US overlap",
    localStart: "13:30",
    localEnd: "17:30",
    entryDeadlineMinutes: 45,
    maxTtlMinutes: 180,
    maxEntryDeviation: 0.01,
    maxBets: 3,
    minRewardRisk: 1.2,
    regions: [
      { region: "US (New York, Chicago)", role: "dominant", note: "US data, equity open and ETF flows drive the largest volume." },
      { region: "Europe", role: "significant", note: "Still active until the European close at about 17:30 local." },
      { region: "Asia", role: "low", note: "Asleep." },
    ],
    investors: [
      { id: "institutions_us", weight: "high" }, { id: "retail_leveraged", weight: "high" }, { id: "systematic", weight: "high" },
      { id: "institutions_eu", weight: "medium" }, { id: "market_makers", weight: "medium" }, { id: "whales_otc", weight: "medium" },
    ],
    profile: [
      "Highest liquidity and volume of the day; the largest moves and the fastest reversals cluster here.",
      "US macro data (usually 14:30 local time) and the US cash equity open (15:30 local) are the main catalysts; crypto reacts to Nasdaq futures and to rates/dollar moves.",
      "Spot ETF flow expectations and US-hours positioning (funding, open interest changes) matter more than in other sessions.",
    ],
    watch: [
      "Exact time of US data and speakers today; the first 15 minutes after a release are two-sided and often reverse.",
      "Nasdaq/S&P futures, DXY, US10Y, oil; open-interest build-up before the release (squeeze risk).",
      "Liquidation bursts and the estimated liquidation clusters (ESTIMATE) near price.",
    ],
    caution: [
      "Do not hold through a major release with a tight stop: either wait for the release or size for a wide move.",
      "Spreads and slippage rise right after data; limit entries may be skipped by a spike.",
      "On US holidays and weekends this session behaves like a quiet one.",
    ],
  },
  {
    id: "us",
    label: "US session",
    localStart: "17:30",
    localEnd: "22:00",
    entryDeadlineMinutes: 60,
    maxTtlMinutes: 210,
    maxEntryDeviation: 0.008,
    maxBets: 3,
    minRewardRisk: 1.2,
    regions: [
      { region: "US (New York, Chicago)", role: "dominant", note: "US flow dominates after Europe leaves." },
      { region: "Europe", role: "fading", note: "Gone after about 17:30 local." },
      { region: "Asia", role: "low", note: "Starts to wake near the end of the window." },
    ],
    investors: [
      { id: "institutions_us", weight: "high" }, { id: "retail_leveraged", weight: "medium" }, { id: "systematic", weight: "medium" },
      { id: "whales_otc", weight: "medium" }, { id: "market_makers", weight: "medium" },
    ],
    profile: [
      "European participants leave at the start of the window; US-driven flow dominates until the US cash close (22:00 local).",
      "The afternoon often continues or fades the move of the overlap; momentum into the equity close is common, as are reversals after a stretched move.",
      "FOMC decisions and Fed speakers usually land in this window (about 20:00 local on decision days) and can dominate everything else.",
    ],
    watch: [
      "Whether the overlap move is holding (higher lows / lower highs) and where funding and open interest are relative to the morning.",
      "Fed schedule today (decision, minutes, speakers), US earnings of crypto-linked equities, equity-index close.",
      "Late-day liquidation clusters and the perp basis.",
    ],
    caution: ["Volatility falls in the last hour before the cash close; tighten TTLs.", "Event days (FOMC) need wider stops or no bet before the release."],
  },
  {
    id: "night_asia",
    label: "Night (Asia)",
    localStart: "22:00",
    localEnd: "08:00",
    entryDeadlineMinutes: 180,
    maxTtlMinutes: 360,
    maxEntryDeviation: 0.006,
    maxBets: 2,
    minRewardRisk: 1.5,
    regions: [
      { region: "Asia (Japan, Korea, Hong Kong, Singapore, China-linked)", role: "dominant", note: "Takes over from about 01:00-02:00 local; Asian retail and Asian desks set the pace." },
      { region: "US", role: "fading", note: "US tail in the first hours of the window, then it sleeps." },
      { region: "Europe", role: "low", note: "Returns near 07:00-08:00 local." },
    ],
    investors: [
      { id: "retail_asia", weight: "high" }, { id: "market_makers", weight: "high" }, { id: "retail_leveraged", weight: "medium" },
      { id: "whales_otc", weight: "medium" }, { id: "systematic", weight: "medium" }, { id: "institutions_us", weight: "low" },
    ],
    profile: [
      "Thin, range-bound trading with sparse order books; stop hunts and wick-and-reverse moves are common, directional trends less so.",
      "Asia opens inside the window (Tokyo around 02:00 local, Hong Kong/China around 03:30 local): expect volatility bursts at those times and around the 00:00 UTC daily candle close.",
      "Asian-specific drivers: Japanese and Chinese data and policy headlines, USD/JPY, Hang Seng/Nikkei, Korean retail flow (premium on Korean exchanges).",
    ],
    watch: [
      "The US-session close level and the overnight range; USD/JPY, Nikkei and Hang Seng once they open.",
      "Asian headlines (policy, regulation, exchange news) and weekend-specific risk when this is a Friday or Saturday night.",
      "Order-book depth and spread: thin books mean wide stops are needed, so size down.",
    ],
    caution: [
      "The window is 10 hours: bets must say which phase they target (US wind-down, Asia open, HK/China open, Europe pre-open) and expire within it.",
      "Prefer fewer, higher reward:risk, limit-at-range-edge bets. 'No bet' is a good answer here.",
      "You are asleep or tired: use wide stops and small size rather than tight stops that wicks will take.",
    ],
  },
];

export const sessionById = (id: string): SessionDef | undefined => SESSIONS.find((s) => s.id === id);

// ---- time zone maths ----

const MIN = 60_000;

// Offset (local - UTC) of a time zone at a UTC instant, in milliseconds.
export function tzOffsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs));
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour"), g("minute"), g("second")) - Math.floor(utcMs / 1000) * 1000;
}

// Local wall-clock time in `tz` to a UTC instant (milliseconds).
export function zonedToUtcMs(date: string, hhmm: string, tz: string): number {
  const [y, mo, d] = date.split("-").map(Number) as [number, number, number];
  const [h, mi] = hhmm.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let utc = guess - tzOffsetMs(guess, tz);
  utc = guess - tzOffsetMs(utc, tz); // second pass settles daylight-saving edges
  return utc;
}

export const localDate = (utcMs: number, tz: string): string => {
  const p = new Date(utcMs + tzOffsetMs(utcMs, tz));
  return p.toISOString().slice(0, 10);
};

const addDays = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export interface SessionWindow {
  session: SessionDef;
  startMs: number;
  endMs: number;
  generateAtMs: number;
}

// The window of `session` that starts on local date `date`.
export function sessionWindow(session: SessionDef, date: string, tz = DEFAULT_TZ, leadMinutes = DEFAULT_LEAD_MINUTES): SessionWindow {
  const startMs = zonedToUtcMs(date, session.localStart, tz);
  const endDate = session.localEnd <= session.localStart ? addDays(date, 1) : date;
  const endMs = zonedToUtcMs(endDate, session.localEnd, tz);
  return { session, startMs, endMs, generateAtMs: startMs - leadMinutes * MIN };
}

// All windows starting on the local days around `nowMs`, sorted by start.
export function windowsAround(nowMs: number, tz = DEFAULT_TZ, leadMinutes = DEFAULT_LEAD_MINUTES): SessionWindow[] {
  const today = localDate(nowMs, tz);
  const out: SessionWindow[] = [];
  for (const d of [addDays(today, -1), today, addDays(today, 1)]) for (const s of SESSIONS) out.push(sessionWindow(s, d, tz, leadMinutes));
  return out.sort((a, b) => a.startMs - b.startMs);
}

// The session a report generated at `nowMs` is about: the one whose [generateAt, end) contains now
// (the routine fires `lead` minutes before the open; a manual run mid-session reports on the running one).
export function pickSession(nowMs: number, tz = DEFAULT_TZ, leadMinutes = DEFAULT_LEAD_MINUTES): SessionWindow {
  const all = windowsAround(nowMs, tz, leadMinutes);
  const hit = all.filter((w) => w.generateAtMs <= nowMs && nowMs < w.endMs).sort((a, b) => b.startMs - a.startMs)[0];
  return hit ?? all.find((w) => w.startMs > nowMs)!;
}

const fmtLocal = (ms: number, tz: string) => new Date(ms + tzOffsetMs(ms, tz)).toISOString().slice(0, 16).replace("T", " ");

export function describeWindow(w: SessionWindow, tz = DEFAULT_TZ) {
  return {
    session: w.session.id,
    label: w.session.label,
    startUtc: new Date(w.startMs).toISOString(),
    endUtc: new Date(w.endMs).toISOString(),
    startLocal: fmtLocal(w.startMs, tz),
    endLocal: fmtLocal(w.endMs, tz),
    generateAtUtc: new Date(w.generateAtMs).toISOString(),
    hours: (w.endMs - w.startMs) / 3_600_000,
  };
}

export function sessionOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): { tz: string; leadMinutes: number } {
  const lead = Number(env.SPECULATION_LEAD_MINUTES);
  return { tz: env.SPECULATION_TZ || DEFAULT_TZ, leadMinutes: Number.isFinite(lead) && env.SPECULATION_LEAD_MINUTES ? lead : DEFAULT_LEAD_MINUTES };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const now = process.argv[2] ? Date.parse(process.argv[2]) : Date.now();
  if (!Number.isFinite(now)) {
    console.error("usage: node speculation/sessions.ts [ISO now]");
    process.exit(2);
  }
  const { tz, leadMinutes } = sessionOptionsFromEnv();
  const w = pickSession(now, tz, leadMinutes);
  const upcoming = windowsAround(now, tz, leadMinutes).filter((x) => x.startMs > w.startMs).slice(0, 3).map((x) => describeWindow(x, tz));
  console.log(JSON.stringify({ tz, now: new Date(now).toISOString(), ...describeWindow(w, tz), limits: {
    entryDeadlineMinutes: w.session.entryDeadlineMinutes, maxTtlMinutes: w.session.maxTtlMinutes, maxEntryDeviation: w.session.maxEntryDeviation, maxBets: w.session.maxBets, minRewardRisk: w.session.minRewardRisk,
  }, regions: w.session.regions, investors: w.session.investors.map((i) => ({ ...INVESTORS[i.id], weight: i.weight })), profile: w.session.profile, watch: w.session.watch, caution: w.session.caution, upcoming }, null, 2));
}
