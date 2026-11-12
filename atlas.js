// Curious Atlas. Built by build.mjs from src/logic.js and src/js/*.js; edit those, not this file.
// Pure game logic shared by the page and the tests: scoring, seeded randomness, answer masking,
// dates and progress backups. No DOM, no d3. Loads as window.AtlasLogic in the browser and as a
// CommonJS module in Node.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.AtlasLogic = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NAME_PTS = 50, PIN_PTS = 50, SPEED_PTS = 20, TIMER_S = 20;
  // A perfect answer (right, with the pin inside the country) earns a bonus on top, multiplied like the rest.
  const PERFECT_PTS = 10;
  // Arcade extras, all fixed in the question itself so every player of a round scores alike:
  // a.mm: the final question's mystery multiplier (a slot spin before it), a.fsm: a free spin's
  // reward multiplier, a.jp: today's secret jackpot country, worth JACKPOT × when named right.
  const JACKPOT = 5, LUCK_CAP = 5;
  const MYSTERY = [[1, 0.4], [2, 0.35], [3, 0.2], [5, 0.05]];
  const FREESPIN = [[2, 0.5], [3, 0.35], [5, 0.15]];
  // Fever: FEVER_AFTER perfect answers in a row set the next FEVER_Q questions on fire, each paying
  // FEVER_X. Perfects during a fever don't count toward the next one. Earned by skill, so it sits
  // outside the luck cap.
  const FEVER_AFTER = 5, FEVER_Q = 3, FEVER_X = 2;
  // All the bonus multipliers on one question (the luck ones, Fever and Double up) together never pass
  // BONUS_CAP, so one stacked question can't outweigh a whole round.
  const BONUS_CAP = 8;
  // A right answer on a Second chance's retry pays this share of the country's points and is never a Perfect.
  const RETRY_NAME = 0.5;
  // Power-ups (solo quizzes and Survival): a perfect answer may earn one, and so does every
  // POWER_EVERY points you reach in a game. You hold up to POWER_MAX; unused ones carry over to your
  // next game. Two change scoring: a shielded wrong answer keeps the streak alive, and Double up pays × 2.
  // only: where a power-up can drop or be used ("timed": a game with the speed-bonus clock on;
  // "survival": Survival games only).
  const POWERS = {
    freeze: { icon: "❄", label: "Freeze", desc: "Stops the clock for 10 seconds, keeping the speed bonus where it is.", only: "timed" },
    // The Lens shows where every choice is, which nearly gives a perfect pin away, so it drops less often.
    lens: { icon: "🔍", label: "Lens", desc: "Lights up this question's candidate countries on the globe.", weight: 0.3 },
    half: { icon: "½", label: "50/50", desc: "Takes away two wrong answers, free of charge." },
    shield: { icon: "🛡", label: "Shield", desc: "If this answer is wrong, your streak survives (and in Survival, your life)." },
    compass: { icon: "🧭", label: "Compass", desc: "Shows which continent it's on, free of charge." },
    double: { icon: "×2", label: "Double up", desc: "This question pays × 2." },
    retry: { icon: "↻", label: "Second chance", desc: "If your answer is wrong, you get one more try. Right on the retry, the country pays half." },
    life: { icon: "♥", label: "Extra life", desc: "Adds a life in Survival.", only: "survival" }
  };
  // A perfect answer drops one POWER_DROP of the time; every POWER_EVERY points reached drops one; and
  // no more than POWER_ROUND_MAX are earned in one game, from any source.
  const POWER_MAX = 3, POWER_EVERY = 1000, POWER_X = 2, POWER_DROP = 0.5, POWER_ROUND_MAX = 3;
  // Power-ups that can drop in a game with these settings ({timed, survival}).
  const powerKinds = (ctx = {}) => Object.keys(POWERS).filter((k) => !POWERS[k].only || !!ctx[POWERS[k].only]);
  // A random power-up for these settings, by weight (1 unless a power-up says otherwise). r: 0 to 1.
  function pickPower(ctx, r = Math.random()) {
    const kinds = powerKinds(ctx), total = kinds.reduce((a, k) => a + (POWERS[k].weight ?? 1), 0);
    let acc = 0;
    for (const k of kinds) { acc += (POWERS[k].weight ?? 1) / total; if (r < acc) return k; }
    return kinds[kinds.length - 1];
  }
  // How many power-ups a score crossing from `before` to `after` points earns (one per POWER_EVERY).
  const powerMilestones = (before, after) => Math.max(0, Math.floor(Math.max(0, after) / POWER_EVERY) - Math.floor(Math.max(0, before) / POWER_EVERY));
  // A weighted pick from [[value, weight], ...] with a random number from 0 to 1.
  const weighted = (table, r) => { let acc = 0; for (const [v, w] of table) { acc += w; if (r < acc) return v; } return table[table.length - 1][0]; };
  // Streaks: every right answer in a row multiplies the next one by another 1.5, up to 4 times.
  const STREAK_STEP = 1.5, STREAK_CAP = 4, STREAK_MIN = 2;
  const DIFFS = {
    easy: { label: "Easy", mult: 1, note: "Pick from 4 countries." },
    medium: { label: "Medium", mult: 1.25, note: "Pick from 6 countries. 1.25× points." },
    hard: { label: "Hard", mult: 1.5, note: "Type the country yourself. 1.5× points." },
    expert: { label: "Expert", mult: 2, note: "Type it, on a map with no borders. 2× points." }
  };
  // How each level plays, from friendliest to toughest:
  // wrong: where the wrong choices come from ("far": other continents, "continent": the same one,
  //   "near": the nearest countries). pool: which countries are asked ("famous": large or populous ones,
  //   "mid": no tiny territories, "all", "small": leaning toward small places and territories).
  // pinFree / pinScale: a pin within pinFree km scores in full, then fades over pinScale km.
  // freeHints: clues that cost nothing. maxHints: clues allowed per question.
  // timer: "off" (never), "optional" (the Speed bonus switch) or "on" (always).
  const LEVELS = {
    easy: { wrong: "far", pool: "famous", pinFree: 300, pinScale: 1600, freeHints: [], timer: "off" },
    medium: { wrong: "continent", pool: "mid", pinFree: 0, pinScale: 1200, freeHints: [], timer: "optional" },
    hard: { wrong: "near", pool: "all", pinFree: 0, pinScale: 900, freeHints: [], timer: "optional" },
    expert: { wrong: "near", pool: "small", pinFree: 0, pinScale: 700, freeHints: [], maxHints: 1, timer: "on" }
  };
  const level = (diff) => LEVELS[diff] || { pinFree: 0, pinScale: 1200, freeHints: [], timer: "optional" };
  // Hints cost a share of the answer's points (after the streak multiplier), never a fixed amount, so
  // they stay a real price at any streak. Each hint has a base price (15%, 20%, 25%); each extra hint on the same question
  // costs 1.5× the one before; and the cost climbs 1.15× for every answer in your streak up to 4, then
  // steps up another 1.15× at 6 in a row and again at 8, so protecting a long streak costs more.
  // Hints never break a streak. The total is capped at 80%, so a right answer is always worth something.
  const HINTS = [
    { key: "continent", label: "Continent", pct: 0.15 },
    { key: "zoom", label: "Zoom to the region", pct: 0.20 },
    { key: "elim", label: "Eliminate a wrong answer", pct: 0.25 },
    // Offered once the first is used: a second wrong answer goes, at a higher price.
    { key: "elim2", label: "Eliminate another", pct: 0.30, after: "elim" }
  ];
  const HINT_ORDER_STEP = 1.5, HINT_STREAK_STEP = 1.15, HINT_STREAK_JUMPS = [6, 8], HINT_JUMP = 1.15, HINT_CAP = 0.8;
  const OLD_HINTS = { pop: 0.15, letter: 0.15 }; // hints from earlier versions, in saved games
  // Extra words that would give away the answer in quiz mode.
  const GIVEAWAYS = {
    "250": ["French"], "724": ["Spanish"], "826": ["British", "Britain", "Scotland", "Scottish", "English", "London"],
    "246": ["Finnish", "Finns"], "372": ["Irish"], "764": ["Thai"], "616": ["Polish", "Poles"], "208": ["Danish", "Danes"],
    "528": ["Dutch"], "756": ["Swiss"], "608": ["Filipino"], "450": ["Malagasy"], "364": ["Persian"],
    "840": ["America", "American", "US"], "748": ["Swaziland"], "104": ["Burmese"], "578": ["Norwegian"], "752": ["Swedish"],
    "156": ["Chinese"], "392": ["Japanese"], "214": ["Domingo"], "554": ["Māori"], "070": ["Sarajevo"], "100": ["bulgaricus"],
    "784": ["emirates", "Emirates"], "296": ["Kiritimati"], "SiachenGlacier": ["glacier"], "086": ["Britain", "Chagos", "Chagossian"]
  };
  const GENERIC = new Set(["South", "North", "West", "Western", "East", "New", "United", "States", "Republic", "Islands", "Island", "Lands", "Southern", "French", "Equatorial", "Northern", "Arab"]);

  // Deterministic random numbers from a string, so every player gets the same daily questions.
  function seededRng(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) { h = Math.imul(h ^ str.charCodeAt(i), 3432918353); h = (h << 13) | (h >>> 19); }
    let a = h >>> 0;
    return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  const shuffle = (a, rnd = Math.random) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const fmtKm = (km) => `${Math.round(km).toLocaleString("en-US")} km`;
  // Rough population for the hint, rounded to two significant figures: "about 48 million".
  function fmtPeople(n) {
    if (!Number.isFinite(n) || n <= 0) return null;
    const round2 = (x) => { const p = Math.pow(10, Math.floor(Math.log10(x)) - 1); return Math.round(x / p) * p; };
    const r = round2(n);
    if (r >= 1e9) return `about ${+(r / 1e9).toFixed(1)} billion`;
    if (r >= 1e6) return `about ${+(r / 1e6).toFixed(1)} million`;
    return `about ${r.toLocaleString("en-US")}`;
  }
  const plural = (n, w, pl = w + "s") => `${n} ${n === 1 ? w : pl}`;

  /* Scoring. One answer: (name + pin + speed) × difficulty × double × streak multiplier × (1 − hint %).
     A bet is then won or lost on top. streakBefore: right answers in a row just before this one. */
  // The pin: full points inside the country (or within the level's free radius), fading with distance.
  const pinPoints = (km, diff) => { const lv = level(diff); return km === 0 || km <= lv.pinFree ? PIN_PTS : Math.round(PIN_PTS * Math.exp(-(km - lv.pinFree) / lv.pinScale)); };
  // A lock time under 0.3 s isn't humanly possible; treat it (and anything non-numeric) as no time.
  const clampMs = (ms) => (Number.isFinite(ms) && ms >= 300 ? Math.min(ms, TIMER_S * 1000) : null);
  const streakMult = (s) => Math.min(STREAK_CAP, Math.pow(STREAK_STEP, Math.max(0, s)));
  const hintBase = (key) => (HINTS.find((h) => h.key === key) || {}).pct || OLD_HINTS[key] || 0;
  // The share of the answer that the hints used so far cost, in the order they were used.
  // A level's free clues (the continent on Easy) cost nothing and don't raise the price of the next one.
  function hintPct(hints, streakBefore = 0, diff) {
    const free = level(diff).freeHints || [];
    const keys = [...new Set(Array.isArray(hints) ? hints : [])].filter((k) => hintBase(k) > 0 && !free.includes(k));
    const st = Math.max(0, streakBefore);
    const streakF = Math.pow(HINT_STREAK_STEP, Math.min(st, 4)) * Math.pow(HINT_JUMP, HINT_STREAK_JUMPS.filter((m) => st >= m).length);
    const pct = keys.reduce((sum, k, i) => sum + hintBase(k) * Math.pow(HINT_ORDER_STEP, i) * streakF, 0);
    return Math.min(HINT_CAP, Math.round(pct * 100) / 100);
  }
  // What the next hint of this kind would add, for the hint buttons.
  const nextHintPct = (used, key, streakBefore, diff) => Math.round((hintPct([...used, key], streakBefore, diff) - hintPct(used, streakBefore, diff)) * 100);
  // "Find it" rounds give the country's name and ask only for the pin, measured to the country's nearest
  // edge (0 inside it). Big countries are easy targets, so the size of the country (a.size, km²) sets
  // the rules: a small one counts as found within FIND_KM and its pin counts double; the bigger the
  // country, the tighter the margin (down to FIND_KM_MIN) and the less the pin is worth (down to 1.25×).
  const FIND_KM = 500, FIND_KM_MIN = 150;
  const sizeRadius = (area) => (Number.isFinite(area) && area > 0 ? Math.sqrt(area / Math.PI) : 0);
  const findKm = (area) => Math.round(Math.max(FIND_KM_MIN, FIND_KM - 0.15 * sizeRadius(area)));
  const findPinMult = (area) => +(2 - 0.75 * Math.min(1, Math.max(0, (sizeRadius(area) - 300) / 1200))).toFixed(2);
  const isRight = (a) => (a.findIt ? Number.isFinite(a.km) && a.km <= findKm(a.size) : !!a.right);
  // Two-choice rounds (higher or lower, north or south) are half luck: the name is worth half, and a
  // right answer adds only half a step to the streak multiplier.
  const TWO_NAME = 0.5, TWO_STEP = 0.5;
  // a.fd: how tricky the fact is, from how often players get it right (1 when unknown): 0.9 to 1.25.
  const factMult = (fd) => (Number.isFinite(fd) ? Math.min(1.25, Math.max(0.9, fd)) : 1);
  function scoreAnswer(a, cfg, isDouble, streakBefore = 0, fever = false) {
    const right = isRight(a);
    const name = a.findIt ? 0 : right ? Math.round(NAME_PTS * (a.two ? TWO_NAME : 1) * (a.retried ? RETRY_NAME : 1)) : 0, pin = Math.round(pinPoints(a.km, cfg.diff) * (a.findIt ? findPinMult(a.size) : 1));
    const ms = clampMs(a.ms);
    // a.timed: a bonus-round answer, always on the clock even when the round's speed bonus is off.
    const speed = (cfg.timer || a.timed) && ms != null ? Math.round(SPEED_PTS * Math.max(0, 1 - ms / (TIMER_S * 1000))) : 0;
    // The luck multipliers together never pass LUCK_CAP, so a lucky spin can't outweigh a skilled round.
    const extra = Math.min(LUCK_CAP, (Number.isFinite(a.mm) ? Math.min(5, Math.max(1, a.mm)) : 1) * (Number.isFinite(a.fsm) ? Math.min(5, Math.max(1, a.fsm)) : 1) * (a.jp && right ? JACKPOT : 1));
    const mult = (DIFFS[cfg.diff] || DIFFS.easy).mult * (isDouble ? 2 : 1) * factMult(a.fd) * extra;
    const streak = right ? streakMult(streakBefore) : 1;
    const hp = hintPct(a.hints, streakBefore, cfg.diff);
    const perfect = right && a.km === 0 && !a.retried ? PERFECT_PTS : 0;
    const fx = fever ? FEVER_X : 1, px = a.dbl ? POWER_X : 1;
    // extra (luck) is already in mult; Fever and Double up join it under BONUS_CAP.
    const stacked = extra * fx * px, bonus = Math.min(BONUS_CAP, stacked) / extra;
    return { name, pin, speed, perfect, mult, streak, fever: fx, power: px, bonusCapped: stacked > BONUS_CAP, hintPct: hp, pts: Math.round((name + pin + speed + perfect) * mult * streak * bonus * (1 - hp)) };
  }
  // A whole run of answers in order (null for a question not answered), with streaks and bets.
  // A bet is a share (up to half) of the points banked before the question: named right, you win it
  // (twice on the final, double-points question, less the same hint %), but never more than the
  // question itself scored, so betting can't snowball; named wrong, you lose it.
  const BET_MAX = 0.5;
  // run: right answers in a row (what players see); heat: the streak power behind the multiplier and
  // the clue prices, which a two-choice round raises by only half a step.
  // perf: perfect answers in a row toward a fever; feverLeft: questions of fever still to come.
  // a.shield: a Shield power-up was used on this answer; a.dbl: a Double up.
  function scoreRun(answers, cfg, n = answers.length) {
    let run = 0, heat = 0, total = 0, perf = 0, feverLeft = 0;
    const items = answers.map((a, i) => {
      const isDouble = i === n - 1;
      if (!a) { run = 0; heat = 0; perf = 0; feverLeft = Math.max(0, feverLeft - 1); return { pts: 0, right: false, streakBefore: 0, heatBefore: 0, bet: 0, betPts: 0, fever: 1 }; }
      const onFire = feverLeft > 0;
      const s = scoreAnswer(a, cfg, isDouble, heat, onFire);
      const betShare = Number.isFinite(a.bet) ? Math.min(BET_MAX, Math.max(0, a.bet)) : 0;
      const stake = Math.round(total * betShare);
      const betPts = !stake ? 0 : isRight(a) ? Math.min(s.pts, Math.round(stake * (isDouble ? 2 : 1) * (1 - s.hintPct))) : -stake;
      const shielded = !isRight(a) && !!a.shield;
      const item = { ...s, right: isRight(a), streakBefore: run, heatBefore: heat, two: !!a.two, bet: betShare, stake, betPts, pts: s.pts + betPts, shielded, feverStart: false };
      total += item.pts;
      if (!shielded) {
        run = isRight(a) ? run + 1 : 0;
        heat = isRight(a) ? heat + (a.two ? TWO_STEP : 1) : 0;
      }
      if (onFire) feverLeft -= 1;
      else {
        perf = isRight(a) && a.km === 0 && !a.retried ? perf + 1 : 0;
        if (perf >= FEVER_AFTER) { feverLeft = FEVER_Q; perf = 0; item.feverStart = true; }
      }
      return item;
    });
    return { items, total, streak: run, heat, perf, feverLeft };
  }
  // How good one answer was, 0 to 1, from the name, pin and speed alone (no streak, bet or hints), for
  // the colored dots and share squares.
  const answerQuality = (it, cfg) => (it && Number.isFinite(it.name) ? (it.name + it.pin + it.speed) / (NAME_PTS + PIN_PTS + (cfg.timer ? SPEED_PTS : 0)) : 0);
  // For a list of right/wrong answers in order, how many were right in a row just before each one.
  const streaksBefore = (rights) => { let run = 0; return rights.map((r) => { const b = run; run = r ? run + 1 : 0; return b; }); };
  // The best possible round without bets: every answer perfect, no hints, a growing streak.
  // extras: optional per-question round details ({two, findIt, size, fd}) so the maximum matches the questions.
  const roundMax = (cfg, n, extras = []) => scoreRun(Array.from({ length: n }, (_, i) => ({ ...(extras[i] || {}), right: true, km: 0, ms: 300, hints: [] })), cfg, n).total;

  /* Masking: blanks out the country's name, its stems ("Argenti-ne") and known giveaway words. */
  function maskPattern(names, id) {
    const alts = [];
    [...new Set(names.filter(Boolean))].forEach((n) => {
      alts.push(n);
      n.split(/[\s-]+/).forEach((w) => {
        w = w.replace(/[^\p{L}']/gu, "");
        if (w.length >= 4 && !GENERIC.has(w)) alts.push(w.slice(0, Math.max(4, w.length - 2)));
      });
    });
    (GIVEAWAYS[id] || []).forEach((w) => alts.push(w));
    const pat = [...new Set(alts)].sort((a, b) => b.length - a.length).map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    return new RegExp(`(?<![\\p{L}])(?:${pat})[\\p{L}'’]*`, "gu");
  }

  /* Mix-ups: when you name the wrong country, a short note on telling the two apart. */
  const COMPASS = ["north", "northeast", "east", "southeast", "south", "southwest", "west", "northwest"];
  // Initial bearing from point a to point b ([lon, lat] in degrees), as a compass word.
  function compass(a, b) {
    const r = Math.PI / 180, [l1, p1] = [a[0] * r, a[1] * r], [l2, p2] = [b[0] * r, b[1] * r];
    const y = Math.sin(l2 - l1) * Math.cos(p2), x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(l2 - l1);
    const deg = (Math.atan2(y, x) / r + 360) % 360;
    return COMPASS[Math.round(deg / 45) % 8];
  }
  // a and b: { name, at: [lon, lat], area, cap }. km: distance between their centers.
  function tellApart(a, b, km) {
    const parts = [`${a.name} is about ${fmtKm(Math.round(km / 50) * 50 || km)} ${compass(b.at, a.at)} of ${b.name}`];
    if (a.area > 0 && b.area > 0) {
      const ratio = a.area / b.area;
      if (ratio >= 1.5) parts.push(`about ${ratio >= 5 ? Math.round(ratio) : +ratio.toFixed(1)} times bigger`);
      else if (ratio <= 1 / 1.5) parts.push(`about ${1 / ratio >= 5 ? Math.round(1 / ratio) : +(1 / ratio).toFixed(1)} times smaller`);
      else parts.push("about the same size");
    }
    let s = parts.join(", and ") + ".";
    if (a.cap && b.cap && a.cap !== b.cap) s += ` Capitals: ${a.cap} vs. ${b.cap}.`;
    return s;
  }

  /* Dates. */
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  // The daily runs on one global calendar (UTC), so everyone gets the same puzzle at the same moment
  // and nobody in an earlier time zone can spoil tomorrow's for the rest.
  const utcDayKey = (d = new Date()) => d.toISOString().slice(0, 10);
  const prevDay = (key) => { const [y, m, d] = key.split("-").map(Number); return dayKey(new Date(y, m - 1, d - 1)); };

  /* Progress backup: everything a player earns lives in their browser; this packs it into a code. */
  const PROGRESS_KEYS = ["atlas-stamps", "atlas-ach", "atlas-stats", "atlas-daily", "atlas-review", "atlas-seen", "atlas-cfg", "atlas-challenges", "atlas-vname", "atlas-best2-easy", "atlas-best2-medium", "atlas-best2-hard", "atlas-best2-expert", "atlas-look", "atlas-mixups", "atlas-sound", "atlas-seenfacts", "atlas-recentq", "atlas-best2-survival", "atlas-sets", "atlas-login", "atlas-dailyretry", "atlas-skins", "atlas-mybest", "atlas-initials", "atlas-power"];
  const toB64 = (s) => (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(s))) : Buffer.from(s, "utf8").toString("base64"));
  const fromB64 = (s) => (typeof atob === "function" ? decodeURIComponent(escape(atob(s))) : Buffer.from(s, "base64").toString("utf8"));
  function encodeProgress(store) {
    const data = {};
    PROGRESS_KEYS.forEach((k) => { if (store[k] != null) data[k] = store[k]; });
    return "CA1." + toB64(JSON.stringify({ v: 1, at: Date.now(), data }));
  }
  function decodeProgress(code) {
    const s = String(code || "").replace(/\s+/g, "");
    if (!s.startsWith("CA1.")) throw new Error("That doesn't look like a Curious Atlas progress code.");
    let obj;
    try { obj = JSON.parse(fromB64(s.slice(4))); } catch (e) { throw new Error("That progress code is incomplete or damaged. Copy it again in full."); }
    if (!obj || obj.v !== 1 || typeof obj.data !== "object") throw new Error("That progress code is from an unknown version.");
    const out = {};
    PROGRESS_KEYS.forEach((k) => { if (typeof obj.data[k] === "string") out[k] = obj.data[k]; });
    return out;
  }
  const parse = (s, fb) => { try { const v = JSON.parse(s); return v == null ? fb : v; } catch (e) { return fb; } };
  // Combine a restored backup with what's already in this browser, keeping the best of both.
  function mergeProgress(local, incoming) {
    const out = Object.assign({}, local);
    const objUnion = (k) => { const a = parse(local[k], {}), b = parse(incoming[k], {}); out[k] = JSON.stringify(Object.assign({}, b, a)); };
    const arrUnion = (k) => { out[k] = JSON.stringify([...new Set([...parse(local[k], []), ...parse(incoming[k], [])])]); };
    if (incoming["atlas-stamps"]) objUnion("atlas-stamps");
    if (incoming["atlas-ach"]) objUnion("atlas-ach");
    if (incoming["atlas-mixups"]) objUnion("atlas-mixups");
    if (incoming["atlas-sets"]) objUnion("atlas-sets");
    if (incoming["atlas-skins"]) objUnion("atlas-skins");
    if (incoming["atlas-mybest"]) {
      // Personal best lists: both lists together, best ten per board.
      const a = parse(local["atlas-mybest"], {}), b = parse(incoming["atlas-mybest"], {}), m = {};
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach((k) => {
        const seen = new Set();
        m[k] = [...(Array.isArray(a[k]) ? a[k] : []), ...(Array.isArray(b[k]) ? b[k] : [])].filter((r) => r && Number.isFinite(r.s) && !seen.has(`${r.s}|${r.at}`) && seen.add(`${r.s}|${r.at}`)).sort((x, y) => y.s - x.s || x.at - y.at).slice(0, 10);
      });
      out["atlas-mybest"] = JSON.stringify(m);
    }
    if (incoming["atlas-seen"]) arrUnion("atlas-seen");
    if (incoming["atlas-review"]) arrUnion("atlas-review");
    if (incoming["atlas-seenfacts"]) arrUnion("atlas-seenfacts");
    if (incoming["atlas-stats"]) {
      const a = parse(local["atlas-stats"], {}), b = parse(incoming["atlas-stats"], {}), m = {};
      new Set([...Object.keys(a), ...Object.keys(b)]).forEach((key) => { m[key] = Math.max(Number(a[key]) || 0, Number(b[key]) || 0); });
      out["atlas-stats"] = JSON.stringify(m);
    }
    if (incoming["atlas-daily"]) {
      const a = parse(local["atlas-daily"], null), b = parse(incoming["atlas-daily"], null);
      if (!a || !a.history) out["atlas-daily"] = incoming["atlas-daily"];
      else if (b && b.history) {
        const history = Object.assign({}, b.history, a.history);
        const newer = (b.last || "") > (a.last || "") ? b : a;
        out["atlas-daily"] = JSON.stringify({ last: newer.last, streak: newer.streak, best: Math.max(a.best || 0, b.best || 0), played: Object.keys(history).length, history });
      }
    }
    ["atlas-best2-easy", "atlas-best2-medium", "atlas-best2-hard", "atlas-best2-expert", "atlas-best2-survival"].forEach((k) => {
      if (incoming[k] != null) out[k] = String(Math.max(Number(local[k]) || 0, Number(incoming[k]) || 0));
    });
    ["atlas-cfg", "atlas-vname", "atlas-challenges", "atlas-look", "atlas-sound", "atlas-login", "atlas-initials", "atlas-power"].forEach((k) => { if (incoming[k] != null && local[k] == null) out[k] = incoming[k]; });
    return out;
  }

  return {
    NAME_PTS, PIN_PTS, SPEED_PTS, PERFECT_PTS, FEVER_AFTER, FEVER_Q, FEVER_X, BONUS_CAP, RETRY_NAME, POWERS, POWER_MAX, POWER_EVERY, POWER_X, POWER_DROP, POWER_ROUND_MAX, powerKinds, pickPower, powerMilestones, JACKPOT, LUCK_CAP, MYSTERY, FREESPIN, weighted, TIMER_S, STREAK_STEP, STREAK_CAP, STREAK_MIN, BET_MAX, FIND_KM, FIND_KM_MIN, TWO_NAME, TWO_STEP, DIFFS, LEVELS, level, HINTS, GIVEAWAYS, GENERIC,
    seededRng, shuffle, fmtKm, fmtPeople, plural, pinPoints, clampMs, streakMult, hintPct, nextHintPct, isRight, findKm, findPinMult, factMult, scoreAnswer, scoreRun, answerQuality, streaksBefore, roundMax, maskPattern, compass, tellApart,
    dayKey, utcDayKey, prevDay, PROGRESS_KEYS, encodeProgress, decodeProgress, mergeProgress
  };
});

// Globe, explore, quiz (difficulty, hints, timer, bonus rounds), daily challenge, challenges,
// party games for up to 8 players, passport and achievements.
(function () {
  "use strict";
  // ---- 00-setup.js ----
// The claude.ai viewer wraps this page in its own document; make sure screen readers know the language.
if (!document.documentElement.lang) document.documentElement.lang = "en";
  const L = window.AtlasLogic;
  const { NAME_PTS, PIN_PTS, SPEED_PTS, TIMER_S, DIFFS, HINTS, seededRng, shuffle, fmtKm, plural, pinPoints, roundMax, dayKey, prevDay } = L;
  const FACTS = window.ATLAS_FACTS || {};
  const NAMES = window.ATLAS_NAMES || {};
  const INFO = window.ATLAS_INFO || {};
  const EXTRA = window.ATLAS_EXTRA || {}; // [currency names, official languages] per place
  const NEIGHBORS = new Map(); // place id -> ids of the places it borders (filled when the map loads)
  const CATS = ["Nature", "History", "Culture", "Food", "Land", "Places", "Records", "Symbols", "Myths", "Sports", "Language", "Money", "Daily life", "Heritage", "Music", "Science", "Capitals", "Arts", "Quirky", "People", "Landmarks"];
  // How each topic is named on its filter chip and in the map legend.
  const CAT_LABEL = { Symbols: "Flags & symbols", Myths: "Myths & legends", "Daily life": "Etiquette & daily life", Heritage: "World Heritage", Music: "Music & dance", Science: "Inventions & science", Capitals: "Capitals & borders", Arts: "Film & art", Quirky: "Quirky laws & records", People: "Famous people", Landmarks: "Famous landmarks" };
  const catLabel = (c) => CAT_LABEL[c] || c;
  const CONTINENTS = ["Africa", "Asia", "Europe", "North America", "South America", "Oceania", "Antarctica"];
  const ROUND = 10, DAILY_N = 5, MAX_PLAYERS = 8;
  const PLAYER_COLORS = ["var(--pc1)", "var(--pc2)", "var(--pc3)", "var(--pc4)", "var(--pc5)", "var(--pc6)", "var(--pc7)"];
  const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  // Set by the self-hosted build: no claude.ai shared database, so party games, challenges and leaderboards are hidden.
  const STANDALONE = !!window.ATLAS_STANDALONE;

  const $ = (id) => document.getElementById(id);
  const svg = d3.select("#globe");
  const wrap = $("wrap");
  const projection = d3.geoOrthographic().clipAngle(90).precision(0.4);
  const path = d3.geoPath(projection);
  const graticule = d3.geoGraticule10();

  let features = [], worldTopo = null;
  const byId = new Map();
  let base = 200, k = 1, rot = [-10, -25, 0];
  let selected = null, filter = null, mode = "explore";
  document.body.dataset.mode = mode; // setMode keeps this in step; set now for the first paint
  let quiz = null;
  // ---- 01-storage.js ----
  /* ---------- Storage (per viewer, per browser) ---------- */
  const lsGet = (key) => { try { return localStorage.getItem(key); } catch (e) { return null; } };
  // The interface is dark (Neon Night) unless the Daylight skin is chosen; set before the first paint.
  document.documentElement.dataset.theme = lsGet("atlas-look") === "daylight" ? "light" : "dark";
  const lsSet = (key, v) => { try { localStorage.setItem(key, v); } catch (e) {} };
  const lsJSON = (key, fallback) => { try { const v = JSON.parse(lsGet(key) || "null"); return v == null ? fallback : v; } catch (e) { return fallback; } };
  const lsSaveJSON = (key, v) => lsSet(key, JSON.stringify(v));
  const seen = new Set(lsJSON("atlas-seen", []));
  const saveSeen = () => lsSaveJSON("atlas-seen", [...seen]);
  // ---- 02-helpers.js ----
  /* ---------- Helpers ---------- */
  const inQuiz = () => mode === "quiz" || mode === "versus" || mode === "daily";
  const nameOf = (f) => NAMES[f.id] || f.properties.name;
  const factsOf = (id) => FACTS[id] || [];
  const withFacts = () => features.filter((f) => factsOf(f.id).length);
  const inTopic = (f) => !filter || factsOf(f.id).some((x) => x[0] === filter);
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  // Links to the exact version of the article each fact was checked against, when known.
  const srcLink = (title, rev) => {
    const t = encodeURIComponent(title.replace(/ /g, "_"));
    const href = Number.isInteger(rev) ? `https://en.wikipedia.org/w/index.php?title=${t}&oldid=${rev}` : `https://en.wikipedia.org/wiki/${t}`;
    const note = Number.isInteger(rev) ? " title=\"Opens the version of the article this fact was checked against (November 2026)\"" : "";
    return `<a class="src" href="${href}" target="_blank" rel="noopener"${note}>Source: Wikipedia, ${esc(title)} ↗</a>`;
  };
  // Typed answers: accents, "St." and "the" don't matter, and common other names count too.
  const simpleName = (v) => String(v || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
    .replace(/[’']/g, "'").replace(/\bst\.?\s/g, "saint ").replace(/^the\s+/, "").replace(/\s*&\s*/g, " and ").replace(/[.\s]+/g, " ").trim();
  const ALIASES = {
    "ivory coast": "384", "cape verde": "132", "czech republic": "203", "swaziland": "748", "burma": "104", "east timor": "626",
    "holland": "528", "uk": "826", "great britain": "826", "britain": "826", "usa": "840", "us": "840", "united states of america": "840",
    "turkiye": "792", "vatican": "336", "holy see": "336", "democratic republic of the congo": "180", "drc": "180", "congo-kinshasa": "180",
    "congo-brazzaville": "178", "macao": "446", "federated states of micronesia": "583", "uae": "784", "bosnia": "070",
    "state of palestine": "275", "dprk": "408", "republic of korea": "410", "falklands": "238", "south georgia": "239",
    "saint helena": "654", "ascension island": "654", "christmas island": "IndianOceanTer", "cocos islands": "IndianOceanTer",
    "bonaire": "535", "saba": "535", "sint eustatius": "535", "french guyana": "254", "reunion island": "638",
    "faroes": "234", "aland islands": "248", "timor": "626", "trinidad": "780", "kirghizia": "417", "byelorussia": "112"
  };
  const findByName = (v) => {
    v = simpleName(v);
    if (!v) return null;
    return features.find((x) => simpleName(nameOf(x)) === v) || features.find((x) => simpleName(x.properties.name) === v)
      || (ALIASES[v] && byId.get(ALIASES[v])) || null;
  };
  // Screen readers: speak short updates (pin placed, results) through one polite live region.
  let announceTimer = null;
  const plainText = (html) => String(html).replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"');
  function announce(text, delay = 60) {
    clearTimeout(announceTimer);
    announceTimer = setTimeout(() => { const el = $("sr"); if (!el) return; el.textContent = ""; requestAnimationFrame(() => { el.textContent = text; }); }, delay);
  }
  // Country center points never change, so compute each once.
  const centroidCache = new Map();
  const centroidOf = (f) => { let c = centroidCache.get(f); if (!c) { c = d3.geoCentroid(f); centroidCache.set(f, c); } return c; };
  function fmtCoord(lon, lat) {
    const dm = (v) => { const a = Math.abs(v); const d = Math.floor(a); const m = Math.round((a - d) * 60); return m === 60 ? `${d + 1}°00′` : `${d}°${String(m).padStart(2, "0")}′`; };
    return `${dm(lat)}${lat >= 0 ? "N" : "S"}  ${dm(lon)}${lon >= 0 ? "E" : "W"}`;
  }
  const info = (id) => { const r = INFO[id]; return r ? { a2: r[0], cap: r[1], area: r[2], pop: r[3], cont: r[4] } : null; };
  // Places whose flag emoji shows their parent country's flag (officially, or on most devices).
  const FLAG_AS = { MF: "FR", BL: "FR", GF: "FR", GP: "FR", MQ: "FR", RE: "FR", YT: "FR", PM: "FR", WF: "FR", BQ: "NL", SJ: "NO", BV: "NO", UM: "US", HM: "AU" };
  const flagKey = (a2) => FLAG_AS[a2] || a2;
  const flagOf = (a2) => (a2 && /^[A-Z]{2}$/.test(a2) ? String.fromCodePoint(...[...a2].map((c) => 0x1F1E6 + c.charCodeAt(0) - 65)) : "");
  function fmtPop(n) {
    if (!n) return "";
    if (n >= 1e9) return `${(n / 1e9).toFixed(2)} billion`;
    if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)} million`;
    return Math.round(n).toLocaleString("en-US");
  }

  // Shared games and challenges store each question's answer scrambled with the game code, so it
  // isn't sitting in plain sight in the shared data. (Anyone determined can still unscramble it in the
  // browser's developer tools; this keeps casual peeking out.) Older games with a plain "a" still load.
  function scramble(str, key) {
    let out = "";
    for (let i = 0; i < str.length; i++) out += String.fromCharCode(str.charCodeAt(i) ^ key.charCodeAt(i % key.length) ^ 0x5a);
    return out;
  }
  const hideAnswers = (qs, code) => qs.map(({ a, ...q }) => ({ ...q, x: btoa(scramble(String(a), `atlas:${code}`)) }));
  const showAnswers = (qs, code) => qs.map((q) => {
    if (!q || q.a != null || typeof q.x !== "string") return q;
    try { const { x, ...rest } = q; return { ...rest, a: scramble(atob(x), `atlas:${code}`) }; } catch (e) { return q; }
  });
  // ---- 10-globe.js ----
  /* ---------- Globe ---------- */
  function size() {
    const r = wrap.getBoundingClientRect();
    base = Math.max(120, Math.min(r.width, r.height) / 2 - 10);
    projection.translate([r.width / 2, r.height / 2]);
    // Clip everything to the visible area so deep zoom doesn't draw coastlines far off screen.
    projection.clipExtent([[-20, -20], [r.width + 20, r.height + 20]]);
    render();
  }
  let lands = d3.select("#lands").selectAll("path");
  // Phones: while the globe moves, draw the lighter 1:110m map and cheaper curves; full detail returns when it stops.
  let landsLo = null, lowRes = false, moving = 0, settleTimer = null, rafPending = false, hydro = null;
  function setLowRes(on) {
    if (!landsLo || lowRes === on) return;
    lowRes = on;
    if (on) { const cls = new Map(); lands.each(function (d) { cls.set(String(d.id), this.getAttribute("class")); }); landsLo.attr("class", (d) => cls.get(String(d.id)) || "country has"); }
    d3.select("#lands").attr("display", on ? "none" : null);
    d3.select("#lands-lo").attr("display", on ? null : "none");
    d3.select("#hydro").attr("display", on ? "none" : null);
    if (on) d3.select("#labels").selectAll("text").remove();
    d3.select("#contglow").classed("moving", on);
    projection.precision(on ? 2 : 0.4);
  }
  // Deep zoom: past DETAIL_K the 1:10m map (small islands, detailed coasts) loads and is drawn when the
  // globe is still. Zoomed in, moving uses the 1:50m map instead of the 1:110m one so coasts stay sharp.
  // Zoomed in, only countries near the visible part of the globe are drawn: each country's reach
  // (its widest distance from its center, cached) is checked against how much of the globe is on screen.
  const reachCache = new Map();
  function reachOf(f) {
    const key = String(f.id);
    let r = reachCache.get(key);
    if (r == null) {
      const c = centroidOf(f); r = 0;
      const walk = (x) => { if (typeof x[0] === "number") { const d = d3.geoDistance(c, x); if (d > r) r = d; } else x.forEach(walk); };
      if (f.geometry) walk(f.geometry.coordinates);
      reachCache.set(key, r);
    }
    return r;
  }
  function drawLands(sel) {
    if (k < 2) { sel.attr("d", path); return; }
    const [tx, ty] = projection.translate(), half = Math.hypot(tx, ty);
    const view = Math.asin(Math.min(1, half / (base * k))), c = center();
    sel.attr("d", (f) => (d3.geoDistance(c, centroidOf(f)) < view + reachOf(f) + 0.02 ? path(f) : null));
  }
  // Streak glow, in stages: it grows fast for the first few answers in a row, changes color at the
  // milestones (orange at 3, gold at 5, white-hot at 8), adds a wide outer ring from 5, and flashes
  // when a milestone is reached.
  const HEAT = [0, 0.35, 0.55, 0.75, 0.88, 1];
  let heat = 0, heat2 = 0, burstTimer = null;
  function setHeat(streak, before = 0) {
    heat = HEAT[Math.min(streak, HEAT.length - 1)];
    heat2 = streak >= 5 ? Math.min(1, 0.55 + 0.15 * (streak - 5)) : 0;
    wrap.style.setProperty("--heat", heat.toFixed(3));
    wrap.style.setProperty("--heat2", heat2.toFixed(3));
    wrap.classList.toggle("onfire", streak >= 3);
    wrap.classList.toggle("heat-5", streak >= 5 && streak < 8);
    wrap.classList.toggle("heat-8", streak >= 8);
    // The glow starts exactly at the globe's edge (so it never tints the ocean).
    const edge = 1 / (1.12 + 0.24 * heat), pct = (x) => `${(x * 100).toFixed(2)}%`;
    d3.selectAll("#streakGrad stop").data([edge - 0.005, edge, edge + (1 - edge) * 0.45, 1]).attr("offset", pct);
    const edge2 = 1 / 1.55;
    d3.selectAll("#streakGrad2 stop").data([edge2 - 0.005, edge2, 1]).attr("offset", pct);
    if ([3, 5, 8].some((m) => before < m && streak >= m)) {
      wrap.classList.remove("burst"); void wrap.offsetWidth; wrap.classList.add("burst");
      clearTimeout(burstTimer); burstTimer = setTimeout(() => wrap.classList.remove("burst"), 1200);
    }
    render();
  }
  const MAX_K = 80, DETAIL_K = 4;
  // The 1:10m map comes in one file per continent (detail-europe.json and so on): only the continents
  // on screen are downloaded, the first time you zoom in on them.
  let extraLand = null, detail = null, geomSet = "geo50", fastDetail = false;
  const detailRegions = new Map(), extraParts = [];
  const regionOf = (f) => { const c = info(f.id)?.cont; return c ? String(c).toLowerCase().replace(/[^a-z]+/g, "-") : null; };
  function onScreen(f) {
    const [tx, ty] = projection.translate(), half = Math.hypot(tx, ty);
    const view = Math.asin(Math.min(1, half / (base * k)));
    return d3.geoDistance(center(), centroidOf(f)) < view + reachOf(f) + 0.02;
  }
  function loadDetail() {
    if (!features.length) return;
    if (moving) return;
    // The continents actually under the screen: countries whose center is in view, plus the countries
    // under a grid of points across the screen (so a big country reaching across counts only where it's seen).
    const near = features.filter(onScreen), want = new Set();
    const [w, h] = [svg.node().clientWidth || 600, svg.node().clientHeight || 600], c = center();
    const [tx, ty] = projection.translate(), view = Math.asin(Math.min(1, Math.hypot(tx, ty) / (base * k)));
    near.forEach((f) => { if (d3.geoDistance(c, centroidOf(f)) < view) want.add(regionOf(f)); });
    for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
      const pt = projection.invert([(w * i) / 4, (h * j) / 4]);
      if (!pt || d3.geoDistance(c, pt) > Math.PI / 2) continue;
      const hit = near.find((f) => d3.geoContains(f.geo50 || f.geometry, pt));
      if (hit) want.add(regionOf(hit));
    }
    want.delete(null);
    for (const r of want) {
      if (detailRegions.has(r)) continue;
      detailRegions.set(r, "loading");
      fetch(`detail-${r}.json`).then((res) => res.json()).then((t) => {
        if (!detail) { detail = new Map(); features.forEach((f) => { f.geo50 = f.geometry; f.geo10 = f.geometry; }); }
        topojson.feature(t, t.objects.countries).features.forEach((g) => detail.set(String(g.id || g.properties.name.replace(/[^A-Za-z]/g, "")), g.geometry));
        features.forEach((f) => { const g = detail.get(String(f.id)); if (g) { f.geo10 = g; if (geomSet === "geo10") f.geometry = g; } });
        if (t.objects.extras) extraParts.push(...topojson.feature(t, t.objects.extras).features);
        extraLand = extraParts.length ? { type: "FeatureCollection", features: extraParts } : null;
        detailRegions.set(r, "done");
        render();
      }).catch(() => { setTimeout(() => detailRegions.delete(r), 30000); });
    }
  }
  function useGeometry(set) {
    if (!detail || geomSet === set) return;
    geomSet = set;
    features.forEach((f) => { f.geometry = f[set]; });
  }
  function beginMove() {
    moving++; clearTimeout(settleTimer);
    if (k < 6) setLowRes(true);
    else if (!fastDetail) { fastDetail = true; projection.precision(2); d3.select("#labels").selectAll("text").remove(); }
  }
  function endMove() {
    moving = Math.max(0, moving - 1);
    clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { if (!moving) { fastDetail = false; setLowRes(false); projection.precision(0.4); draw(); } }, 150);
  }
  const center = () => [-rot[0], -rot[1]];
  const onFront = (p) => d3.geoDistance(p, center()) < Math.PI / 2 - 0.01;
  // Many events can ask for a redraw within one frame; draw at most once per frame.
  function render() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => { rafPending = false; draw(); });
  }
  function draw() {
    projection.scale(base * k).rotate(rot);
    const [tx, ty] = projection.translate();
    d3.select("#halo").attr("cx", tx).attr("cy", ty).attr("r", base * k * 1.09);
    d3.select("#streakhalo").attr("cx", tx).attr("cy", ty).attr("r", base * k * (1.12 + 0.24 * heat));
    d3.select("#streakhalo2").attr("cx", tx).attr("cy", ty).attr("r", base * k * 1.55);
    d3.select("#ocean").attr("d", path({ type: "Sphere" }));
    d3.select("#grat").attr("d", path(graticule));
    if (k >= 3 && !flying) loadDetail(); // not mid-flight: only where the globe comes to rest
    useGeometry(!lowRes && !fastDetail && k >= DETAIL_K ? "geo10" : "geo50");
    drawLands(lowRes ? landsLo : lands);
    d3.select("#extras").attr("d", extraLand && geomSet === "geo10" ? path(extraLand) : null);
    if (hydro && !lowRes) { d3.select("#lakes").attr("d", path(hydro.lakes)); d3.select("#rivers").attr("d", path(hydro.rivers)); }
    if (!lowRes && !fastDetail) drawLabels();
    const glow = inQuiz() && quiz && !quiz.revealed && quiz.contGlow;
    d3.select("#contglow").attr("d", glow ? path(glow) : null);
    const lens = inQuiz() && quiz && !quiz.revealed && quiz.lens;
    d3.select("#lensglow").attr("d", lens ? path(lens) : null);
    const sc = inQuiz() && quiz && !quiz.revealed && quiz.scatter && !quiz.scatter.got ? quiz.scatter.p : null;
    if (sc && onFront(sc)) { const p = projection(sc); d3.select("#scatter").attr("transform", `translate(${p[0]},${p[1]})`).attr("display", null); }
    else d3.select("#scatter").attr("display", "none");
    const pinEl = d3.select("#pin"), pt = inQuiz() && quiz ? quiz.pin : null;
    if (pt && onFront(pt)) { const p = projection(pt); pinEl.attr("cx", p[0]).attr("cy", p[1]).attr("display", null); }
    else pinEl.attr("display", "none");
    const pf = d3.select("#perfect");
    if (pt && quiz.perfect && onFront(pt)) {
      const p = projection(pt); pf.attr("display", null).attr("transform", `translate(${p[0]},${p[1]})`);
      perfectFollow(p); // the +10 and the flash stay on the pin while the globe flies in
    }
    else pf.attr("display", "none");
    drawFlight();
    drawOthers();
    drawRevealLabels();
  }
  // Country names appear as you zoom in, in Explore and Passport only (never in a quiz).
  function drawLabels() {
    const show = (mode === "explore" || mode === "passport") && k >= 1.7 && features.length;
    const placed = [], data = [];
    if (show) {
      const cands = [];
      for (const f of features) {
        const c = centroidOf(f);
        if (!onFront(c)) continue;
        const a = path.area(f);
        if (a > 1800) cands.push([f, c, a]);
      }
      cands.sort((x, y) => y[2] - x[2]);
      for (const [f, c, a] of cands) {
        const [x, y] = projection(c), name = nameOf(f), fs = Math.max(9, Math.min(13, Math.sqrt(a) / 9));
        const w = name.length * fs * 0.56 + 6, h = fs + 4;
        if (placed.some((b) => Math.abs(b.x - x) * 2 < b.w + w && Math.abs(b.y - y) * 2 < b.h + h)) continue;
        placed.push({ x, y, w, h });
        data.push({ id: f.id, name, x, y, fs });
        if (data.length >= 70) break;
      }
    }
    d3.select("#labels").selectAll("text").data(data, (d) => d.id).join("text")
      .attr("class", "maplabel").attr("x", (d) => d.x).attr("y", (d) => d.y + d.fs / 3)
      .style("font-size", (d) => `${d.fs}px`).text((d) => d.name);
  }
  const partial = (line, t) => {
    const interp = d3.geoInterpolate(line[0], line[1]), steps = Math.max(2, Math.ceil(64 * t));
    return { type: "LineString", coordinates: d3.range(steps + 1).map((i) => interp((i / steps) * t)) };
  };
  // The player's route from pin to answer, drawn up to quiz.lineT (0 to 1), with a plane at its head.
  function drawFlight() {
    const lineEl = d3.select("#pinline"), plane = d3.select("#plane"), dist = d3.select("#dist"), ring = d3.select("#ring");
    const active = inQuiz() && quiz && quiz.revealed;
    if (!active) { lineEl.attr("d", null); plane.attr("display", "none"); dist.attr("display", "none"); ring.attr("display", "none"); return; }
    const t = quiz.lineT ?? 1;
    if (quiz.line) {
      lineEl.attr("d", path(partial(quiz.line, t)));
      const interp = d3.geoInterpolate(quiz.line[0], quiz.line[1]), head = interp(t), prev = interp(Math.max(0, t - 0.02));
      if (t > 0 && t < 1 && onFront(head)) {
        const a = projection(prev), b = projection(head);
        plane.attr("display", null).attr("transform", `translate(${b[0]},${b[1]}) rotate(${Math.atan2(b[1] - a[1], b[0] - a[0]) * 180 / Math.PI + 90})`);
      } else plane.attr("display", "none");
    } else { lineEl.attr("d", null); plane.attr("display", "none"); }
    const c = centroidOf(quiz.answer);
    if (t >= 1 && onFront(c)) {
      const p = projection(c);
      const label = quiz.km === 0 ? "Pin inside — bullseye" : `${fmtKm(quiz.km)} away`;
      const w = label.length * 7 + 22;
      d3.select("#dist-text").text(label).attr("x", w / 2);
      d3.select("#dist-bg").attr("width", w);
      dist.attr("display", null).attr("transform", `translate(${p[0] - w / 2},${p[1] - 46})`);
      ring.attr("display", null).attr("cx", p[0]).attr("cy", p[1]);
    } else { dist.attr("display", "none"); ring.attr("display", "none"); }
  }
  // Other players' pins and routes after a party reveal.
  function drawOthers() {
    const data = inQuiz() && quiz && quiz.revealed && quiz.others ? quiz.others : [];
    const c = quiz && quiz.answer ? centroidOf(quiz.answer) : null, t = quiz ? quiz.lineT ?? 1 : 1;
    const g = d3.select("#others").attr("class", "others").selectAll("g.o").data(data, (d) => d.pid);
    const ge = g.enter().append("g").attr("class", "o");
    ge.append("path").attr("class", "oline");
    ge.append("circle").attr("class", "opin").attr("r", 6);
    g.exit().remove();
    const all = ge.merge(g);
    all.select("path.oline").attr("stroke", (d) => d.color).attr("d", (d) => (c && d.km > 0 ? path(partial([d.pin, c], t)) : null));
    all.select("circle.opin").attr("fill", (d) => d.color).each(function (d) {
      const el = d3.select(this);
      if (onFront(d.pin)) { const p = projection(d.pin); el.attr("cx", p[0]).attr("cy", p[1]).attr("display", null); }
      else el.attr("display", "none");
    });
  }
  // The perfect-answer shockwave: rings at the pin (kept in place by render), a white-hot flash of the
  // country, and the PERFECT stamp, cleared after a few seconds or on the next question.
  let perfectTimer = null;
  function perfectFollow(p) {
    const wr = wrap.getBoundingClientRect(), sr = svg.node().getBoundingClientRect();
    const x = `${p[0] + sr.left - wr.left}px`, y = `${p[1] + sr.top - wr.top}px`;
    $("perfectplus").style.setProperty("--sx", x); $("perfectplus").style.setProperty("--sy", y);
    $("perfectflash").style.setProperty("--fx", x); $("perfectflash").style.setProperty("--fy", y);
  }
  function playPerfect(f) {
    clearPerfect();
    quiz.perfect = true;
    const g = d3.select("#perfect").classed("go", false);
    render();
    void wrap.offsetWidth; // restart the ring animation
    g.classed("go", true);
    lands.classed("perfect", (x) => x.id === f.id);
    const st = $("perfectstamp"); st.classList.remove("out"); st.hidden = false;
    // Where the pin is on screen (the flash centers on it and the +10 bursts from it), and where the
    // +10 flies to: the bonus badge under the stamp.
    const wr = wrap.getBoundingClientRect(), sr = svg.node().getBoundingClientRect();
    const p = quiz.pin && onFront(quiz.pin) ? projection(quiz.pin) : [sr.width / 2, sr.height / 2];
    const sx = p[0] + sr.left - wr.left, sy = p[1] + sr.top - wr.top;
    const fl = $("perfectflash"); fl.style.setProperty("--fx", `${sx}px`); fl.style.setProperty("--fy", `${sy}px`);
    fl.classList.remove("go"); svg.classed("jolt", false);
    const plus = $("perfectplus"); plus.hidden = true;
    void wrap.offsetWidth;
    fl.classList.add("go"); svg.classed("jolt", true);
    const br = st.querySelector(".perfectbadge").getBoundingClientRect();
    plus.style.setProperty("--sx", `${sx}px`); plus.style.setProperty("--sy", `${sy}px`);
    plus.style.setProperty("--tx", `${br.left - wr.left + 40}px`); plus.style.setProperty("--ty", `${br.top - wr.top + 14}px`);
    plus.hidden = false;
    perfectTimer = setTimeout(() => {
      lands.classed("perfect", false);
      st.classList.add("out");
      perfectTimer = setTimeout(() => { st.hidden = true; st.classList.remove("out"); plus.hidden = true; }, 400);
    }, 4400);
  }
  function clearPerfect() {
    clearTimeout(perfectTimer);
    if (quiz) quiz.perfect = false;
    d3.select("#perfect").classed("go", false).attr("display", "none");
    if (lands) lands.classed("perfect", false);
    $("perfectstamp").hidden = true; $("perfectstamp").classList.remove("out");
    $("perfectplus").hidden = true; $("perfectflash").classList.remove("go"); svg.classed("jolt", false);
  }
  function paintClasses() {
    const wrongId = inQuiz() && quiz && quiz.revealed && quiz.choice && quiz.choice !== quiz.answer ? quiz.choice.id : null;
    const stamps = mode === "passport" ? getStamps() : null;
    lands
      .classed("faded", (f) => mode !== "passport" && !!filter && !inTopic(f))
      .classed("unstamped", (f) => !!stamps && !stamps[f.id])
      .classed("wrong", (f) => f.id === wrongId)
      .classed("sel", (f) => !!selected && f.id === selected.id);
    wrap.classList.toggle("revealed", !!(inQuiz() && quiz && quiz.revealed));
    $("legend").hidden = !(mode !== "passport" && filter);
    if (filter) $("legend-topic").textContent = `Has a fact about ${catLabel(filter).toLowerCase()}`;
    $("legend-passport").hidden = mode !== "passport";
  }

  // Rotation, zoom and pinch share one d3.zoom behaviour; translation deltas spin the globe.
  let prevT = d3.zoomIdentity, dragMoved = false, lastAnchor = null, drag = null, spinRaf = null;
  // The coast after a flick: keep turning at the release speed, slowing each frame.
  function spin(v) {
    let last = performance.now();
    const step = (now) => {
      const dt = Math.min(48, now - last); last = now;
      rot = [rot[0] + v[0] * dt, Math.max(-90, Math.min(90, rot[1] + v[1] * dt)), 0];
      v = [v[0] * Math.pow(0.94, dt / 16), v[1] * Math.pow(0.94, dt / 16)];
      render();
      if (Math.hypot(v[0], v[1]) > 0.004) spinRaf = requestAnimationFrame(step); else { spinRaf = null; endMove(); }
    };
    spinRaf = requestAnimationFrame(step);
  }
  function stopSpin() { if (spinRaf) { cancelAnimationFrame(spinRaf); spinRaf = null; endMove(); } }
  const zoom = d3.zoom()
    .scaleExtent([0.85, MAX_K])
    // The light map goes in on the first real movement, not on press, so a plain click still lands on
    // the full map (and its countries can be clicked).
    .on("start", () => { $("tip").hidden = true; lastAnchor = null; stopSpin(); drag = null; })
    .on("end", () => {
      lastAnchor = null;
      // A flick: if the finger was still moving when it lifted, the globe keeps turning and slows.
      const v = drag && performance.now() - drag.t < 80 ? drag.v : null;
      drag = null;
      if (dragMoved) { dragMoved = false; if (v && Math.hypot(v[0], v[1]) > 0.04 && !reduce) spin(v); else endMove(); }
    })
    .on("zoom", (ev) => {
      const t = ev.transform, src = ev.sourceEvent;
      // Any real movement (a drag, a wheel, or a flight) draws with the light map; a plain click
      // never gets here, so it still lands on the full map.
      if (!dragMoved) { dragMoved = true; beginMove(); }
      const anchor = src ? anchorOf(src) : null;
      if (src && (t.k !== prevT.k || (anchor && anchor.fingers >= 2))) {
        // A pinch or wheel: the place under the fingers (or the cursor) stays under them while the
        // zoom changes, and two fingers moving together pan the globe. Without an anchor on the globe,
        // zoom about the middle.
        const from = lastAnchor || anchor, k0 = k;
        k = t.k;
        if (anchor && from) keepUnder(from.xy, anchor.xy, k0);
        lastAnchor = anchor;
      } else if (src && src.type !== "wheel") {
        // One finger (or the mouse): drag to spin.
        const degPerPx = 180 / (Math.PI * base * t.k), dx = (t.x - prevT.x) * degPerPx, dy = -(t.y - prevT.y) * degPerPx;
        rot = [rot[0] + dx, Math.max(-90, Math.min(90, rot[1] + dy)), 0];
        // Track the drag's speed (degrees per millisecond, smoothed) for a flick on release.
        const now = performance.now(), dt = drag ? Math.max(1, now - drag.t) : 16, v = [dx / dt, dy / dt];
        drag = { t: now, v: drag ? [drag.v[0] * 0.5 + v[0] * 0.5, drag.v[1] * 0.5 + v[1] * 0.5] : v };
      }
      prevT = t; k = t.k;
      render();
    });
  // Where a gesture is aimed, in the globe's own coordinates: the midpoint of two fingers, one
  // finger, or the mouse. fingers counts the touches.
  function anchorOf(src) {
    const node = svg.node(), ts = src.touches;
    if (ts && ts.length >= 2) { const a = d3.pointer(ts[0], node), b = d3.pointer(ts[1], node); return { xy: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], fingers: 2 }; }
    if (ts && ts.length === 1) return { xy: d3.pointer(ts[0], node), fingers: 1 };
    if (Number.isFinite(src.clientX)) return { xy: d3.pointer(src, node), fingers: 0 };
    return null;
  }
  // Turn the globe so the place that was under screen point `from` (at zoom k0) now sits under `to`.
  function keepUnder(from, to, k0) {
    projection.scale(base * k0).rotate(rot);
    const geo = projection.invert(from);
    if (!geo || !Number.isFinite(geo[0]) || d3.geoDistance(geo, center()) > Math.PI / 2 - 0.05) return;
    projection.scale(base * k);
    for (let i = 0; i < 3; i++) {
      projection.rotate(rot);
      const p = projection(geo);
      if (!p) return;
      const degPerPx = 180 / (Math.PI * base * k);
      rot = [rot[0] + (to[0] - p[0]) * degPerPx, Math.max(-90, Math.min(90, rot[1] - (to[1] - p[1]) * degPerPx)), 0];
    }
  }
  svg.call(zoom).on("dblclick.zoom", null);
  // Double-tap (or double-click) zooms in 2× on that spot, except where a tap drops a pin.
  svg.on("dblclick.zoomin", (ev) => {
    if (canPin()) return;
    ev.preventDefault();
    const pt = d3.pointer(ev, svg.node()), k0 = k, k1 = Math.min(MAX_K, k * 2);
    if (k1 === k0) return;
    svg.call(zoom.transform, d3.zoomIdentity.translate(prevT.x, prevT.y).scale(k1));
    keepUnder(pt, pt, k0);
    render();
  });
  if (window.ATLAS_TEST) window.__view = () => ({ lon: -rot[0], lat: -rot[1], k });
  if (window.ATLAS_TEST) window.__geoAt = (cx, cy) => { const r = svg.node().getBoundingClientRect(); projection.scale(base * k).rotate(rot); return projection.invert(d3.pointer({ clientX: cx, clientY: cy }, svg.node())); };
  const canPin = () => inQuiz() && quiz && !quiz.holding && !quiz.revealed && !quiz.locked && !quiz.done && !$("quiz-view").hidden && !$("qplay").hidden;
  svg.on("click.pin", (ev) => {
    if (!canPin()) return;
    if (scatterHit(d3.pointer(ev, svg.node()))) return; // a golden landmark, not a pin
    const p = projection.invert(d3.pointer(ev, svg.node()));
    if (!p || Number.isNaN(p[0]) || d3.geoDistance(p, center()) > Math.PI / 2) return;
    dropPin(p);
  });
  // Keyboard: arrow keys move the pin (Shift for bigger steps).
  svg.on("keydown", (ev) => {
    const dirs = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1] };
    if (!dirs[ev.key] || !canPin()) return;
    ev.preventDefault();
    const step = (ev.shiftKey ? 5 : 1) * 2 / k, [dx, dy] = dirs[ev.key];
    const p = quiz.pin ? quiz.pin.slice() : center();
    p[0] = ((p[0] + dx * step + 540) % 360) - 180;
    p[1] = Math.max(-89, Math.min(89, p[1] + dy * step));
    dropPin(p);
    if (!onFront(p)) flyToPoint(p, k, { duration: 300, dip: 0 });
  });
  const setK = (nk) => svg.call(zoom.transform, d3.zoomIdentity.translate(prevT.x, prevT.y).scale(nk));
  $("zin").onclick = () => setK(Math.min(MAX_K, k * 1.8));
  $("zout").onclick = () => setK(Math.max(0.85, k / 1.8));

  function targetZoom(f, cap = 3.2) {
    const [[x0, y0], [x1, y1]] = d3.geoBounds(f);
    let dLon = x1 - x0; if (dLon < 0) dLon += 360;
    const midLat = (y0 + y1) / 2;
    const extent = Math.max(dLon * Math.cos(midLat * Math.PI / 180), y1 - y0, 0.5);
    return Math.max(1, Math.min(cap, 26 / extent));
  }
  // Tiny places (under TINY_AREA km²) are specks at a normal zoom, and an archipelago's middle can be
  // open sea, so the globe flies to the main island instead, close enough to see its coastline.
  const TINY_AREA = 5000, TINY_K = 32;
  function mainIsland(f) {
    const g = f.geometry, polys = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    let best = null, bestA = -1;
    // The biggest island, by the size of its outline's bounding box.
    polys.forEach((p) => {
      const [[x0, y0], [x1, y1]] = d3.geoBounds({ type: "LineString", coordinates: p[0] });
      let dx = x1 - x0; if (dx < 0) dx += 360;
      const a = dx * Math.cos(((y0 + y1) / 2) * Math.PI / 180) * (y1 - y0);
      if (a > bestA) { bestA = a; best = p; }
    });
    return best ? { type: "LineString", coordinates: best[0] } : null;
  }
  function flyTo(f, kTarget, opts) {
    const area = info(f.id)?.area;
    const m = Number.isFinite(area) && area < TINY_AREA ? mainIsland(f) : null;
    if (m) return flyToPoint(d3.geoCentroid(m), Math.min(MAX_K, Math.max(kTarget ?? 1, targetZoom(m, TINY_K))), opts);
    flyToPoint(centroidOf(f), kTarget ?? targetZoom(f), opts);
  }
  function flyToPoint([lon, lat], k1, opts = {}) {
    const r0 = rot.slice(), k0 = k;
    let dl = (-lon - r0[0]) % 360; if (dl > 180) dl -= 360; if (dl < -180) dl += 360;
    const r1 = [r0[0] + dl, -lat, 0];
    if (reduce) { rot = r1; opts.onTick?.(1); setK(k1); render(); opts.onEnd?.(); return; }
    const dip = opts.dip ?? 0.25;
    flying = true;
    d3.transition("fly").duration(opts.duration ?? 1100).ease(d3.easeCubicInOut)
      .tween("fly", () => (t) => {
        rot = [r0[0] + (r1[0] - r0[0]) * t, r0[1] + (r1[1] - r0[1]) * t, 0];
        opts.onTick?.(t);
        setK(Math.max(0.85, k0 + (k1 - k0) * t - Math.sin(Math.PI * t) * Math.min(k0, k1) * dip));
      })
      .on("interrupt", () => { flying = false; render(); })
      .on("end", () => { flying = false; render(); opts.onEnd?.(); });
  }
  let flying = false;
  function zoomOut() {
    if (k <= 1.05) return;
    if (reduce) { setK(1); return; }
    const k0 = k;
    d3.transition("fly").duration(600).ease(d3.easeCubicOut).tween("out", () => (t) => setK(k0 + (1 - k0) * t));
  }

  // One outline around every country on a continent (inner borders dissolved), for the continent hint.
  const contOutlines = new Map();
  function continentOutline(cont) {
    if (!worldTopo || !cont) return null;
    if (!contOutlines.has(cont)) {
      const geoms = worldTopo.objects.countries.geometries.filter((g, i) => info(features[i].id)?.cont === cont);
      contOutlines.set(cont, geoms.length ? topojson.merge(worldTopo, geoms) : null);
    }
    return contOutlines.get(cont);
  }

  // After an answer is revealed, name the right country (orange) and, if different, your pick (red)
  // on the map, just below each country. If the two names would overlap, they move apart.
  const SHOW_REVEAL_NAMES = true;
  function drawRevealLabels() {
    const show = SHOW_REVEAL_NAMES && inQuiz() && quiz && quiz.revealed && quiz.answer;
    const items = [];
    if (show) {
      items.push({ f: quiz.answer, cls: "right" });
      if (quiz.choice && quiz.choice !== quiz.answer) items.push({ f: quiz.choice, cls: "wrong" });
    }
    const placed = items.map((it) => {
      const c = centroidOf(it.f);
      if (!onFront(c)) return null;
      const [x, y] = projection(c);
      // Just below the country's outline so the name sits on the sea, not on the colored country;
      // big countries that fill most of the view keep it under their center instead.
      const [, [, by1]] = path.bounds(it.f), [, ty] = projection.translate(), viewH = ty * 2;
      const below = by1 + 18;
      const ly = Number.isFinite(by1) && below < viewH - 10 && below - y < viewH * 0.45 ? below : y + 28;
      return { ...it, x, y: ly, name: nameOf(it.f) };
    }).filter(Boolean);
    if (placed.length === 2) {
      const [a, b] = placed, w = (a.name.length + b.name.length) * 4.2;
      if (Math.abs(a.x - b.x) < w && Math.abs(a.y - b.y) < 20) {
        const up = a.y <= b.y ? a : b, down = up === a ? b : a;
        up.y -= 10; down.y = up.y + 20;
      }
    }
    d3.select("#revlabels").selectAll("text").data(placed, (d) => d.cls)
      .join("text").attr("class", (d) => `revlabel ${d.cls}`)
      .attr("x", (d) => d.x).attr("y", (d) => d.y).text((d) => d.name);
  }
  // ---- 15-sound.js ----
  /* ---------- Sound and vibration (off by default) ---------- */
  // Short synthesized sounds, so there are no audio files to load: a click for a pin, a chime for a
  // right answer, a low thud for a wrong one and a rising run for a streak. Phones also buzz gently.
  let soundOn = lsGet("atlas-sound") === "on", audio = null;
  function tone(freq, start, dur, { type = "sine", gain = 0.18, to = null } = {}) {
    const t0 = audio.currentTime + start, osc = audio.createOscillator(), amp = audio.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    amp.gain.setValueAtTime(0.0001, t0);
    amp.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(amp).connect(audio.destination);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }
  const SOUNDS = {
    pin: () => tone(880, 0, 0.07, { type: "triangle", gain: 0.12, to: 660 }),
    lock: () => tone(520, 0, 0.09, { type: "triangle", gain: 0.12 }),
    right: () => { tone(784, 0, 0.18); tone(1175, 0.09, 0.32); },
    wrong: () => { tone(180, 0, 0.32, { type: "sine", gain: 0.25, to: 90 }); },
    streak: () => [784, 988, 1175, 1568].forEach((f, i) => tone(f, i * 0.07, 0.22, { gain: 0.14 })),
    // A low swell under a bright rising sweep and a sparkle on top, timed with the rings.
    slot: () => { for (let i = 0; i < 14; i++) tone(500 + (i % 3) * 120, i * 0.11, 0.05, { type: "square", gain: 0.04 }); },
    jackpot: () => { [1319, 1568, 2093, 2637, 3136].forEach((f, i) => tone(f, i * 0.09, 0.35, { type: "triangle", gain: 0.1 })); for (let i = 0; i < 8; i++) tone(2400 + (i % 2) * 400, 0.5 + i * 0.07, 0.06, { gain: 0.05 }); },
    power: () => { tone(440, 0, 0.12, { type: "triangle", gain: 0.12, to: 880 }); tone(1320, 0.1, 0.25, { gain: 0.1 }); },
    fever: () => { for (let i = 0; i < 10; i++) tone(330 * Math.pow(1.12, i), i * 0.05, 0.16, { type: "sawtooth", gain: 0.05 }); [1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.55 + i * 0.08, 0.3, { gain: 0.1 })); },
    perfect: () => {
      tone(1400, 0, 0.42, { type: "sine", gain: 0.06, to: 300 }); // the fall
      tone(110, 0.45, 0.45, { type: "sawtooth", gain: 0.12, to: 40 }); // the impact
      tone(196, 0.45, 0.5, { type: "triangle", gain: 0.14, to: 392 }); tone(660, 0.47, 0.4, { gain: 0.12, to: 1320 });
      [1568, 2093, 2637].forEach((f, i) => tone(f, 0.63 + i * 0.06, 0.25, { gain: 0.08 }));
      [1047, 1568].forEach((f, i) => tone(f, 2.1 + i * 0.08, 0.3, { type: "triangle", gain: 0.1 })); // into the corner
    }
  };
  const BUZZ = { pin: 10, lock: 15, right: [20, 40, 20], wrong: [60], streak: [15, 30, 15, 30, 40], perfect: [30, 30, 15, 20, 15] };
  let lastPinSound = 0;
  function sfx(kind) {
    if (!soundOn) return;
    // Holding an arrow key moves the pin many times a second; click at most every 0.3 s.
    if (kind === "pin") { if (Date.now() - lastPinSound < 300) return; lastPinSound = Date.now(); }
    try {
      if (!audio) audio = new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === "suspended") audio.resume();
      SOUNDS[kind]?.();
    } catch (e) { /* no audio here: stay quiet */ }
    try { if (navigator.vibrate && BUZZ[kind]) navigator.vibrate(BUZZ[kind]); } catch (e) {}
  }
  function setSound(on) {
    soundOn = on;
    lsSet("atlas-sound", on ? "on" : "off");
    $("sound").setAttribute("aria-pressed", String(on));
    if (on) sfx("right");
  }
  $("sound").setAttribute("aria-pressed", String(soundOn));
  $("sound").onclick = () => setSound(!soundOn);
  // ---- 20-explore.js ----
  /* ---------- Explore ---------- */
  function updateProgress() {
    const total = withFacts().length;
    const n = [...seen].filter((id) => byId.has(id) && factsOf(id).length).length;
    $("prog").textContent = `You've explored ${n} of ${total} countries and territories`;
    $("bar").style.width = `${(n / total) * 100}%`;
  }
  function renderCard(f) {
    const r = info(f.id), card = $("card");
    if (!r) { card.hidden = true; return; }
    const rows = [];
    if (r.cap) rows.push(["Capital", r.cap]);
    if (r.pop) rows.push(["Population", `${fmtPop(r.pop)} (2023)`]);
    if (r.area) rows.push(["Area", `${Math.round(r.area).toLocaleString("en-US")} km²`]);
    if (r.cont) rows.push(["Continent", r.cont]);
    const flag = flagOf(r.a2);
    card.innerHTML = (flag ? `<span class="flag zoomflag" role="img" tabindex="0" aria-label="Flag of ${esc(nameOf(f))}">${flag}</span>` : "") + `<dl>${rows.map(([a, b]) => `<dt>${a}</dt><dd>${esc(b)}</dd>`).join("")}</dl>`;
    card.hidden = !rows.length && !flag;
  }
  function select(f, opts = {}) {
    selected = f;
    const facts = factsOf(f.id);
    if (facts.length) { seen.add(f.id); saveSeen(); }
    const [lon, lat] = centroidOf(f);
    $("tag").textContent = opts.tag || plural(facts.length, "field note");
    $("coords").textContent = fmtCoord(lon, lat);
    $("name").textContent = nameOf(f);
    renderCard(f);
    if (!opts.noFly) announce(`${nameOf(f)}. ${plural(facts.length, "field note")}.`);
    const ul = $("facts");
    ul.innerHTML = "";
    facts.forEach(([cat, text, src, rev]) => {
      const li = document.createElement("li");
      if (filter && cat === filter) li.className = "hit";
      const c = document.createElement("span"); c.className = "cat"; c.textContent = cat;
      const p = document.createElement("p"); p.textContent = text;
      li.append(c, p);
      if (src) li.insertAdjacentHTML("beforeend", srcLink(src, rev));
      ul.appendChild(li);
    });
    $("toast").textContent = "";
    updateProgress();
    paintClasses();
    if (!opts.noFly) flyTo(f);
    const h = `#c-${String(f.id).replace(/[^A-Za-z0-9-]/g, "")}`;
    if (location.hash !== h) { try { history.replaceState(null, "", h); } catch (e) { location.hash = h; } }
    if (opts.focus) $("name").scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    else if (opts.peek) peekPanel();
  }
  // Phones: the panel sits under the globe, so after a tap on the map, scroll just far enough that the
  // country's name and first notes come into view while the lit-up country stays on screen.
  function peekPanel() {
    if (!matchMedia("(max-width: 860px)").matches) return;
    const top = $("name").getBoundingClientRect().top, want = innerHeight * 0.58;
    if (top > want || top < 60) scrollBy({ top: top - want, behavior: reduce ? "auto" : "smooth" });
  }
  function surprise() {
    let pool = withFacts().filter(inTopic);
    const fresh = pool.filter((f) => !seen.has(f.id) && f !== selected);
    pool = fresh.length ? fresh : pool.filter((f) => f !== selected);
    if (pool.length) select(pool[Math.floor(Math.random() * pool.length)], { peek: true });
  }
  // ---- 30-passport.js ----
  /* ---------- Passport, review list and achievements ---------- */
  const getStamps = () => lsJSON("atlas-stamps", {});
  const getStats = () => Object.assign({ quizzes: 0, answered: 0, bullseyes: 0, partyGames: 0, partyWins: 0, hints: 0 }, lsJSON("atlas-stats", {}));
  const bumpStat = (key, by = 1) => { const s = getStats(); s[key] = (s[key] || 0) + by; lsSaveJSON("atlas-stats", s); checkSkins(); return s[key]; };
  const ACH = [
    { id: "first", title: "First stamp", desc: "Name your first country correctly." },
    { id: "bullseye", title: "Bullseye", desc: "Drop a pin inside the right country." },
    { id: "island", title: "Island hopper", desc: "Hit a bullseye on a place smaller than 1,000 km²." },
    { id: "quick", title: "Quick draw", desc: "Name the right country in under 5 seconds with the timer on." },
    { id: "perfect", title: "Perfect round", desc: "Name every country in a 10-question quiz." },
    { id: "nohints", title: "No help needed", desc: "Finish a Hard or Expert quiz with no hints, naming at least 5." },
    { id: "expert", title: "Cartographer", desc: "Finish a quiz on Expert." },
    { id: "c25", title: "Frequent flyer", desc: "Stamp 25 places." },
    { id: "c100", title: "World traveler", desc: "Stamp 100 places." },
    { id: "call", title: "Completionist", desc: "Stamp every place on the map." },
    { id: "globe", title: "Globetrotter", desc: "Stamp a place on all six inhabited continents." },
    { id: "streak7", title: "Week warrior", desc: "Keep a 7-day daily streak." },
    { id: "daily500", title: "High flyer", desc: "Score 1,000 or more on a daily." },
    { id: "host4", title: "Party host", desc: "Start a game with 4 or more players." },
    { id: "win", title: "Victory lap", desc: "Win a party game." },
    { id: "rival", title: "Rival", desc: "Finish 10 party games." }
  ];
  const toastQueue = [];
  let toastBusy = false;
  function showNextToast() {
    if (toastBusy || !toastQueue.length) return;
    toastBusy = true;
    const a = toastQueue.shift(), el = $("achtoast");
    el.innerHTML = `${esc(a.kind || "Achievement unlocked")}: <b>${esc(a.title)}</b>. ${esc(a.desc)}`;
    el.hidden = false;
    setTimeout(() => { el.hidden = true; toastBusy = false; setTimeout(showNextToast, 200); }, 4200);
  }
  function unlock(id) {
    const got = lsJSON("atlas-ach", {});
    if (got[id]) return;
    const a = ACH.find((x) => x.id === id);
    if (!a) return;
    got[id] = Date.now(); lsSaveJSON("atlas-ach", got);
    toastQueue.push(a); showNextToast();
  }
  function stamp(id) {
    const st = getStamps();
    if (!st[id]) { st[id] = Date.now(); lsSaveJSON("atlas-stamps", st); }
    const n = Object.keys(st).length, total = withFacts().length;
    unlock("first");
    if (n >= 25) unlock("c25");
    if (n >= 100) unlock("c100");
    if (n >= total) unlock("call");
    checkSet(id);
    const conts = new Set(Object.keys(st).map((x) => info(x)?.cont).filter(Boolean));
    if (["Africa", "Asia", "Europe", "North America", "South America", "Oceania"].every((c) => conts.has(c))) unlock("globe");
  }
  // Countries a viewer gets wrong come back in later solo quizzes until they get them right.
  const getReview = () => lsJSON("atlas-review", []);
  // Mix-ups: answer id -> the country you named instead, so the pair can come back together.
  const getMixups = () => lsJSON("atlas-mixups", {});
  function noteMixup(id, pickId) {
    const m = getMixups();
    if (pickId) m[id] = String(pickId); else delete m[id];
    lsSaveJSON("atlas-mixups", m);
  }
  function trackReview(id, right) {
    let r = getReview().filter((x) => x !== id);
    if (!right) r.unshift(id);
    lsSaveJSON("atlas-review", r.slice(0, 60));
  }
  function renderPassport() {
    const st = getStamps(), all = withFacts();
    const n = all.filter((f) => st[f.id]).length;
    const sets = getSets(), nSets = Object.keys(sets).length;
    $("pcount").textContent = `${n} of ${all.length} stamped${nSets ? ` · ${plural(nSets, "continent set")} complete` : ""}`;
    $("contlist").innerHTML = CONTINENTS.map((c) => {
      const list = all.filter((f) => info(f.id)?.cont === c), got = list.filter((f) => st[f.id]).length;
      const done = !!sets[c];
      return list.length ? `<div class="cont${done ? " setdone" : ""}"><span>${c}${done ? ' <b class="setbadge">Set complete ✓</b>' : ""}</span><small>${got} of ${list.length}${done ? "" : ` · finish the set for ${SET_REWARD} power-ups`}</small><div class="bar"><b style="width:${(got / list.length) * 100}%"></b></div></div>` : "";
    }).join("");
    const got = lsJSON("atlas-ach", {});
    $("achs").innerHTML = ACH.filter((a) => !(STANDALONE && ["host4", "win", "rival"].includes(a.id))).map((a) => `<li class="${got[a.id] ? "got" : ""}"><b>${esc(a.title)}</b><small>${esc(a.desc)}</small></li>`).join("");
    const s = getStats(), d = loadDaily(), best = Math.max(0, ...Object.keys(DIFFS).map((x) => Number(lsGet(`atlas-best2-${x}`) || 0)));
    const rows = [
      ["Rank", rankText()], ["Perfect answers", s.perfects || 0],
      ["Quizzes finished", s.quizzes], ["Questions answered", s.answered], ["Bullseyes", s.bullseyes],
      ["Best quiz score", best], ["Daily streak", liveStreak(d)], ["Dailies played", d.played],
      ["Party games", s.partyGames], ["Party wins", s.partyWins], ["Countries on your review list", getReview().length]
    ].filter(([label]) => !(STANDALONE && label.startsWith("Party")));
    $("stats").innerHTML = rows.map(([a, b]) => `<dt>${a}</dt><dd>${b}</dd>`).join("");
  }

  /* Progress backup: pack this browser's progress into a code, or merge one back in. */
  function progressStore() {
    const o = {};
    L.PROGRESS_KEYS.forEach((key) => { const v = lsGet(key); if (v != null) o[key] = v; });
    return o;
  }
  $("bkcopy").onclick = () => {
    const code = L.encodeProgress(progressStore()), say = (t) => { $("bkmsg").textContent = t; };
    const showCode = () => { $("bkoutwrap").hidden = false; $("bkout").value = code; $("bkout").focus(); $("bkout").select(); };
    try { navigator.clipboard.writeText(code).then(() => say("Backup code copied. Keep it somewhere safe, like a note to yourself."), () => { showCode(); say("Copy the code below and keep it somewhere safe."); }); }
    catch (e) { showCode(); say("Copy the code below and keep it somewhere safe."); }
  };
  $("bkopen").onclick = () => {
    const open = $("bkform").hidden;
    $("bkform").hidden = !open;
    $("bkopen").setAttribute("aria-expanded", String(open));
    if (open) $("bkcode").focus();
  };
  $("bkform").addEventListener("submit", (e) => {
    e.preventDefault();
    const say = (t) => { $("bkmsg").textContent = t; };
    let incoming;
    try { incoming = L.decodeProgress($("bkcode").value); } catch (err) { say(err.message); return; }
    const merged = L.mergeProgress(progressStore(), incoming);
    Object.entries(merged).forEach(([key, v]) => lsSet(key, v));
    seen.clear(); lsJSON("atlas-seen", []).forEach((id) => seen.add(id));
    $("bkcode").value = ""; $("bkform").hidden = true; $("bkopen").setAttribute("aria-expanded", "false");
    renderPassport(); paintClasses();
    say(`Progress restored. Your passport now has ${Object.keys(getStamps()).length} stamps.`);
  });
  // ---- 40-quiz.js ----
  /* ---------- Quiz core ---------- */
  const maskRegex = (f) => L.maskPattern([nameOf(f), f.properties.name], f.id);
  const maskedHTML = (text, f) => esc(text).replace(maskRegex(f), () => '<span class="blank" role="img" aria-label="hidden"></span>');
  const revealedHTML = (text, f) => esc(text).replace(maskRegex(f), (m) => `<span class="reveal">${m}</span>`);
  function distractors(f, n, rnd = Math.random) {
    const c = centroidOf(f);
    const near = withFacts().filter((x) => x !== f)
      .map((x) => [x, d3.geoDistance(c, centroidOf(x))])
      .sort((a, b) => a[1] - b[1]).slice(0, 14).map((x) => x[0]);
    return shuffle(near, rnd).slice(0, n);
  }
  // A flag round needs a flag that none of the other options share (some territories fly their parent's).
  // A place flying its parent's flag (French Guiana, Réunion…) never gets a flag round.
  function flagRoundOK(q) {
    const a2 = info(q.a)?.a2;
    if (!flagOf(a2) || FLAG_AS[a2]) return false;
    return q.o.filter((id) => flagKey(info(id)?.a2) === a2).length === 1;
  }
  // A capital round needs a capital whose name doesn't give the country away ("Mexico City", "Luxembourg").
  function capitalRoundOK(q) {
    const f = byId.get(q.a), cap = info(q.a)?.cap;
    if (!f || !cap || /[;,]/.test(cap)) return false;
    return !new RegExp(maskRegex(f).source, "u").test(cap);
  }
  // Countries that were answers in recent rounds on this browser, newest last. Normal play holds them
  // back until the rest of the world has had a turn.
  const recentAnswers = () => lsJSON("atlas-recentq", []);
  function noteRecentAnswer(id) {
    const r = recentAnswers().filter((x) => x !== String(id));
    r.push(String(id));
    lsSaveJSON("atlas-recentq", r.slice(-120));
  }
  // Pick n countries spread around the world: take them in turn from each continent (in a random
  // order), favoring countries that haven't been answers lately.
  function pickSpread(pool, n, rnd, live) {
    if (n <= 0) return [];
    const recent = live ? new Map(recentAnswers().map((id, i) => [id, i + 1])) : new Map();
    const shuffled = shuffle(pool.slice(), rnd);
    // Round-robin across continents, first among countries not used lately, then (only if needed)
    // among recent ones, oldest first.
    const spread = (list) => {
      const groups = new Map();
      list.forEach((f) => { const c = info(f.id)?.cont || "Other"; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(f); });
      const order = shuffle([...groups.keys()], rnd), out = [];
      while (order.some((c) => groups.get(c).length)) for (const c of order) { const g = groups.get(c); if (g.length) out.push(g.shift()); }
      return out;
    };
    const fresh = shuffled.filter((f) => !recent.has(String(f.id)));
    const stale = shuffled.filter((f) => recent.has(String(f.id))).sort((a, b) => recent.get(String(a.id)) - recent.get(String(b.id)));
    return spread(fresh).concat(stale).slice(0, n);
  }

  // Facts already used as clues on this browser (country:fact index), newest last, so rounds favor new ones.
  const seenFacts = new Set(lsJSON("atlas-seenfacts", []));
  function noteFactSeen(id, i) {
    const k = `${id}:${i}`;
    seenFacts.delete(k); seenFacts.add(k);
    lsSaveJSON("atlas-seenfacts", [...seenFacts].slice(-1500));
  }
  // Special rounds built from the map and country data. Each sets its own field on the question
  // (stored with it, so every player in a party game sees the same thing) and returns false if this
  // country doesn't suit it.
  const statOf = (id, k) => Number(info(id)?.[k]) || 0;
  const latOf = (id) => centroidOf(byId.get(id))[1];
  // Would this word give the answer away? Caught by the usual name masking, or sharing its first four
  // letters with the country's name ("Tajik" and Tajikistan).
  const giveaway = (text, id) => {
    const f = byId.get(id); if (!f) return false;
    const a = (x) => x.toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
    return new RegExp(maskRegex(f).source, "u").test(text) || [nameOf(f), f.properties.name].some((n) => a(n).slice(0, 4) === a(text).slice(0, 4));
  };
  function currencyUnit(id) {
    const names = (EXTRA[id] || [[]])[0];
    if (names.length !== 1) return null;
    const unit = names[0].split(/\s+/).pop().toLowerCase();
    // Only a unit that belongs to this place alone (the kyat, the riel), never a dollar or a franc.
    const others = Object.entries(EXTRA).filter(([k, v]) => k !== id && v[0].some((n) => n.split(/\s+/).pop().toLowerCase() === unit));
    return others.length || giveaway(unit, id) ? null : unit;
  }
  function uniqueLanguage(id) {
    const langs = (EXTRA[id] || [[], []])[1];
    return langs.find((l) => !Object.entries(EXTRA).some(([k, v]) => k !== id && v[1].includes(l)) && !giveaway(l, id)) || null;
  }
  // The explanation shown once a special round is answered: what the question was really about, from
  // the country data. Null for rounds whose clue already says it all (a fact) or has nothing to add.
  function roundExplanation(spec, ans) {
    const a = String(ans.id), nm = (id) => `<b>${esc(nameOf(byId.get(id)))}</b>`;
    const people = (id) => L.fmtPeople(statOf(id, "pop")) || "an unknown number of";
    const km2 = (id) => `${Math.round(statOf(id, "area")).toLocaleString("en-US")} km²`;
    const lat = (id) => { const v = latOf(id); return `${Math.round(Math.abs(v))}° ${v >= 0 ? "N" : "S"}`; };
    // How much bigger: "about 4.6 times as many" / "about 30% more".
    const by = (r, many, more) => (r >= 1.95 ? `about ${r >= 10 ? Math.round(r).toLocaleString("en-US") : r.toFixed(1)} times ${many}` : `about ${Math.max(1, Math.round((r - 1) * 100))}% ${more}`);
    if (spec.hl && statOf(a, spec.hl.k) > 0 && statOf(spec.hl.o, spec.hl.k) > 0) {
      const o = spec.hl.o, k = spec.hl.k, [big, small] = statOf(a, k) >= statOf(o, k) ? [a, o] : [o, a], r = statOf(big, k) / statOf(small, k);
      return k === "pop"
        ? { cat: "Population", html: `${nm(a)} has ${people(a)} people, and ${nm(o)} has ${people(o)}. ${nm(big)} has ${by(r, "as many", "more")}.` }
        : { cat: "Size", html: `${nm(a)} covers ${km2(a)}, and ${nm(o)} covers ${km2(o)}. ${nm(big)} is ${by(r, "the size", "bigger")}.` };
    }
    if (spec.ns) {
      const o = spec.ns, south = latOf(a) < latOf(o) ? a : o, north = south === a ? o : a;
      return { cat: "Latitude", html: `The middle of ${nm(a)} lies at about ${lat(a)}, and of ${nm(o)} at about ${lat(o)}, so ${nm(north)} is further north and ${nm(south)} further south.` };
    }
    if (spec.nb) return { cat: "Neighbors", html: `${nm(a)} is the only country that borders both ${nm(spec.nb[0])} and ${nm(spec.nb[1])}.${(NEIGHBORS.get(a) || []).length > 2 ? ` It has ${(NEIGHBORS.get(a) || []).length} neighbors in all.` : ""}` };
    if (spec.cu) { const full = (EXTRA[a] || [[]])[0][0]; return { cat: "Money", html: `The ${esc(spec.cu)} is the currency of ${nm(a)}${full ? `: its full name is the ${esc(full)}` : ""}.` }; }
    if (spec.lg) { const all = (EXTRA[a] || [[], []])[1] || []; return { cat: "Language", html: `${esc(spec.lg)} is an official language of ${nm(a)}.${all.length > 1 ? ` Its official languages are ${esc(all.join(", "))}.` : ""}` }; }
    if (spec.cp && info(a)?.cap) return { cat: "Capitals", html: `${esc(info(a).cap)} is the capital of ${nm(a)}, home to ${people(a)} people in all.` };
    return null;
  }
  const makeRound = {
    fi: (q) => { q.fi = 1; return true; },
    hl: (q, rnd) => {
      const k = rnd() < 0.5 ? "pop" : "area";
      const other = q.o.find((id) => id !== q.a && statOf(id, k) > 0 && statOf(q.a, k) > 0 && Math.abs(Math.log(statOf(id, k) / statOf(q.a, k))) > 0.15);
      if (!other) return false;
      q.hl = { k, o: other, more: statOf(q.a, k) > statOf(other, k) ? 1 : 0 };
      q.o = [q.a, other].sort();
      return true;
    },
    ns: (q) => {
      const other = q.o.find((id) => id !== q.a && Math.abs(latOf(id) - latOf(q.a)) >= 3);
      if (!other) return false;
      q.ns = other; q.o = [q.a, other].sort();
      return true;
    },
    nb: (q, rnd) => {
      const mine = NEIGHBORS.get(q.a) || [];
      for (const x of shuffle(mine.slice(), rnd)) for (const y of mine) {
        if (x >= y || !byId.has(x) || !byId.has(y)) continue;
        const common = (NEIGHBORS.get(x) || []).filter((z) => (NEIGHBORS.get(y) || []).includes(z));
        if (common.length !== 1) continue;
        const decoys = [...new Set([...(NEIGHBORS.get(x) || []), ...(NEIGHBORS.get(y) || [])])].filter((z) => z !== q.a && z !== x && z !== y && byId.has(z) && factsOf(z).length);
        if (decoys.length < 3) continue;
        q.nb = [x, y]; q.o = shuffle([q.a, ...shuffle(decoys, rnd).slice(0, 3)], rnd);
        return true;
      }
      return false;
    },
    cu: (q) => { const u = currencyUnit(q.a); if (!u) return false; q.cu = u; return true; },
    lg: (q) => { const l = uniqueLanguage(q.a); if (!l) return false; q.lg = l; return true; }
  };
  const ROUND_NAMES = { s: "Shape round", fl: "Flag round", cp: "Capital round", fi: "Find it", hl: "Higher or lower", nb: "Neighbors", ns: "North or south", cu: "Currency round", lg: "Language round" };
  const roundKind = (spec) => Object.keys(ROUND_NAMES).find((k) => spec[k]);
  // What scoring needs to know about a question besides the answer: its round type, the country's size
  // for Find it, and how tricky the fact is (spec.d, set when the round is built).
  const answerExtras = (spec) => ({ findIt: !!spec.fi, two: !!(spec.hl || spec.ns), size: spec.fi ? info(spec.a)?.area || 0 : 0, fd: Number.isFinite(spec.d) ? spec.d : 1,
    mm: Number.isFinite(spec.mm) ? spec.mm : 1, fsm: Number.isFinite(spec.fsm) ? spec.fsm : 1, jp: !!spec.jp });
  const maxFor = (cfg, qs, n) => roundMax(cfg, n, qs.slice(0, n).map(answerExtras));
  // Preset questions: {a: answer id, f: fact index, o: option ids, s: shape round, fl: flag round,
  // cp: capital round, r: from the review list}.
  // Which countries a level asks about (logic.js LEVELS): well-known ones on Easy, no tiny territories
  // on Medium, everything on Hard; Expert leans toward small places.
  const famous = (f) => { const i = info(f.id); return !!i && (i.pop >= 10e6 || i.area >= 500000); };
  const notTiny = (f) => { const i = info(f.id); return !!i && i.pop >= 300000; };
  const smallPlace = (f) => { const i = info(f.id); return !!i && (i.pop < 3e6 || i.area < 30000); };
  // Wrong choices for a level: from other continents (Easy, well-known names), the same continent
  // (Medium), or the nearest countries (Hard and Expert, and whenever no level is given).
  function wrongFor(f, n, rnd = Math.random, diff) {
    const how = diff ? L.level(diff).wrong : "near", cont = info(f.id)?.cont;
    const others = withFacts().filter((x) => x !== f && info(x.id)?.cont);
    if (how === "continent") {
      const same = others.filter((x) => info(x.id).cont === cont);
      if (same.length >= n) return shuffle(same, rnd).slice(0, n);
    }
    if (how === "far") {
      const far = others.filter((x) => info(x.id).cont !== cont && info(x.id).cont !== "Antarctica" && famous(x));
      const groups = new Map();
      shuffle(far, rnd).forEach((x) => { const c = info(x.id).cont; if (!groups.has(c)) groups.set(c, []); groups.get(c).push(x); });
      const order = shuffle([...groups.keys()], rnd), out = [];
      while (out.length < n && order.some((c) => groups.get(c).length)) for (const c of order) { const g = groups.get(c); if (g.length && out.length < n) out.push(g.shift()); }
      if (out.length >= n) return out;
    }
    return distractors(f, n, rnd);
  }
  function buildQs(count, rnd = Math.random, opts = {}) {
    const useFilter = opts.useFilter !== false, levelDiff = opts.diff, lv = levelDiff ? L.level(levelDiff) : null;
    let pool = withFacts().slice().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    if (useFilter && filter && pool.filter(inTopic).length >= count) pool = pool.filter(inTopic);
    const narrow = lv && lv.pool === "famous" ? famous : lv && lv.pool === "mid" ? notTiny : null;
    if (narrow && pool.filter(narrow).length >= count * 2) pool = pool.filter(narrow);
    const mixups = opts.review ? getMixups() : {};
    const review = (opts.review || []).map((id) => byId.get(id)).filter((f) => f && pool.includes(f)).slice(0, 3);
    const live = rnd === Math.random; // normal play; the daily is seeded and must be the same for everyone
    const rest = pool.filter((f) => !review.includes(f)), need = count - review.length;
    let fresh = pickSpread(rest, need, rnd, live);
    // Expert: at least half the round comes from small places and territories.
    if (lv && lv.pool === "small") {
      const small = rest.filter(smallPlace), half = Math.ceil(need / 2);
      if (small.length >= half) { const a = pickSpread(small, half, rnd, live); fresh = a.concat(pickSpread(rest.filter((f) => !a.includes(f)), need - a.length, rnd, live)); }
    }
    const picks = shuffle(review.concat(fresh), rnd);
    const usedCats = new Set();
    const qs = picks.map((f) => {
      const all = factsOf(f.id).map((x, i) => [x, i]);
      const inCat = useFilter ? all.filter(([x]) => !filter || x[0] === filter) : all;
      let list = inCat.length ? inCat : all;
      // Fresh facts first: in normal play, skip facts you've already had as a clue while this country
      // still has others; then prefer a topic this round hasn't used yet, so rounds mix topics.
      if (live) { const fresh = list.filter(([, i]) => !seenFacts.has(`${f.id}:${i}`)); if (fresh.length) list = fresh; }
      const newTopic = list.filter(([x]) => !usedCats.has(x[0]));
      if (newTopic.length) list = newTopic;
      const pick = list[Math.floor(rnd() * list.length)];
      usedCats.add(pick[0][0]);
      const opts = [f, ...wrongFor(f, 3, rnd, levelDiff)];
      // A country you mixed up before comes back with the one you confused it with among the options.
      const partner = review.includes(f) && opts.length === 4 ? byId.get(mixups[f.id]) : null;
      if (partner && partner !== f && !opts.includes(partner)) opts[3] = partner;
      return { a: String(f.id), f: pick[1], o: shuffle(opts, rnd).map((x) => String(x.id)), r: review.includes(f) ? 1 : 0 };
    });
    // Special rounds in a 10-question round: a flag, a large country's outline and a capital city,
    // plus two of the newer kinds, each in a random slot. Never the final, double-points question.
    if (count >= 10) {
      const slots = shuffle(Array.from({ length: count - 1 }, (_, i) => i), rnd).slice(0, 5);
      const special = (q) => q.s || q.fl || q.cp;
      const place = (test, at, key) => {
        // Swap a suitable question into its slot.
        const j = qs.findIndex((q, idx) => idx < count - 1 && !special(q) && !slots.slice(3).includes(idx) && test(q));
        if (j >= 0 && !special(qs[at])) { [qs[j], qs[at]] = [qs[at], qs[j]]; qs[at][key] = 1; }
      };
      place((q) => (info(q.a)?.area || 0) >= 80000, slots[0], "s");
      place((q) => flagRoundOK(q), slots[1], "fl");
      place((q) => capitalRoundOK(q), slots[2], "cp");
      // Two more special rounds, picked at random each round: find it, higher or lower, neighbors,
      // north or south, currency or language.
      const kinds = shuffle(["fi", "hl", "nb", "ns", "cu", "lg"], rnd);
      slots.slice(3).forEach((at) => {
        const q = qs[at];
        if (!q || q.s || q.fl || q.cp) return;
        for (const k of kinds.slice()) { if (makeRound[k](q, rnd)) { kinds.splice(kinds.indexOf(k), 1); return; } }
      });
    }
    addArcadeExtras(qs, rnd);
    return live ? applyFactDiff(qs) : qs;
  }
  // Scoring always uses the standard 1:50m outlines, so every player gets the same result whether or
  // not their browser has loaded the detailed deep-zoom map.
  const scoreShape = (f) => (f.geo50 ? { type: "Feature", geometry: f.geo50 } : f);
  function distanceKm(pt, f0, raw = false) {
    const f = scoreShape(f0);
    if (d3.geoContains(f, pt)) return 0;
    let best = Infinity;
    const walk = (c) => { if (typeof c[0] === "number") { const d = d3.geoDistance(pt, c); if (d < best) best = d; } else c.forEach(walk); };
    walk(f.geometry.coordinates);
    // Tiny places (under ISLET_AREA km²) count a pin within ISLET_SLACK km of their coast as inside.
    const km = best * 6371;
    return !raw && km <= ISLET_SLACK && (info(f0.id)?.area ?? Infinity) < ISLET_AREA ? 0 : km;
  }
  const ISLET_SLACK = 25, ISLET_AREA = 5000;
  function pinSpot(pt) {
    const inside = features.find((f) => d3.geoContains(scoreShape(f), pt));
    if (inside) return `In ${esc(nameOf(inside))}`;
    let best = null, bestKm = Infinity;
    // The real distance here (no islet slack), so a pin in the sea never reads "0 km".
    features.forEach((f) => { const d = distanceKm(pt, f, true); if (d < bestKm) { bestKm = d; best = f; } });
    return `In the water, ${fmtKm(bestKm)} from ${esc(nameOf(best))}, the nearest land`;
  }
  const showQuizPart = (part) => {
    document.body.classList.toggle("playing", part === "play");
    if (part !== "play") clearCues();
    if (part === "end") checkSkins(); // a finished game may have reached a skin's goal
    $("qsetup").hidden = part !== "setup";
    $("qprogress").hidden = part === "setup";
    $("qplay").hidden = part !== "play";
    $("qend").hidden = part !== "end";
  };
  function resetEndExtras() {
    $("qextra").innerHTML = "";
    $("qrematch").hidden = true;
    $("qsettings").hidden = true;
    $("qchallenge").hidden = true;
    $("qshareimg").hidden = true;
    $("qendtag").textContent = "Round complete";
    $("qagain").classList.add("primary");
    $("qbest").hidden = false;
    $("qbest").textContent = "";
  }
  function newQuiz(kind, cfg, qs, extra = {}) {
    resetEndExtras();
    stopTimer();
    quiz = Object.assign({ kind, cfg, qs, order: qs.map((q) => byId.get(q.a)), i: -1, score: 0, results: [], names: 0, kms: [], usedHints: 0, log: [], done: false, streak: 0, bestStreak: 0, baseN: qs.length, bonusOver: false }, extra);
    setHeat(0);
    selected = null;
    $("dstreak").hidden = kind !== "daily";
    $("qquit").textContent = kind === "party" ? "Back to exploring" : "Quiz menu";
    $("qlives").hidden = true; $("qscatter").hidden = true; $("qbar").parentElement.hidden = false;
    // Power-ups from earlier games or won elsewhere (kept in sync while you play).
    if (POWER_KINDS.includes(kind)) quiz.powers = carriedPowers();
    document.body.classList.toggle("seasoned", experienced());
    showQuizPart("play");
  }

  // Setup controls shared by the solo quiz and the party lobby.
  const loadCfg = () => Object.assign({ diff: "easy", timer: false }, lsJSON("atlas-cfg", {}));
  // Answering by picking from choices (Easy, Medium) rather than typing (Hard, Expert).
  const picksAnswer = (cfg) => cfg.diff === "easy" || cfg.diff === "medium";
  // The solo setup also offers Survival as a tab; it plays at a level picked under it, always timed.
  const SURVIVAL_NOTE = "Endless questions, 3 lives. The clock gets shorter as you go.";
  function buildSetup(container, prefix) {
    const cfg = loadCfg(), solo = prefix === "solo", surv = solo && !!cfg.survival;
    const tabs = Object.entries(DIFFS).map(([key, d]) => [key, d.label, d.note]).concat(solo ? [["survival", "Survival", SURVIVAL_NOTE]] : []);
    container.innerHTML = `<fieldset class="seg"><legend>Difficulty</legend><div class="segtabs">${tabs.map(([key, label]) => `<label><input type="radio" name="${prefix}-diff" value="${key}"${(surv ? key === "survival" : cfg.diff === key) ? " checked" : ""}><b>${label}</b></label>`).join("")}</div><p class="segnote" id="${prefix}-diffnote"></p>
      ${solo ? `<label class="field survlevel" id="solo-survlevel"><span>Survival answers like</span><select id="solo-sdiff">${Object.entries(DIFFS).map(([key, d]) => `<option value="${key}"${cfg.diff === key ? " selected" : ""}>${d.label}: ${d.note.split(".")[0].toLowerCase()}</option>`).join("")}</select></label>` : ""}</fieldset>
      <label class="toggle" id="${prefix}-timerrow"><input type="checkbox" id="${prefix}-timer"${cfg.timer ? " checked" : ""}><span>Speed bonus<small>A ${TIMER_S}-second clock on each question, with up to ${SPEED_PTS} extra points for answering fast.</small></span></label>`;
    // The clock follows the level: none on Easy, your choice on Medium and Hard, always on for Expert
    // (and in Survival). The switch remembers your choice for the levels where it's yours.
    const box = $(`${prefix}-timer`), row = $(`${prefix}-timerrow`);
    let mine = box.checked;
    box.addEventListener("change", () => { mine = box.checked; });
    const sync = () => {
      const v = (container.querySelector(`input[name="${prefix}-diff"]:checked`) || {}).value || "easy", isS = v === "survival";
      const rule = isS ? "on" : L.level(v).timer;
      $(`${prefix}-diffnote`).textContent = isS ? SURVIVAL_NOTE : DIFFS[v].note + (rule === "off" ? " No clock." : rule === "on" ? " The clock is always on." : "");
      row.hidden = rule !== "optional";
      box.disabled = rule !== "optional";
      box.checked = rule === "on" ? true : rule === "off" ? false : mine;
      if (solo) { $("solo-survlevel").hidden = !isS; $("qstart").textContent = isS ? "Start Survival" : "Start quiz"; }
    };
    container.querySelectorAll(`input[name="${prefix}-diff"]`).forEach((r) => r.addEventListener("change", sync));
    sync();
  }
  function readSetup(prefix) {
    const d = document.querySelector(`input[name="${prefix}-diff"]:checked`);
    if (d && d.value === "survival") {
      const sd = ($("solo-sdiff") || {}).value;
      const cfg = { diff: DIFFS[sd] ? sd : "easy", timer: true, survival: true };
      lsSaveJSON("atlas-cfg", cfg);
      return cfg;
    }
    const diff = d && DIFFS[d.value] ? d.value : "easy", rule = L.level(diff).timer;
    const cfg = { diff, timer: rule === "on" ? true : rule === "off" ? false : !!($(`${prefix}-timer`) || {}).checked };
    lsSaveJSON("atlas-cfg", prefix === "solo" ? cfg : Object.assign(loadCfg(), cfg));
    return cfg;
  }
  const cfgText = (cfg) => `${DIFFS[cfg.diff].label}${cfg.timer ? " · speed bonus on" : ""}`;

  function showSetup() {
    resetEndExtras(); stopTimer();
    quiz = null; selected = null;
    $("dstreak").hidden = true;
    buildSetup($("solo-setup"), "solo");
    const best = Number(lsGet(`atlas-best2-${loadCfg().diff}`) || 0);
    $("qsetupnote").textContent = best ? `Best on ${DIFFS[loadCfg().diff].label}: ${best}` : "";
    showQuizPart("setup");
    renderChallengeList();
    renderDailyCard();
    // On phones, a one-time tip to add the page to the home screen, so it's easy to find again.
    $("qhometip").hidden = !(window.matchMedia("(pointer: coarse)").matches && !lsGet("atlas-hometip") && !STANDALONE);
    // How to play is open for new players and folded away once they've finished a game.
    $("qhowto").open = !experienced();
    renderSetupHiscores();
    renderPoolBanner();
    renderLogin();
    $("qlives").hidden = true; $("qscatter").hidden = true; $("qbar").parentElement.hidden = false;
    $("chmsg").textContent = "";
    wrap.classList.remove("noborders");
    paintClasses(); render(); zoomOut();
  }
  function startQuiz(cfg = loadCfg()) {
    refreshFactDiff(); // for the next round; this one uses what's already cached
    newQuiz("solo", cfg, buildQs(ROUND, Math.random, { review: getReview(), diff: cfg.diff }));
    nextQuestion();
  }

  let timerId = null;
  function stopTimer() { if (timerId) { clearInterval(timerId); timerId = null; } }
  function startTimer() {
    stopTimer();
    const el = $("qtimer");
    const bonus = !!(quiz.spec && quiz.spec.b);
    if (!quiz.cfg.timer && !bonus) { el.hidden = true; return; }
    el.hidden = false;
    // Survival shortens the clock as you go (quiz.limitS); the speed bonus always counts from 20 s.
    const lim = quiz.limitS || TIMER_S, surv = quiz.kind === "survival";
    const tick = () => {
      // A Freeze runs out after FREEZE_MS: the clock picks up where it stopped.
      if (quiz.frozenMs != null && Date.now() - quiz.frozeAt >= FREEZE_MS) { quiz.startedAt = Date.now() - quiz.frozenMs; quiz.frozenMs = null; el.classList.remove("frozen"); }
      const frozenLeft = quiz.frozenMs != null ? Math.ceil((FREEZE_MS - (Date.now() - quiz.frozeAt)) / 1000) : 0;
      const used = Math.max(0, (quiz.frozenMs != null ? quiz.frozenMs : Date.now() - quiz.startedAt) / 1000);
      const left = Math.max(0, lim - used);
      $("qtimerbar").style.width = `${(left / lim) * 100}%`;
      el.classList.toggle("low", left < 6);
      $("qtimertext").textContent = left > 0 ? `${frozenLeft ? `Frozen ${frozenLeft} s · ` : ""}${Math.ceil(left)} s · speed bonus up to +${Math.round(SPEED_PTS * Math.max(0, 1 - Math.max(0, used) / TIMER_S))}` : bonus ? "Time's up" : surv ? "Time's up · you lose a life" : "Time's up · no speed bonus";
      if (left <= 0) { stopTimer(); if (!quiz.locked && !quiz.revealed) { if (bonus) bonusTimeout(); else if (surv) survivalTimeout(); } }
    };
    tick();
    timerId = setInterval(tick, 250);
  }

  function nextQuestion() {
    stopTimer(); clearTimeout(revealScrollT); endCountdown();
    clearPerfect();
    // Pressing "End the bonus round" during the Continue? countdown.
    if (quiz && quiz.pendingContinue) { endBonusRound(); return; }
    const fromKeyboard = document.activeElement === $("qnext");
    quiz.i += 1;
    // The tutorial's one question: Next goes to its closing tips.
    if (quiz.kind === "tutorial" && quiz.i >= quiz.order.length) { quiz.i -= 1; return tut ? tutStep(STEPS.length) : closeTut(); }
    if (quiz.kind === "survival") { if (quiz.lives <= 0) return survivalEnd(); if (quiz.i >= quiz.order.length) extendSurvival(); }
    if (quiz.i >= quiz.order.length && bonusEarned()) addBonusQuestions();
    if (quiz.i >= quiz.order.length && freeSpinEarned()) addFreeSpin();
    if (quiz.i >= quiz.order.length && chestEarned()) { quiz.i = quiz.order.length - 1; return showChest(); }
    if (quiz.i >= quiz.order.length) return endQuiz();
    hideSlot(); clearJackpot();
    $("qfact").hidden = false; $("qtimer").classList.remove("frozen");
    const spec = quiz.qs[quiz.i], f = quiz.order[quiz.i];
    const fact = factsOf(f.id)[spec.f] || factsOf(f.id)[0];
    const isDouble = quiz.kind !== "survival" && quiz.kind !== "tutorial" && quiz.i === quiz.order.length - 1;
    const bet = quiz.nextBet || 0;
    Object.assign(quiz, { powersOn: [], shieldOn: false, doubleOn: false, retryOn: false, retried: false, limitS: quiz.kind === "survival" ? survivalLimit(quiz.i) : TIMER_S, frozenMs: null, lens: null, bet, nextBet: 0, answer: f, fact, spec, isDouble, choice: null, pin: null, hints: [], line: null, lineT: 0, km: null, revealed: false, locked: false, others: null, startedAt: Date.now(), ms: null, waitSince: null });
    selected = null;
    const total = quiz.order.length;
    $("qnum").textContent = quiz.kind === "survival" ? `Survival · question ${quiz.i + 1}` : spec.fs ? "Free spin" : spec.b ? `Bonus question ${quiz.i - quiz.baseN + 1} of ${quiz.order.length - quiz.baseN}` : quiz.kind === "daily" ? `Daily challenge · ${quiz.i + 1} of ${total}` : quiz.kind === "challenge" ? `Challenge ${quiz.chCode} · ${quiz.i + 1} of ${total}` : `Question ${quiz.i + 1} of ${total}`;
    $("qscore").textContent = quiz.kind === "party" ? cfgText(quiz.cfg) : `${plural(quiz.score, "point")} · ${cfgText(quiz.cfg)}`;
    $("qbar").style.width = `${(quiz.i / total) * 100}%`;
    $("qbar").parentElement.hidden = quiz.kind === "survival";
    // Badges for bonus rounds.
    const badges = [];
    if (quiz.kind === "survival") badges.push(`<span class="badge bonus">Survival · ${quiz.limitS} seconds on the clock</span>`);
    if (isDouble && !spec.b && !spec.fs) badges.push('<span class="badge double">Final question · double points</span>');
    if (quiz.feverLeft > 0) badges.push(`<span class="badge fever">Fever · × ${L.FEVER_X} points</span>`);
    if (spec.mm > 1) badges.push(`<span class="badge mystery">Mystery multiplier · × ${spec.mm}</span>`);
    if (spec.fs) badges.push(`<span class="badge mystery">Free spin · × ${spec.fsm} points</span>`);
    if (spec.b) badges.push(`<span class="badge bonus">Bonus round · ${TIMER_S} seconds · run out of time and the bonus ends</span>`);
    if (roundKind(spec)) badges.push(`<span class="badge">${ROUND_NAMES[roundKind(spec)]}</span>`);
    if (spec.r) badges.push('<span class="badge review">From your review list</span>');
    if (L.factMult(spec.d) > 1) badges.push(`<span class="badge tricky">Tricky fact · × ${L.factMult(spec.d)} points</span>`);
    if (quiz.streak >= 1) badges.push(`<span class="badge streak">${quiz.streak} in a row · name it for × ${+L.streakMult(quiz.heat || 0).toFixed(2)}</span>`);
    if (quiz.bet && Math.round(quiz.score * quiz.bet)) badges.push(`<span class="badge bet">Bet ${Math.round(quiz.bet * 100)}%: ${Math.round(quiz.score * quiz.bet)} points riding on this one</span>`);
    $("qbadges").innerHTML = badges.join("");
    updateCombo(quiz.heat || 0);
    quiz.qxp = 0; // points earned on this question outside the answer itself (a golden landmark)
    updateFever(); updateLives(); maybeScatter();
    // A slot spin before the final question (its mystery multiplier) and before a free spin. The
    // clock (if any) starts when the reels stop.
    const slotX = spec.fs ? spec.fsm : spec.mm;
    // The bonus round opens with a countdown; its clock starts when it ends.
    if (spec.b && quiz.i === quiz.baseN) bonusCountdown();
    if (slotX) {
      playSlot(slotX, spec.fs ? "Free spin: your reward" : "Mystery multiplier");
      if (!reduce) quiz.startedAt = Date.now() + 1650;
    }
    // The clue: a fact with the name blanked out, or the country's outline in a shape round.
    $("qfact").querySelectorAll(".src").forEach((e) => e.remove());
    $("qcat").textContent = roundKind(spec) ? ROUND_NAMES[roundKind(spec)] : fact[0];
    $("qflag").hidden = !spec.fl;
    if (spec.fl) {
      $("qshape").setAttribute("hidden", "");
      $("qflag").textContent = flagOf(info(f.id)?.a2);
      $("qtext").textContent = "Whose flag is this?";
    } else if (spec.fi || spec.hl || spec.ns || spec.nb || spec.cu || spec.lg) {
      $("qshape").setAttribute("hidden", "");
      const nm = (id) => `<b>${esc(nameOf(byId.get(id)))}</b>`;
      const pair = (o) => [spec.a, o].sort().map(nm).join(" or ");
      const what = spec.hl && (spec.hl.k === "pop" ? (spec.hl.more ? "has more people" : "has fewer people") : (spec.hl.more ? "is bigger" : "is smaller"));
      const north = spec.ns && (latOf(spec.a) > latOf(spec.ns) ? "further north" : "further south");
      $("qtext").innerHTML = spec.fi ? `Find ${nm(spec.a)} on the globe.`
        : spec.hl ? `Which ${what}: ${pair(spec.hl.o)}?`
        : spec.ns ? `Which lies ${north}: ${pair(spec.ns)}?`
        : spec.nb ? `Which country borders both ${nm(spec.nb[0])} and ${nm(spec.nb[1])}?`
        : spec.cu ? `Whose currency is the <b>${esc(spec.cu)}</b>?`
        : `Where is <b>${esc(spec.lg)}</b> an official language?`;
    } else if (spec.cp) {
      $("qshape").setAttribute("hidden", "");
      $("qtext").innerHTML = `Which country has <b>${esc(info(f.id).cap)}</b> as its capital?`;
    } else if (spec.s) {
      const proj = d3.geoAzimuthalEqualArea().rotate(centroidOf(f).map((x) => -x)).fitExtent([[12, 10], [228, 140]], f);
      $("qshapepath").setAttribute("d", d3.geoPath(proj)(f));
      $("qshape").removeAttribute("hidden");
      $("qtext").textContent = "Which country has this shape?";
    } else {
      $("qshape").setAttribute("hidden", "");
      $("qtext").innerHTML = maskedHTML(fact[1], f);
    }
    const fact$ = $("qfact"); fact$.style.animation = "none"; void fact$.offsetWidth; fact$.style.animation = "";
    const typed = !picksAnswer(quiz.cfg);
    quiz.opts = optionsFor(spec, f);
    $("qprompt").textContent = typed
      ? "Type the country, then drop a pin on the globe where it is."
      : "Choose the country, then drop a pin on the globe where it is.";
    $("qprompt").hidden = false;
    $("qprompt").classList.toggle("key", !!spec.fi);
    $("qsteps").hidden = false;
    $("step-name").textContent = typed ? "1 · Type the country" : "1 · Choose a country";
    $("qresult").hidden = true;
    $("qnext").hidden = true;
    $("qdrop").hidden = true;
    $("qlock").hidden = false;
    $("qlock").textContent = "Lock in answer";
    // Answer input: four options on Easy, a typed name on Hard and Expert. A Find it round gives the
    // name, so only the pin is asked for.
    const box = $("qopts"); box.innerHTML = "";
    box.hidden = typed || !!spec.fi;
    $("qtypeform").hidden = !typed || !!spec.fi;
    if (spec.fi) { quiz.choice = f; $("qprompt").textContent = `Drop your pin on it. The pin counts ${L.findPinMult(info(spec.a)?.area)}×, and landing within ${L.findKm(info(spec.a)?.area)} km keeps your streak going${L.findKm(info(spec.a)?.area) < L.FIND_KM ? " (a big country gets a tighter margin)" : ""}.`; $("step-name").textContent = "1 · Country given"; }
    $("qtype").value = ""; $("qtype").disabled = false;
    if (!typed) {
      quiz.opts.map((id) => byId.get(id)).filter(Boolean).forEach((o) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "opt"; b.textContent = nameOf(o); b.dataset.id = o.id;
        b.onclick = () => choose(o);
        box.appendChild(b);
      });
    }
    // Hints.
    $("qhints").innerHTML = HINTS.map((h) => `<button type="button" data-hint="${h.key}"${h.after ? " hidden" : ""}>${h.label}</button>`).join("");
    $("qhints").querySelectorAll("button").forEach((b) => { b.onclick = () => useHint(b.dataset.hint); });
    // Eliminating one of two choices (or a given name) would just be the answer.
    if (spec.fi || spec.hl || spec.ns) $("qhints").querySelectorAll('[data-hint="elim"], [data-hint="elim2"]').forEach((b) => b.remove());
    hintLabels();
    $("qelim").hidden = true; $("qelim").innerHTML = "";
    $("qcluehead").hidden = false;
    $("qhintout").hidden = true; $("qhintout").textContent = ""; quiz.contGlow = null;
    $("qlat").value = ""; $("qlon").value = ""; $("qpinmsg").textContent = "";
    $("oppstatus").hidden = true;
    wrap.classList.toggle("noborders", quiz.cfg.diff === "expert");
    updateSteps();
    renderPower();
    paintClasses();
    render();
    zoomOut();
    startTimer();
    if (quiz.kind === "party") { renderStandings(); updateOppStatus(); }
    // Keyboard and screen-reader players land on the new clue.
    if (fromKeyboard) $("qfact").focus({ preventScroll: true });
    fitAnswers();
  }
  // Phones: if a new question's answers would sit under the Lock in bar, scroll down just enough to
  // show them (the globe's lower part stays in view, and picking an answer brings it back for the pin).
  function fitAnswers() {
    if (!matchMedia("(max-width: 860px)").matches) return;
    requestAnimationFrame(() => {
      const box = !$("qopts").hidden ? $("qopts") : !$("qtypeform").hidden ? $("qtypeform") : null;
      if (!box || !quiz || quiz.revealed) return;
      const bar = $("qplay").querySelector(":scope > .actions");
      const limit = Math.min(bar ? bar.getBoundingClientRect().top : innerHeight, innerHeight - 76);
      const over = box.getBoundingClientRect().bottom + 8 - limit;
      if (over > 0) scrollBy({ top: over, behavior: reduce ? "auto" : "smooth" });
    });
  }
  // Medium shows six choices: the round's four plus two more nearby countries (never in two-choice,
  // neighbors or Find it rounds, and never a second country flying the answer's flag).
  function optionsFor(spec, f) {
    if (quiz.cfg.diff !== "medium" || spec.hl || spec.ns || spec.nb || spec.fi) return spec.o;
    if (!spec.o6) {
      const a2 = info(spec.a)?.a2;
      const extra = wrongFor(f, 10, Math.random, quiz.cfg.diff).map((x) => String(x.id)).filter((id) => !spec.o.includes(id) && !(spec.fl && flagKey(info(id)?.a2) === flagKey(a2))).slice(0, 2);
      spec.o6 = shuffle(spec.o.concat(extra));
    }
    return spec.o6;
  }
  function updateSteps() {
    $("step-pin").classList.toggle("done", !!quiz.pin);
    $("step-pin").textContent = quiz.pin ? "2 · Pin dropped" : "2 · Drop a pin";
    $("step-name").classList.toggle("done", !!quiz.choice);
    $("step-name").textContent = quiz.choice ? `1 · ${nameOf(quiz.choice)}` : picksAnswer(quiz.cfg) ? "1 · Choose a country" : "1 · Type the country";
    if (quiz.spec?.fi) $("step-name").textContent = "1 · Country given";
    $("qlock").disabled = !(quiz.pin && quiz.choice) || quiz.locked;
    updateCues();
    tutTick();
  }
  // Light up what to do next: the step to do now, and the thing to act on.
  function updateCues() {
    const live = !!quiz && !quiz.revealed && !quiz.locked && !quiz.done && inQuiz() && !$("qplay").hidden;
    // The order: choose the country, then drop the pin, then lock in (either first still works).
    const needName = live && !quiz.choice, needPin = live && !!quiz.choice && !quiz.pin, ready = live && !!quiz.pin && !!quiz.choice;
    wrap.classList.toggle("cue-pin", needPin);
    $("cuebubble").hidden = !needPin;
    $("qopts").classList.toggle("cue", needName); $("qtypeform").classList.toggle("cue", needName); $("qelim").classList.toggle("cue", needName);
    $("qlock").classList.toggle("cue", ready);
    $("step-pin").classList.toggle("now", needPin);
    $("step-name").classList.toggle("now", needName);
    $("step-lock").classList.toggle("now", ready);
  }
  const clearCues = () => { wrap.classList.remove("cue-pin"); $("cuebubble").hidden = true; ["qopts", "qtypeform", "qelim", "qlock"].forEach((id) => $(id).classList.remove("cue")); };
  // Players who have finished a game don't need the how-to text any more.
  const experienced = () => { const st = getStats(); return (st.quizzes || 0) > 0 || (st.partyGames || 0) > 0 || (loadDaily().played || 0) > 0; };
  function choose(f) {
    if (quiz && quiz.holding) return;
    if (!quiz || quiz.revealed || quiz.locked || quiz.spec?.fi) return; // a Find it round names the country already
    quiz.choice = f;
    $("qopts").querySelectorAll(".opt").forEach((b) => b.classList.toggle("chosen", b.dataset.id === String(f.id)));
    updateSteps();
    // Step 2 is the pin: on narrow screens (globe above the panel), bring the globe into view.
    if (!quiz.pin && window.matchMedia("(max-width: 860px)").matches) wrap.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
  }
  const pinCoord = ([lon, lat]) => `${Math.abs(lat).toFixed(1)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lon).toFixed(1)}° ${lon >= 0 ? "E" : "W"}`;
  function dropPin(p) {
    if (!quiz.pin || d3.geoDistance(quiz.pin, p) > 0.001) sfx("pin");
    quiz.pin = p;
    updateSteps();
    render();
    // Show where it is as coordinates (also filling the coordinate fields), never as a country name,
    // which would give answers away. Wait until the pin stops moving (arrow keys) before announcing it.
    $("qlat").value = p[1].toFixed(1); $("qlon").value = p[0].toFixed(1);
    $("qpinmsg").textContent = `Pin at ${pinCoord(p)}.`;
    announce(`Pin dropped at ${pinCoord(p)}.`, 450);
  }
  // Hint buttons show what each would cost right now: the price rises with every hint already used
  // on this question and with the streak you're protecting.
  function hintLabels() {
    $("qhints").querySelectorAll("button").forEach((b) => {
      const h = HINTS.find((x) => x.key === b.dataset.hint);
      const free = (L.level(quiz.cfg.diff).freeHints || []).includes(h.key);
      b.textContent = quiz.hints.includes(h.key) ? `${h.label} ✓` : free ? `${h.label} · free` : `${h.label} −${L.nextHintPct(quiz.hints, h.key, quiz.heat || 0, quiz.cfg.diff)}%`;
      // Expert allows one clue per question.
      const max = L.level(quiz.cfg.diff).maxHints;
      if (max && quiz.hints.length >= max && !quiz.hints.includes(h.key)) { b.disabled = true; b.title = `${DIFFS[quiz.cfg.diff].label} allows ${plural(max, "clue")} per question`; }
    });
  }
  function useHint(key) {
    if (!quiz || quiz.revealed || quiz.locked || quiz.hints.includes(key)) return;
    const maxH = L.level(quiz.cfg.diff).maxHints;
    if (maxH && quiz.hints.length >= maxH) return;
    const ans = quiz.answer;
    quiz.hints.push(key);
    const msgs = [];
    quiz.hints.forEach((hk) => {
      if (hk === "continent") msgs.push(`It's in ${info(ans.id)?.cont || "an unknown region"}.`);
      if (hk === "zoom") msgs.push("The globe is now centered near it.");
      if (hk === "elim") msgs.push(picksAnswer(quiz.cfg) ? "One wrong answer is crossed out." : "It's one of these three:");
      if (hk === "elim2") msgs.push(picksAnswer(quiz.cfg) ? "Another wrong answer is crossed out." : "Now it's one of these two:");
    });
    if (key === "continent") {
      quiz.contGlow = continentOutline(info(ans.id)?.cont);
      // Turn the globe to face the continent (no zoom-in) so its glow is in view.
      if (quiz.contGlow && !quiz.hints.includes("zoom")) flyToPoint(d3.geoCentroid(quiz.contGlow), Math.min(k, 1.15), { duration: 900, dip: 0 });
      render();
    }
    if (key === "zoom") {
      const [lon, lat] = centroidOf(ans);
      const r = Math.random() * Math.PI * 2, off = 6 + Math.random() * 8;
      flyToPoint([lon + Math.cos(r) * off, Math.max(-80, Math.min(80, lat + Math.sin(r) * off))], 2, { duration: 900, dip: 0 });
    }
    if (key === "elim" || key === "elim2") eliminate();
    // The second elimination is offered once the first is used, while at least two wrong answers are left.
    const e2 = $("qhints").querySelector('[data-hint="elim2"]');
    if (e2 && key === "elim") e2.hidden = wrongLeft().length < 2;
    $("qhintout").textContent = `${msgs.join(" ")} Clues used: −${Math.round(L.hintPct(quiz.hints, quiz.heat || 0, quiz.cfg.diff) * 100)}% of this question's points.${maxH && quiz.hints.length >= maxH ? ` That's your ${plural(maxH, "clue")} for this question on ${DIFFS[quiz.cfg.diff].label}.` : ""}`;
    $("qhintout").hidden = false;
    $("qhints").querySelector(`[data-hint="${key}"]`).classList.add("used");
    hintLabels();
  }
  // Eliminate a wrong answer. Easy: cross out one wrong option. Hard and Expert (typed): offer three
  // countries, one of them right, as buttons.
  // Wrong answers still on screen as buttons: the choices on Easy and Medium, or the narrowed list
  // on Hard and Expert (none until a clue or 50/50 narrows it).
  function wrongLeft() {
    const ans = String(quiz.answer.id), box = picksAnswer(quiz.cfg) ? $("qopts") : $("qelim");
    if (box.hidden) return [];
    return [...box.querySelectorAll(".opt")].filter((b) => b.dataset.id !== ans && !b.disabled);
  }
  function eliminate() {
    const ans = String(quiz.answer.id);
    const wrong = shuffle(quiz.spec.o.filter((id) => id !== ans && byId.has(id)));
    // Already narrowed to buttons (an earlier elimination, or 50/50 on a typed level): cross one out.
    const left = wrongLeft();
    if (picksAnswer(quiz.cfg) || !$("qelim").hidden) {
      const btn = shuffle(left)[0];
      if (!btn) return;
      btn.disabled = true; btn.classList.add("elim");
      if (quiz.choice && String(quiz.choice.id) === btn.dataset.id) { quiz.choice = null; btn.classList.remove("chosen"); if (!picksAnswer(quiz.cfg)) $("qtype").value = ""; updateSteps(); }
      return;
    }
    const three = shuffle([ans, ...wrong.slice(0, 2)]).map((id) => byId.get(id));
    const box = $("qelim");
    box.innerHTML = "";
    three.forEach((f) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "opt"; b.textContent = nameOf(f); b.dataset.id = f.id;
      b.onclick = () => { $("qtype").value = nameOf(f); choose(f); box.querySelectorAll(".opt").forEach((x) => x.classList.toggle("chosen", x === b)); };
      box.appendChild(b);
    });
    box.hidden = false;
  }

  $("qtypeform").addEventListener("submit", (e) => {
    e.preventDefault();
    const f = findByName($("qtype").value);
    if (f) choose(f);
    else { $("qhintout").hidden = false; $("qhintout").textContent = "That doesn't match a country on the map. Pick a name from the list as you type."; }
  });
  $("qtype").addEventListener("change", () => { const f = findByName($("qtype").value); if (f) choose(f); });
  // Drop the pin by coordinates (no country names, so it can't be used to look answers up).
  $("qpinform").addEventListener("submit", (e) => {
    e.preventDefault();
    if (!canPin()) return;
    const lat = parseFloat($("qlat").value), lon = parseFloat($("qlon").value);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      $("qpinmsg").textContent = "Enter a latitude from −90 to 90 and a longitude from −180 to 180.";
      return;
    }
    const p = [lon, lat];
    dropPin(p);
    flyToPoint(p, Math.max(k, 1.4), { duration: 600, dip: 0 });
  });

  function lockIn() {
    if (quiz && quiz.holding) return;
    if (!quiz || quiz.revealed || quiz.locked || !quiz.pin || !quiz.choice) return;
    quiz.ms = quiz.cfg.timer || quiz.spec.b ? (quiz.frozenMs != null ? quiz.frozenMs : Date.now() - quiz.startedAt) : null;
    stopTimer();
    if (powerOK() && quiz.retryOn && secondChance(distanceKm(quiz.pin, quiz.answer))) return;
    if (quiz.kind === "party") sfx("lock");
    if (quiz.kind === "party") mpLock();
    else reveal();
  }
  function setLockedUI() {
    quiz.locked = true;
    $("qopts").querySelectorAll(".opt").forEach((b) => { b.disabled = true; });
    $("qtype").disabled = true;
    $("qhints").querySelectorAll("button").forEach((b) => { b.disabled = true; });
    $("qelim").querySelectorAll("button").forEach((b) => { b.disabled = true; });
    $("qlock").disabled = true;
    $("qlock").textContent = "Locked in";
    clearCues();
    tutTick();
  }
  // This player's answers so far, scored as one run with the same rules everyone uses.
  function myRun() {
    const answers = quiz.log.map((a, j) => (a.timeout ? null : { ...answerExtras(quiz.qs[j]), right: a.choice === quiz.qs[j].a, km: quiz.kms[j], hints: a.hints, ms: a.ms, bet: a.bet, shield: !!a.shield, dbl: !!a.dbl, retried: !!a.retried, timed: !!quiz.qs[j].b }));
    return L.scoreRun(answers, quiz.cfg, quiz.kind === "tutorial" ? Infinity : quiz.baseN || quiz.order.length);
  }
  let revealScrollT = null;
  function reveal() {
    stopTimer();
    const ans = quiz.answer, fi = !!quiz.spec.fi;
    const km = distanceKm(quiz.pin, ans);
    const right = fi ? km <= L.findKm(info(ans.id)?.area) : quiz.choice === ans;
    // Score the whole run so far (streaks and bets depend on every earlier answer).
    quiz.kms.push(km);
    quiz.log.push({ choice: String(quiz.choice.id), pin: quiz.pin, hints: quiz.hints.slice(), ms: Number.isFinite(quiz.ms) ? quiz.ms : null, bet: quiz.bet || 0, shield: !!quiz.shieldOn, dbl: !!quiz.doubleOn, retried: !!quiz.retried });
    const run = myRun(), s = run.items[run.items.length - 1];
    const before = quiz.streak;
    quiz.streak = run.streak; quiz.heat = run.heat; quiz.perf = run.perf; quiz.feverLeft = run.feverLeft;
    quiz.bestStreak = Math.max(quiz.bestStreak, quiz.streak);
    setHeat(quiz.streak, before);
    // Perfect: the right country, named (or given, in Find it), with the pin inside it.
    const perfect = right && km === 0 && !quiz.retried; // a Second chance retry is never a Perfect
    sfx(!right ? "wrong" : perfect ? "perfect" : quiz.streak >= 3 ? "streak" : "right");
    if (perfect) notePerfect();
    updateCombo(quiz.heat || 0, !right && (s.heatBefore || 0) > 0);
    quiz.revealed = true; quiz.locked = true;
    $("qtimer").hidden = true;
    quiz.score = run.total - (quiz.penalty || 0) + (quiz.extraPts || 0); quiz.results.push(s.pts); if (right) quiz.names += 1;
    // Power-ups: maybe one for a perfect, one for each 1,000 points reached (counted from your best score so
    // far in this game, so a lost bet can't earn the same one twice).
    const peak = quiz.peak || 0; quiz.peak = Math.max(peak, quiz.score);
    const dropped = earnPowers(perfect, peak, quiz.peak);
    const lifeLost = quiz.kind === "survival" && !right && !s.shielded;
    if (lifeLost) loseLife();
    quiz.usedHints += quiz.hints.length;
    const c = centroidOf(ans);
    quiz.line = km > 0 ? [quiz.pin, c] : null;
    quiz.lineT = 0; quiz.km = km;
    seen.add(ans.id); saveSeen();
    noteFactSeen(ans.id, quiz.spec.f);
    noteRecentAnswer(ans.id);
    selected = ans;
    // Passport, review list, stats and achievements.
    bumpStat("answered");
    if (quiz.hints.length) bumpStat("hints", quiz.hints.length);
    trackReview(ans.id, right);
    if (right) stamp(ans.id);
    if (km === 0) { bumpStat("bullseyes"); unlock("bullseye"); if ((info(ans.id)?.area || Infinity) < 1000) unlock("island"); }
    if (right && quiz.cfg.timer && Number.isFinite(quiz.ms) && quiz.ms < 5000) unlock("quick");
    setLockedUI();
    if (perfect) playPerfect(ans);
    $("qopts").querySelectorAll(".opt").forEach((b) => {
      if (b.dataset.id === String(ans.id)) b.classList.add("right");
      else if (b.dataset.id === String(quiz.choice.id)) b.classList.add("wrong");
    });
    const nm = esc(nameOf(ans)), pickName = esc(nameOf(quiz.choice));
    let pickNote = "";
    if (!right && !fi) {
      const kmPick = distanceKm(quiz.pin, quiz.choice);
      pickNote = kmPick === 0
        ? `That's the country you picked, so your pin matched your guess. If ${pickName} had been the answer, the pin would have scored the full ${PIN_PTS}.`
        : `Your pin was ${fmtKm(kmPick)} from ${pickName}, the country you picked. If ${pickName} had been the answer, the pin would have scored ${pinPoints(kmPick, quiz.cfg.diff)} of ${PIN_PTS}.`;
    }
    const tip = right || fi ? "" : tellApartHTML(ans, quiz.choice);
    if (!fi) noteMixup(ans.id, right ? null : quiz.choice.id);
    const two = !!(quiz.spec.hl || quiz.spec.ns), pinX = fi ? L.findPinMult(info(ans.id)?.area) : 1;
    const lines = [
      ...(fi ? [] : [[two ? "Country (two choices: half points)" : "Country", `${s.name} / ${Math.round(NAME_PTS * (two ? L.TWO_NAME : 1))}`]]),
      [`Pin ${km === 0 ? `inside ${nm}` : `${fmtKm(km)} from ${nm}`}${fi ? ` (counts ${pinX}×)` : ""}`, `${s.pin} / ${Math.round(PIN_PTS * pinX)}`]
    ];
    if (s.perfect) lines.push(["Perfect: pin and country (multiplied below)", `+${s.perfect}`]);
    if (quiz.cfg.timer || quiz.spec.b) lines.push([Number.isFinite(quiz.ms) ? `Speed (${(quiz.ms / 1000).toFixed(1)} s)` : "Speed", `${s.speed} / ${SPEED_PTS}`]);
    if (s.streak > 1) lines.push([`Streak (${s.streakBefore + 1} in a row${s.heatBefore !== s.streakBefore ? "; two-choice rounds count half" : ""})`, `× ${+s.streak.toFixed(2)}`]);
    if (s.hintPct) lines.push(["Clues", `−${Math.round(s.hintPct * 100)}%`]);
    if (s.fever > 1) lines.push(["Fever", `× ${s.fever}`]);
    if (s.power > 1) lines.push(["Double up", `× ${s.power}`]);
    if (quiz.retried && right) lines.push(["Second chance: the country pays half, and no Perfect", "½"]);
    if (s.shielded) lines.push([quiz.kind === "survival" ? "Shield: your streak and your life survive" : "Shield: your streak survives", "✓"]);
    const mmX = quiz.spec.mm > 1 ? quiz.spec.mm : 1, fsX = quiz.spec.fsm > 1 ? quiz.spec.fsm : 1, jpX = quiz.spec.jp && right ? L.JACKPOT : 1;
    const luckX = Math.min(L.LUCK_CAP, mmX * fsX * jpX);
    if (mmX > 1) lines.push(["Mystery multiplier", `× ${mmX}`]);
    if (fsX > 1) lines.push(["Free spin", `× ${fsX}`]);
    if (jpX > 1) lines.push(["Today's jackpot country!", `× ${jpX}`]);
    if (luckX < mmX * fsX * jpX) lines.push(["Lucky multipliers together, capped at", `× ${L.LUCK_CAP}`]);
    if (s.bonusCapped) lines.push(["Bonus multipliers together (luck, Fever, Double up), capped at", `× ${L.BONUS_CAP}`]);
    const fdX = L.factMult(quiz.spec.d), levelX = +(s.mult / fdX / luckX).toFixed(2);
    if (fdX !== 1) lines.push([fdX > 1 ? "Tricky fact (most players miss it)" : "Well-known fact", `× ${fdX}`]);
    if (levelX !== 1) lines.push([[quiz.cfg.diff !== "easy" ? DIFFS[quiz.cfg.diff].label : "", quiz.isDouble ? "Double points" : ""].filter(Boolean).join(" · "), `× ${levelX}`]);
    if (s.stake) lines.push([`Bet ${Math.round(s.bet * 100)}% (${s.stake} points)`, s.betPts >= 0 ? `+${s.betPts}` : `−${-s.betPts}`]);
    if (quiz.kind === "challenge") quiz.others = challengeOthers(ans);
    const res = $("qresult");
    res.className = `qresult ${right ? "ok" : "no"}`;
    res.innerHTML = `<span class="pts">${s.pts >= 0 ? "+" : "−"}${Math.abs(s.pts)}</span>${fi ? (right ? `Found it: ${nm}.` : `Not quite. ${nm} is ${fmtKm(km)} from your pin.`) : right ? `Right, it's ${nm}.` : `It's ${nm}, not ${pickName}.`}
      <div class="scoreline">${lines.map(([a, b]) => `<span>${a}</span><b>${b}</b>`).join("")}</div>
      <p class="pinnote"><span class="pinnote-label">Where your pin landed</span>${pinSpot(quiz.pin)}.${pickNote ? ` ${pickNote}` : ""}</p>
      ${nearMissHTML(right, fi, km, ans)}
      ${quiz.spec.jp && !right ? `<p class="nearmiss">That was today's secret jackpot country, worth × ${L.JACKPOT}. Better luck tomorrow!</p>` : ""}
      ${s.feverStart ? `<p class="fevernote"><b>Fever!</b> ${L.FEVER_AFTER} perfects in a row: your next ${plural(L.FEVER_Q, "question")} pay × ${L.FEVER_X}.</p>` : ""}
      ${quiz.kind === "survival" && !right ? `<p class="lifenote">${lifeLost ? `<b>−1 life.</b> ${quiz.lives ? `${plural(quiz.lives, "life", "lives")} left.` : "That was your last one."}` : "<b>Your Shield saved your life.</b>"}</p>` : ""}
      ${powerDropHTML(dropped)}
      ${quiz.spec.jp && perfect && (quiz.kind === "solo" || quiz.kind === "daily") && !STANDALONE ? `<p class="poolnote" id="poolnote">Checking the shared jackpot…</p>` : ""}
      ${tip}
      ${right || fi ? "" : `<p class="mapkey"><span><i style="background: var(--pick)"></i>The answer</span><span><i style="background: var(--wrong)"></i>Your pick, ${pickName}</span></p>`}
      ${quiz.others ? quiz.others.map((o) => otherRowHTML(o, ans)).join("") : ""}
      ${betSliderHTML()}`;
    res.hidden = false;
    wireBetSlider();
    announce(`${perfect ? "Perfect, pin and country! " : ""}${right ? "Right" : "Not quite"}: it's ${nameOf(ans)}. ${s.pts} points.${quiz.streak >= 2 ? ` ${quiz.streak} in a row.` : ""} Your pin was ${km === 0 ? "inside it" : `${fmtKm(km)} away`}.`);
    ["qprompt", "qsteps", "qlock", "oppstatus", "qdrop", "qtypeform", "qelim", "qcluehead"].forEach((id) => { $(id).hidden = true; });
    $("qhints").innerHTML = "";
    $("qkb").open = false;
    // After the answer: explain the question that was asked (the two populations, the two latitudes…);
    // rounds with nothing more to say (a fact, a shape, a flag) show the country's fact.
    const ex = roundExplanation(quiz.spec, ans);
    if (ex) {
      $("qcat").textContent = ex.cat;
      $("qtext").innerHTML = ex.html;
      $("qfact").insertAdjacentHTML("beforeend", `<span class="src">Country data: world-countries; population from the World Bank (2023)</span>`);
    } else {
      $("qcat").textContent = quiz.fact[0];
      $("qtext").innerHTML = revealedHTML(quiz.fact[1], ans);
      if (quiz.fact[2]) $("qfact").insertAdjacentHTML("beforeend", srcLink(quiz.fact[2], quiz.fact[3]));
    }
    $("qscore").textContent = quiz.kind === "party" ? cfgText(quiz.cfg) : `${plural(quiz.score, "point")} · ${cfgText(quiz.cfg)}`;
    $("qbar").style.width = `${((quiz.i + 1) / quiz.order.length) * 100}%`;
    if (quiz.spec.jp && right) playJackpot();
    if (s.feverStart) bumpStat("fevers");
    if (s.feverStart) setTimeout(playFever, perfect && !reduce ? 2300 : 0);
    if ($("poolnote")) settlePool();
    renderPower(); updateFever(); updateScatter();
    $("qnext").textContent = quiz.kind === "tutorial" ? "Finish the tutorial" : quiz.kind === "survival" ? (quiz.lives > 0 ? "Next question" : "Game over · see my score") : quiz.i + 1 >= quiz.order.length ? (bonusEarned() ? "Start the bonus round" : freeSpinEarned() ? "Take your free spin" : quiz.kind === "party" ? "See the final standings" : chestEarned() ? "Open a prize chest" : "See my score") : "Next question";
    if (quiz.i + 1 >= quiz.baseN && quiz.i + 1 >= quiz.order.length && freeSpinEarned()) res.insertAdjacentHTML("beforeend", `<p class="bonusnote"><b>A perfect round: every pin inside the right country!</b> You've earned a free spin: one more question with a mystery reward.</p>`);
    if (quiz.i + 1 === quiz.baseN && bonusEarned()) res.insertAdjacentHTML("beforeend", `<p class="bonusnote"><b>${!streakBonus() ? `${SCATTER_NEED} golden landmarks` : bonusNeed() === 10 ? "Ten in a row" : `${bonusNeed()} in a row on ${DIFFS[quiz.cfg.diff].label}`}! Bonus round unlocked.</b> Three more questions, ${TIMER_S} seconds each. Run out of time on one and the bonus round ends there.</p>`);
    $("qnext").hidden = false;
    $("qnext").focus({ preventScroll: true });
    wrap.classList.remove("noborders");
    if (quiz.kind === "party") renderStandings();
    // Narrow screens (the panel sits under the globe): show the map first, let the flight and the
    // zoom to the answer play out, then bring the result into view.
    clearTimeout(revealScrollT);
    if (window.matchMedia("(max-width: 860px)").matches) {
      if (reduce) res.scrollIntoView({ block: "nearest" });
      else {
        wrap.scrollIntoView({ block: "start", behavior: "smooth" });
        revealScrollT = setTimeout(() => { if (quiz && quiz.revealed && !quiz.done) res.scrollIntoView({ block: "start", behavior: "smooth" }); }, km > 0 ? 3100 : 1500);
      }
    }
    paintClasses();
    // Fly out to frame the pin and the answer while the plane draws the route, then zoom in on the country.
    const zoomIn = () => flyTo(ans, Math.max(1.8, targetZoom(ans, 7)), { duration: 1200, dip: 0 });
    if (quiz.line) {
      const mid = d3.geoInterpolate(quiz.pin, c)(0.5), deg = d3.geoDistance(quiz.pin, c) * 180 / Math.PI;
      const q = quiz;
      flyToPoint(mid, Math.max(1, Math.min(3, 70 / Math.max(deg, 1))), {
        duration: 1500, dip: 0.15,
        onTick: (t) => { q.lineT = t; },
        onEnd: () => { q.lineT = 1; if (quiz === q && q.revealed) setTimeout(() => { if (quiz === q && q.revealed && !q.done) zoomIn(); }, 350); }
      });
    } else { quiz.lineT = 1; zoomIn(); }
  }
  // Learn from mistakes: how to tell the answer from the country you picked, from the map and the cards.
  function tellApartHTML(ans, pick) {
    const card = (f) => ({ name: nameOf(f), at: centroidOf(f), area: info(f.id)?.area || 0, cap: info(f.id)?.cap || "" });
    const km = d3.geoDistance(centroidOf(ans), centroidOf(pick)) * 6371;
    return `<p class="tellapart"><span class="pinnote-label">Telling them apart</span>${esc(L.tellApart(card(ans), card(pick), km))}</p>`;
  }
  // Bonus round: in a solo round, get 10 right in a row on Easy (9 on Hard, 8 on Expert) and three more questions follow (a
  // flag, a shape and a capital when possible), each on a 20-second clock with the speed bonus. Run out
  // of time on one and the bonus round ends; the rest are never shown.
  const BONUS_N = 3;
  // How many right in a row unlock it: harder levels need fewer, since each answer is harder to get.
  const BONUS_NEED = { easy: 10, medium: 10, hard: 9, expert: 8 };
  // The daily is 5 questions, so there it takes all 5.
  const bonusNeed = () => Math.min(BONUS_NEED[quiz.cfg.diff] || 10, quiz.baseN);
  // Rounds with a bonus round, free spin and prize chest at the end: solo quizzes (10 questions) and the daily (5).
  const extrasRound = () => !!quiz && ((quiz.kind === "solo" && quiz.baseN >= 10) || (quiz.kind === "daily" && quiz.baseN >= 5));
  function bonusEarned() {
    if (!extrasRound() || quiz.bonusOver || quiz.order.length > quiz.baseN) return false;
    if (quiz.log.length < quiz.baseN) return false;
    return streakBonus() || (quiz.scatters || 0) >= SCATTER_NEED;
  }
  // The bonus round's usual way in: enough right answers in a row.
  function streakBonus() {
    let run = 0, best = 0;
    myRun().items.slice(0, quiz.baseN).forEach((it) => { run = it && it.right ? run + 1 : 0; best = Math.max(best, run); });
    return best >= bonusNeed();
  }
  function addBonusQuestions() {
    const used = new Set(quiz.qs.map((q) => q.a));
    const pool = shuffle(withFacts().filter((f) => !used.has(String(f.id))));
    const make = (test, key) => {
      for (const f of pool) {
        if (used.has(String(f.id))) continue;
        const q = { a: String(f.id), f: Math.floor(Math.random() * factsOf(f.id).length), o: shuffle([f, ...distractors(f, 3)]).map((x) => String(x.id)), b: 1 };
        if (!test(q)) continue;
        q[key] = 1; used.add(q.a); return q;
      }
      return null;
    };
    const qs = [make(flagRoundOK, "fl"), make((q) => (info(q.a)?.area || 0) >= 80000, "s"), make(capitalRoundOK, "cp")].filter(Boolean).slice(0, BONUS_N);
    quiz.qs = quiz.qs.concat(qs);
    quiz.order = quiz.order.concat(qs.map((q) => byId.get(q.a)));
    sfx("streak");
    announce("Bonus round: three questions, twenty seconds each.");
  }
  // Bonus round countdown: "BONUS ROUND · 3 questions · 20 seconds each", then 3, 2, 1, GO over the
  // globe. Nothing can be pinned or picked until it's done, and the clock starts at GO.
  const COUNT_FROM = 3;
  let countdownT = null;
  function bonusCountdown() {
    const el = $("bonusfx"), n0 = COUNT_FROM, total = quiz.order.length - quiz.baseN;
    quiz.holding = true;
    quiz.startedAt = Date.now() + n0 * 1000;
    $("qplay").classList.add("holding");
    let n = n0;
    const draw = () => {
      el.innerHTML = `<b>BONUS ROUND</b><span>${plural(total, "question")} · ${TIMER_S} seconds each</span><i class="${n ? "" : "go"}">${n || "GO!"}</i><small>${n ? "The clock starts at GO. Run out of time and the bonus round ends." : ""}</small>`;
      sfx(n ? "pin" : "streak");
    };
    el.hidden = false;
    draw();
    announce(`Bonus round: ${total} questions, ${TIMER_S} seconds each. Starting in ${n0} seconds.`);
    clearInterval(countdownT);
    countdownT = setInterval(() => {
      n -= 1;
      draw();
      if (n <= 0) {
        clearInterval(countdownT);
        quiz.holding = false; $("qplay").classList.remove("holding");
        countdownT = setTimeout(() => { el.hidden = true; el.innerHTML = ""; }, 700);
      }
    }, 1000);
  }
  function endCountdown() { clearInterval(countdownT); clearTimeout(countdownT); if (quiz) quiz.holding = false; $("qplay").classList.remove("holding"); $("bonusfx").hidden = true; $("bonusfx").innerHTML = ""; }
  // Out of time on a bonus question: show the answer, and the bonus round ends here.
  // Running out of time in the bonus round ends it, unless you take the "Continue?" offer: within
  // 10 seconds, give up half the bonus points won so far to keep going (once per round).
  let continueTimer = null;
  function bonusTimeout() {
    const ans = quiz.answer;
    quiz.kms.push(0);
    quiz.log.push({ timeout: true, choice: null, pin: null, hints: quiz.hints.slice(), ms: null, bet: 0 });
    quiz.results.push(0);
    quiz.revealed = true; quiz.locked = true;
    const left = quiz.order.length - quiz.i - 1;
    setLockedUI(); setHeat(0); updateCombo(0, (quiz.heat || 0) > 0); sfx("wrong");
    quiz.heat = 0;
    selected = ans; paintClasses();
    const res = $("qresult");
    res.className = "qresult no";
    ["qprompt", "qsteps", "qlock", "qtypeform", "qelim", "qcluehead"].forEach((id) => { $(id).hidden = true; });
    $("qhints").innerHTML = "";
    flyTo(ans, Math.max(1.8, targetZoom(ans, 7)), { duration: 1200, dip: 0 });
    if (left > 0 && !quiz.continued) {
      const won = myRun().items.slice(quiz.baseN).reduce((a, it) => a + (it && it.pts > 0 ? it.pts : 0), 0), cost = Math.floor(won / 2);
      quiz.continueCost = cost; quiz.pendingContinue = true;
      res.innerHTML = `<span class="pts">+0</span>Time's up! It was ${esc(nameOf(ans))}.
        <div class="continue"><b>Continue?</b> <span class="count" id="qcount">10</span>
        <p>${cost ? `Give up half your bonus points (${plural(cost, "point")}) to keep going.` : "Keep going for free: you haven't won bonus points yet."}</p>
        <button class="btn primary" id="qcontinue" type="button">Continue${cost ? ` (−${cost})` : ""}</button></div>`;
      res.hidden = false;
      $("qnext").textContent = "End the bonus round"; $("qnext").hidden = false;
      $("qcontinue").onclick = () => {
        clearInterval(continueTimer);
        quiz.continued = true; quiz.pendingContinue = false;
        quiz.penalty = (quiz.penalty || 0) + cost; quiz.score -= cost;
        announce(cost ? `Continuing. ${cost} points spent.` : "Continuing.");
        nextQuestion();
      };
      $("qcontinue").focus({ preventScroll: true });
      announce(`Time's up. It was ${nameOf(ans)}. Continue? You have 10 seconds.`);
      let n = 10;
      clearInterval(continueTimer);
      continueTimer = setInterval(() => {
        n -= 1;
        if ($("qcount")) $("qcount").textContent = String(n);
        if (n <= 0) { clearInterval(continueTimer); endBonusRound(); }
      }, 1000);
      return;
    }
    quiz.pendingContinue = true;
    endBonusRound();
  }
  // The bonus round is over: drop its remaining questions.
  function endBonusRound() {
    clearInterval(continueTimer);
    if (!quiz || !quiz.pendingContinue) return;
    quiz.pendingContinue = false; quiz.bonusOver = true;
    const left = quiz.order.length - quiz.i - 1, ans = quiz.answer;
    quiz.qs = quiz.qs.slice(0, quiz.i + 1); quiz.order = quiz.order.slice(0, quiz.i + 1);
    const res = $("qresult");
    res.className = "qresult no";
    res.innerHTML = `<span class="pts">+0</span>Time's up! It was ${esc(nameOf(ans))}.<p class="bonusnote">The bonus round ends here${left ? `, and the last ${plural(left, "bonus question")} won't be played` : ""}.</p>`;
    res.hidden = false;
    $("qnext").textContent = chestEarned() ? "Open a prize chest" : "See my score"; $("qnext").hidden = false; $("qnext").focus({ preventScroll: true });
    announce(`The bonus round is over.`);
  }
  // Betting: after a reveal, stake a share of your points on naming the next country right, before
  // you see its clue. Win it (double on the final question, less any hint %), or lose it.
  function betSliderHTML() {
    if (quiz.i + 1 >= quiz.baseN || quiz.score <= 0) return ""; // no bets after the final or in the bonus round
    const fin = quiz.i + 2 === quiz.baseN;
    return `<div class="betbox">
      <label class="bethead" for="qbet"><span class="pinnote-label">Bet on the next question</span><b id="qbetout">No bet</b></label>
      <input type="range" id="qbet" min="0" max="50" step="5" value="0" aria-describedby="qbethelp">
      <div class="betscale" aria-hidden="true"><span>No bet</span><span>Half your points</span></div>
      <div class="betodds"><span class="win">Name it right<b id="qbetwin">+0</b></span><span class="lose">Name it wrong<b id="qbetlose">−0</b></span></div>
      <small id="qbethelp">You have ${quiz.score} points. Choose before you see the next clue.${fin ? " The final question pays bets double." : ""} A win is never more than that question scores, and clues cut it by their percentage.</small></div>`;
  }
  function wireBetSlider() {
    const el = $("qbet");
    if (!el) return;
    const fin = quiz.i + 2 === quiz.baseN;
    const show = () => {
      const pct = Number(el.value), pts = Math.round(quiz.score * pct / 100);
      quiz.nextBet = pct / 100;
      $("qbetout").textContent = pct ? `${pct}% · ${pts} points` : "No bet";
      $("qbetwin").textContent = pct ? `up to +${pts * (fin ? 2 : 1)}` : "+0";
      $("qbetlose").textContent = `−${pts}`;
      el.style.setProperty("--fill", `${pct * 2}%`);
      $("qbetout").closest(".betbox").classList.toggle("hot", pct >= 30);
    };
    el.addEventListener("input", show);
    show();
  }
  function endQuiz() {
    stopTimer();
    clearPerfect();
    recordFactStats();
    wrap.classList.remove("noborders");
    clearFever(); clearScatter();
    $("qpower").hidden = true;
    if (quiz.kind === "solo" || quiz.kind === "daily") notePoolPlay();
    if (powerOK()) keepPowers(quiz.powers);
    if (quiz.kind === "party") return mpEnd();
    if (quiz.kind === "daily") return dailyEnd();
    if (quiz.kind === "challenge") return challengeEnd();
    const n = quiz.order.length, s = quiz.score, max = maxFor(quiz.cfg, quiz.qs, quiz.baseN), cfg = quiz.cfg;
    const key = `atlas-best2-${cfg.diff}`, best = Math.max(Number(lsGet(key) || 0), s);
    lsSet(key, String(best));
    quiz.done = true; quiz.revealed = false; quiz.line = null; quiz.pin = null;
    bumpStat("quizzes");
    if (myRun().items.slice(0, quiz.baseN).every((it) => it && it.right)) unlock("perfect");
    if (cfg.diff === "expert") unlock("expert");
    if (cfg.diff !== "easy" && quiz.usedHints === 0 && quiz.names >= 5) unlock("nohints");
    showQuizPart("end");
    $("qbest").textContent = `Best on ${DIFFS[cfg.diff].label}: ${best}`;
    $("qfinal").innerHTML = `${s} <span class="of">of ${max}</span>`;
    const avg = quiz.kms.reduce((a, b) => a + b, 0) / n;
    const tier = s >= max * 0.7 ? "Expert navigator." : s >= max * 0.5 ? "Well traveled." : s >= max * 0.3 ? "A solid start." : "Plenty of the world left to discover.";
    const rev = getReview().length;
    const bonusLog = quiz.log.slice(quiz.baseN).map((a, j) => [a, quiz.qs[quiz.baseN + j]]).filter(([, q]) => q && q.b);
    const bonusPlayed = bonusLog.length, bonusRight = bonusLog.filter(([a, q]) => !a.timeout && a.choice === q.a).length;
    const bonusMsg = bonusPlayed > 0 ? ` Bonus round: ${bonusRight} of ${BONUS_N} named${quiz.bonusOver ? ", until the clock ran out" : ""}.` : "";
    $("qmsg").textContent = `${tier} You named ${quiz.names} of ${n} countries, and your pins landed ${fmtKm(avg)} away on average.${rev ? ` ${plural(rev, "country", "countries")} on your review list will come back in later rounds.` : ""}${bonusMsg}`;
    $("qdots").innerHTML = dotsHTML(myRun().items, quiz.cfg);
    showEndHiscores(cfg.diff, s);
    $("qnum").textContent = "Finished";
    $("qbar").style.width = "100%";
    $("qagain").textContent = "Play again";
    $("qsettings").hidden = false;
    $("qchallenge").hidden = STANDALONE;
    offerShareImage();
    selected = null; paintClasses(); render();
  }
  // One dot per answer, colored by how good the answer was (name, pin, speed), not by its points.
  const qualityClass = (q) => (q >= 0.75 ? "ok" : q >= 0.4 ? "mid" : "");
  const dotHTML = (pts, q) => `<i class="${qualityClass(q)}" title="${pts} points"></i>`;
  const dotsHTML = (items, cfg) => items.map((it) => dotHTML(it.pts, L.answerQuality(it, cfg))).join("");
  $("qlock").onclick = () => lockIn();
  $("qnext").onclick = () => nextQuestion();
  $("qstart").onclick = () => { const cfg = readSetup("solo"); if (cfg.survival) startSurvival(cfg); else startQuiz(cfg); };
  $("qsettings").onclick = () => showSetup();
  $("qhometipx").onclick = () => { lsSet("atlas-hometip", "1"); $("qhometip").hidden = true; };
  // Tests only: which country is the current answer.
  if (window.ATLAS_TEST) window.__optionContinents = () => ({ answer: info(quiz.answer.id)?.cont, others: [...document.querySelectorAll("#qopts .opt")].map((b) => b.dataset.id).filter((id) => id !== String(quiz.answer.id)).map((id) => info(id)?.cont) });
  if (window.ATLAS_TEST) window.__answerId = () => (quiz && quiz.answer ? String(quiz.answer.id) : null);
  if (window.ATLAS_TEST) window.__answerCenter = () => (quiz && quiz.answer ? centroidOf(quiz.answer) : null);
  // ---- 45-factstats.js ----
  // Fact difficulty: how often players get each fact question right, so a fact most people miss pays
  // more (up to × 1.25) and one nearly everyone gets pays a little less (× 0.9). Each player keeps one
  // tally, factstats/<player>, written once at the end of a quiz; the totals over all players are read
  // when a quiz starts, at most twice a day, cached in this browser and used from the next round on. A fact needs FD_MIN answers before it counts. The
  // daily challenge leaves it out, so everyone's daily is worth the same.
  const FD_MIN = 20, FD_TTL = 12 * 3600 * 1000, FD_MAX_PER_PLAYER = 50;
  let factDiff = lsJSON("atlas-factdiff", null);
  const factKey = (spec) => `${spec.a}:${spec.f}`;
  const isFactQuestion = (spec) => spec && !roundKind(spec) && !spec.b;
  function factDiffOf(spec) {
    const d = factDiff && factDiff.d ? factDiff.d[factKey(spec)] : null;
    return Number.isFinite(d) ? L.factMult(d) : 1;
  }
  function diffFromRate(n, right) {
    if (n < FD_MIN) return 1;
    return Math.round(Math.min(1.25, Math.max(0.9, 1 + (0.6 - right / n) * 0.5)) * 20) / 20;
  }
  // Tallies come from other players' browsers, so each is checked and capped before it counts.
  function totalTallies(docs) {
    const tot = {};
    docs.forEach((t) => {
      if (!t || typeof t !== "object") return;
      for (const [k, v] of Object.entries(t)) {
        if (!/^[A-Za-z0-9]+:\d+$/.test(k) || !Array.isArray(v)) continue;
        const n = Math.min(FD_MAX_PER_PLAYER, Math.max(0, Math.floor(Number(v[0]) || 0))), r = Math.min(n, Math.max(0, Math.floor(Number(v[1]) || 0)));
        const x = tot[k] || (tot[k] = [0, 0]); x[0] += n; x[1] += r;
      }
    });
    const d = {};
    for (const [k, [n, r]] of Object.entries(tot)) { const m = diffFromRate(n, r); if (m !== 1) d[k] = m; }
    return d;
  }
  async function refreshFactDiff(force = false) {
    if (!force && factDiff && Date.now() - factDiff.at < FD_TTL) return;
    if (!(await initMp()) || !mp.db) return;
    try {
      const snap = await mp.db.collection("factstats").get();
      factDiff = { at: Date.now(), d: totalTallies(snap.docs.map((doc) => (doc.data() || {}).t)) };
      lsSaveJSON("atlas-factdiff", factDiff);
    } catch (e) { /* no stats this time; facts pay normally */ }
  }
  // Mark the tricky facts in a freshly built round (not the daily).
  function applyFactDiff(qs) {
    qs.forEach((q) => { if (isFactQuestion(q)) { const d = factDiffOf(q); if (d !== 1) q.d = d; else delete q.d; } });
    return qs;
  }
  async function recordFactStats() {
    const q = quiz; // the quiz may be replaced while this waits on the database
    if (!q || q.statsSaved) return;
    q.statsSaved = true;
    const add = {};
    q.log.forEach((a, j) => {
      const spec = q.qs[j];
      if (!isFactQuestion(spec) || !a) return;
      const x = add[factKey(spec)] || (add[factKey(spec)] = [0, 0]);
      x[0] += 1; if (!a.timeout && a.choice === spec.a) x[1] += 1;
    });
    if (!Object.keys(add).length || (await initMp()) !== true || !mp.pid) return;
    try {
      const ref = mp.db.doc(`factstats/${mp.pid}`), snap = await ref.get();
      const t = (snap.exists && snap.data() && snap.data().t) || {};
      for (const [k, [n, r]] of Object.entries(add)) { const old = Array.isArray(t[k]) ? t[k] : [0, 0]; t[k] = [Math.min(FD_MAX_PER_PLAYER, (old[0] | 0) + n), Math.min(FD_MAX_PER_PLAYER, (old[1] | 0) + r)]; }
      await ref.set({ v: 1, t });
    } catch (e) { /* a tally is a nice-to-have; never interrupt the end screen */ }
  }
  // ---- 45-skins.js ----
  /* ---------- Skins ---------- */
  // Everyone plays on Neon Night: the dark neon interface with the Glow map. Every other look is a
  // skin you win by playing. Each has a goal measured from your progress on this browser; once a goal
  // is reached the skin stays yours (atlas-skins), even if the progress is later reset.
  // look: the globe's color set (a .look-* class on the globe; none for Glow). theme: the interface.
  // swatch: [ocean, land colors..., border] for the picker's little globe.
  const SKINS = [
    { id: "glow", name: "Neon Night", desc: "The original: a teal neon globe on a deep purple night.", theme: "dark", swatch: ["#071c27", "#3aa892", "#3aa892", "#3aa892", "#0b2a2c"] },
    { id: "daylight", name: "Daylight", desc: "The soft lavender interface with a sunlit globe.", theme: "light", need: { stat: "quizzes", n: 1, text: "Finish a round" }, swatch: ["#cfe8f2", "#6fbfa5", "#6fbfa5", "#6fbfa5", "#ffffff"] },
    { id: "cyanline", name: "Cyan Neon", desc: "Bright cyan lines between the countries.", look: "cyanline", theme: "dark", need: { stat: "perfects", n: 10, text: "Make 10 perfect answers" }, swatch: ["#071c27", "#3aa892", "#3aa892", "#3aa892", "#7ff9ff"] },
    { id: "vivid", name: "Vivid", desc: "Every country in its own bright color.", look: "vivid", theme: "dark", need: { stat: "answered", n: 25, text: "Answer 25 questions" }, swatch: ["#0f2c40", "#2fae99", "#dba543", "#8574e6", "#0b1a24"] },
    { id: "pastel", name: "Pastel", desc: "Soft, muted country colors.", look: "pastel", theme: "dark", need: { stat: "dailies", n: 3, text: "Play 3 daily challenges" }, swatch: ["#142a36", "#4f8f84", "#a78a4c", "#6d64a8", "#0b1a24"] },
    { id: "magentaline", name: "Magenta Neon", desc: "Magenta lines between the countries, to match the buttons.", look: "magentaline", theme: "dark", need: { stat: "quizzes", n: 5, text: "Finish 5 rounds" }, swatch: ["#071c27", "#3aa892", "#3aa892", "#3aa892", "#ff3fd2"] },
    { id: "frost", name: "Frost", desc: "Ice-white land and glacier-blue borders on a polar sea.", look: "frost", theme: "dark", need: { stat: "stamps", n: 50, text: "Stamp 50 places in your Passport" }, swatch: ["#061826", "#d6edf7", "#b9dcef", "#e3f3fa", "#4f9fd0"] },
    { id: "ember", name: "Ember", desc: "Molten land with glowing lava borders on a dark sea.", look: "ember", theme: "dark", need: { stat: "fevers", n: 3, text: "Start 3 Fevers (5 perfects in a row)" }, swatch: ["#120806", "#b8361c", "#d4521f", "#9e2a16", "#ffb347"] },
    { id: "glowline", name: "Glow Line", desc: "Thick dark borders with a thin cyan glow.", look: "glowline", theme: "dark", need: { stat: "answered", n: 100, text: "Answer 100 questions" }, swatch: ["#071c27", "#3aa892", "#3aa892", "#3aa892", "#031417"] },
    { id: "atlas", name: "Old Atlas", desc: "Parchment land and dashed ink borders, like an antique map.", look: "atlas", theme: "dark", need: { stat: "sets", n: 1, text: "Complete a continent set in your Passport" }, swatch: ["#5f7f7a", "#e8d8b0", "#dcc79a", "#efe0bb", "#6b4f2a"] },
    { id: "deepsea", name: "Deep Sea", desc: "Glowing aqua lines over a midnight ocean, like bioluminescence.", look: "deepsea", theme: "dark", need: { stat: "bullseyes", n: 25, text: "Land 25 pins inside the right country" }, swatch: ["#020a1a", "#0f5e63", "#127a73", "#16867a", "#40ffd2"] },
    { id: "sunset", name: "Sunset", desc: "Coral and peach land on a violet sea.", look: "sunset", theme: "dark", need: { stat: "dailies", n: 7, text: "Play 7 daily challenges" }, swatch: ["#1c0a2e", "#ff8a65", "#ffb26b", "#f06292", "#3a0f2b"] },
    { id: "blueprint", name: "Blueprint", desc: "White lines on blueprint blue, like a plan of the world.", look: "blueprint", theme: "dark", need: { stat: "quizzes", n: 25, text: "Finish 25 rounds" }, swatch: ["#0b3a6e", "#14508c", "#124a82", "#16558f", "#e8f1ff"] },
    { id: "terminal", name: "Terminal", desc: "Green-on-black lines, like an old computer screen.", look: "terminal", theme: "dark", need: { stat: "survbest", n: 1500, text: "Score 1,500 in one Survival game" }, swatch: ["#000000", "#0b3d1a", "#0e4a20", "#105226", "#00ff66"] },
    { id: "candy", name: "Candy", desc: "Bright pastel neon countries on a grape sea.", look: "candy", theme: "dark", need: { stat: "answered", n: 250, text: "Answer 250 questions" }, swatch: ["#2b1145", "#ff9ff3", "#feca57", "#48dbfb", "#ffffff"] },
    { id: "gold", name: "Gold Rush", desc: "Gilded land on a midnight-navy sea.", look: "gold", theme: "dark", need: { stat: "perfects", n: 50, text: "Make 50 perfect answers" }, swatch: ["#070b1f", "#d4a93a", "#e0b84a", "#b98c26", "#3a2a05"] }
  ];
  const skinOf = (id) => SKINS.find((s) => s.id === id) || SKINS[0];
  function skinProgress(stat) {
    const st = getStats();
    if (stat === "dailies") return loadDaily().played || 0;
    if (stat === "stamps") return Object.keys(getStamps()).length;
    if (stat === "sets") return Object.keys(getSets()).length;
    if (stat === "survbest") return Math.max(Number(lsGet("atlas-best2-survival") || 0), ...(lsJSON("atlas-mybest", {}).survival || []).map((r) => r.s || 0));
    return st[stat] || 0;
  }
  const wonSkins = () => lsJSON("atlas-skins", {});
  const skinOpen = (s) => !s.need || !!wonSkins()[s.id] || skinProgress(s.need.stat) >= s.need.n;
  // Record newly reached goals; quietly at startup, with a toast when it happens in play.
  function checkSkins(quiet = false) {
    const won = wonSkins();
    let changed = false;
    SKINS.forEach((s) => {
      if (!s.need || won[s.id] || skinProgress(s.need.stat) < s.need.n) return;
      won[s.id] = Date.now(); changed = true;
      if (!quiet) { toastQueue.push({ kind: "Skin unlocked", title: s.name, desc: "Pick it from Skin, above the globe." }); showNextToast(); }
    });
    if (changed) lsSaveJSON("atlas-skins", won);
  }
  function applySkin(id) {
    const s = skinOf(id), use = skinOpen(s) ? s : SKINS[0];
    document.documentElement.dataset.theme = use.theme;
    SKINS.forEach((x) => { if (x.look) wrap.classList.toggle(`look-${x.look}`, x === use); });
    $("skinbtn").innerHTML = `Skin<span class="skinname"> · ${esc(use.name)}</span>`;
    return use.id;
  }
  // The picker: every skin with a little globe in its colors; locked ones show their goal and progress.
  const swatchSVG = (c) => `<svg viewBox="0 0 60 60" aria-hidden="true"><circle cx="30" cy="30" r="27" fill="${c[0]}" stroke="${c[4]}" stroke-width="1.5"></circle><path d="M12 24 C18 14 30 12 36 18 C40 22 34 28 40 32 C44 36 38 44 30 40 C24 37 20 34 14 32 Z" fill="${c[1]}" stroke="${c[4]}" stroke-width="1.6"></path><path d="M38 12 C44 12 50 18 48 24 C46 28 40 26 38 22 Z" fill="${c[2]}" stroke="${c[4]}" stroke-width="1.6"></path><path d="M22 44 C26 42 32 46 30 52 C26 54 20 50 22 44 Z" fill="${c[3]}" stroke="${c[4]}" stroke-width="1.6"></path></svg>`;
  function openSkins() {
    checkSkins();
    const cur = lsGet("atlas-look") || "glow", el = $("skincard");
    el.innerHTML = `<div class="tutbox skinbox" role="dialog" aria-modal="true" aria-labelledby="skinhead"><span class="cat">Skins</span><h3 id="skinhead">Choose your look</h3>
      <p>Neon Night is yours from the start. Win the others by playing.</p>
      <ul class="skins">${SKINS.map((s) => {
        const open = skinOpen(s), on = open && skinOf(cur).id === s.id, p = s.need ? Math.min(s.need.n, skinProgress(s.need.stat)) : 0;
        return `<li class="${open ? "" : "locked"}${on ? " on" : ""}"><button type="button" data-id="${s.id}"${open ? "" : ' aria-disabled="true"'} aria-label="${esc(`${s.name}: ${open ? (on ? "in use" : "use this skin") : `locked. ${s.need.text}, ${p} of ${s.need.n}`}`)}">
          <span class="sw">${swatchSVG(s.swatch)}${open ? "" : '<i class="lock" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="10" rx="2"></rect><path d="M8 11V8a4 4 0 0 1 8 0v3"></path></svg></i>'}</span>
          <b>${esc(s.name)}</b><small>${esc(open ? s.desc : s.need.text)}</small>
          ${open ? `<em>${on ? "In use" : "Use"}</em>` : `<span class="bar" aria-hidden="true"><i style="width:${(p / s.need.n) * 100}%"></i></span><em>${p} of ${s.need.n}</em>`}</button></li>`;
      }).join("")}</ul>
      <div class="actions"><button type="button" class="btn" id="skinclose">Done</button></div></div>`;
    el.hidden = false;
    el.querySelectorAll(".skins button").forEach((b) => {
      b.onclick = () => {
        const s = skinOf(b.dataset.id);
        if (!skinOpen(s)) return;
        lsSet("atlas-look", applySkin(s.id));
        sfx("power");
        openSkins();
      };
    });
    $("skinclose").onclick = closeSkins;
    el.onclick = (e) => { if (e.target === el) closeSkins(); };
    $("skinclose").focus({ preventScroll: true });
  }
  const closeSkins = () => { $("skincard").hidden = true; $("skincard").innerHTML = ""; $("skinbtn").focus({ preventScroll: true }); };
  $("skinbtn").onclick = () => openSkins();
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("skincard").hidden) closeSkins(); });
  if (window.ATLAS_TEST) window.__skinsWon = () => Object.keys(wonSkins());
  // ---- 46-tutorial.js ----
  /* ---------- First-time tutorial ---------- */
  // On a player's first visit a welcome card offers a practice question about a famous country. A
  // coach card walks through it step by step (read the clue, choose the country, drop the pin, lock
  // in, read the points), waiting for the player at each step, then ends with a few tips. The
  // practice question doesn't count toward scores. "Take the tutorial" on the quiz setup replays it.
  const TUT_KEY = "atlas-tutorial";
  const TUT_ANSWER = "250"; // France: well known, with a famous landmark to read about
  let tut = null; // { step, target } while the tutorial runs

  const STEPS = [
    { id: "clue", target: "#qfact", text: "<b>This is your clue.</b> The country's name is hidden. Read it and think where it could be.", next: "Got it" },
    { id: "name", target: "#qopts", text: "<b>Step 1 · Choose the country</b> you think the clue is about.", until: () => !!quiz.choice },
    { id: "pin", target: "#wrap", text: "<b>Step 2 · Tap the globe</b> where that country is. Drag to spin it, pinch or use + and − to zoom. A pin inside the country is a perfect pin.", until: () => !!quiz.pin },
    { id: "lock", target: "#qlock", text: "<b>Step 3 · Lock in</b> to see how you did. Until then you can change your country or move your pin.", until: () => quiz.revealed },
    { id: "result", target: "#qresult", text: "<b>Your points:</b> up to 50 for the country and up to 50 for the pin, more the closer it lands. Right answers in a row build a streak that multiplies your points.", next: "Next", wait: 2600 }
  ];

  const tutDone = () => !!lsGet(TUT_KEY);
  function maybeTutorial() {
    if (tutDone() || window.__noTutorial || tut) return;
    if ((getStats().answered || 0) > 0) { lsSet(TUT_KEY, "veteran"); return; }
    showTutCard(`<span class="cat">Welcome to Curious Atlas</span>
      <h3>Find countries from clues</h3>
      <p>Each question gives you a clue. Choose the country, drop a pin on the globe where it is, and lock in. Let's try one practice question together. It doesn't count toward your score.</p>`,
      [["Start the tutorial", startTutorial, true], ["Skip", skipTutorial]]);
  }
  function skipTutorial() { lsSet(TUT_KEY, "skipped"); closeTut(); }
  function startTutorial() {
    hideTutCard();
    if (mode !== "quiz") setMode("quiz");
    const f = byId.get(TUT_ANSWER);
    if (!f) { closeTut(); return; }
    const facts = factsOf(TUT_ANSWER), fi = Math.max(0, facts.findIndex((x) => /Eiffel/.test(x[1])));
    const q = { a: TUT_ANSWER, f: fi, o: shuffle([TUT_ANSWER, "076", "392", "036"].filter((id) => byId.has(id))) };
    newQuiz("tutorial", { diff: "easy", timer: false }, [q]);
    quiz.powers = [];
    tut = { step: -1 };
    nextQuestion();
    $("qnum").textContent = "Practice question";
    $("qscore").textContent = "Tutorial · doesn't count";
    tutStep(0);
  }
  function tutStep(i) {
    if (!tut) return;
    tut.step = i;
    const s = STEPS[i];
    if (!s) return tutTips();
    const go = () => { if (tut && tut.step === i) tutStep(i + 1); };
    showCoach(s.target, s.text, s.next ? [[s.next, go, true]] : []);
    if (s.until) tut.until = () => { if (tut && tut.step === i && s.until()) { tut.until = null; setTimeout(go, s.id === "lock" ? 300 : 150); } };
    else tut.until = null;
    // The answer's map animation plays first (on a phone the page scrolls to the globe), then the card.
    if (s.wait) { $("coach").hidden = true; setTimeout(() => { if (tut && tut.step === i) { $("coach").hidden = false; placeCoach(); } }, window.matchMedia("(max-width: 860px)").matches ? 3300 : s.wait); }
  }
  // Called whenever the answer state changes (from updateSteps), to move the tutorial along.
  const tutTick = () => { if (tut && tut.until) tut.until(); };
  // After the practice question: what power-ups do, how betting works, then a few last tips.
  function tutTips() {
    hideCoach();
    lsSet(TUT_KEY, "done");
    const pw = Object.values(L.POWERS).map((p) => `<li><span class="tpicon" aria-hidden="true">${esc(p.icon)}</span><span><b>${esc(p.label)}</b> ${esc(p.desc)}</span></li>`).join("");
    showTutCard(`<span class="cat">Power-ups · 1 of 3</span>
      <h3>Power-ups</h3>
      <p>A perfect answer (right country, pin inside it) can drop one, and so does every ${L.POWER_EVERY.toLocaleString("en-US")} points, up to ${L.POWER_ROUND_MAX} a game. Everyone gets a free Second chance each day. Hold up to ${L.POWER_MAX}; they wait for your next game. Press a symbol to use it on the current question.</p>
      <ul class="tppowers">${pw}</ul>`,
      [["Next: betting", tutBetting, true], ["Skip to the end", tutReady]]);
  }
  function tutBetting() {
    showTutCard(`<span class="cat">Betting · 2 of 3</span>
      <h3>Betting</h3>
      <p>After each answer you can bet on the next question, before you see its clue. Slide to stake up to half the points you have.</p>
      <ul>
        <li><b>Name it right:</b> you win your stake back as extra points, up to what that question scores (clues trim it). The final question pays bets double.</li>
        <li><b>Name it wrong:</b> you lose the stake.</li>
        <li>Leave the slider at No bet to play it safe.</li>
      </ul>`,
      [["Next", tutReady, true]]);
  }
  function tutReady() {
    showTutCard(`<span class="cat">You're ready · 3 of 3</span>
      <h3>A few more things</h3>
      <ul>
        <li><b>Clues</b> cost a share of a question's points. Use them when you're stuck.</li>
        <li><b>Streaks</b> multiply your points, and five perfects in a row start a Fever.</li>
        <li><b>Easy</b> is a great place to start. Medium, Hard and Expert pay more.</li>
        <li><b>Daily</b> is one puzzle a day for everyone. <b>Party</b> plays with friends.</li>
      </ul>`,
      [["Play my first round", () => { closeTut(); setMode("quiz"); startQuiz({ diff: "easy", timer: false }); }, true], ["Explore the globe", () => { closeTut(); setMode("explore"); }]]);
  }
  function closeTut() {
    tut = null;
    hideCoach(); hideTutCard();
    if (quiz && quiz.kind === "tutorial") { quiz = null; if (mode === "quiz") showSetup(); }
  }

  // The welcome and tips cards: centered over the page, with a dimmed backdrop.
  function showTutCard(html, buttons) {
    const el = $("tutcard");
    el.innerHTML = `<div class="tutbox" role="dialog" aria-modal="true" aria-labelledby="tuthead">${html.replace("<h3>", '<h3 id="tuthead">')}<div class="actions">${buttons.map(([label, , primary], i) => `<button type="button" class="btn${primary ? " primary" : ""}" data-i="${i}">${esc(label)}</button>`).join("")}</div></div>`;
    el.hidden = false;
    el.querySelectorAll("button").forEach((b) => { b.onclick = () => buttons[Number(b.dataset.i)][1](); });
    el.querySelector("button").focus({ preventScroll: true });
  }
  const hideTutCard = () => { $("tutcard").hidden = true; $("tutcard").innerHTML = ""; };

  // The coach card: next to the thing to do, with that thing ringed.
  function showCoach(sel, text, buttons) {
    const el = $("coach");
    el.innerHTML = `<p>${text}</p>${buttons.length ? `<div class="actions">${buttons.map(([label], i) => `<button type="button" class="btn primary" data-i="${i}">${esc(label)}</button>`).join("")}</div>` : ""}<button type="button" class="linkbtn coachskip">Skip tutorial</button>`;
    el.querySelectorAll(".actions button").forEach((b) => { b.onclick = () => buttons[Number(b.dataset.i)][1](); });
    el.querySelector(".coachskip").onclick = skipTutorial;
    document.querySelectorAll(".coachring").forEach((x) => x.classList.remove("coachring"));
    const t = document.querySelector(sel);
    if (t) t.classList.add("coachring");
    tut.target = sel;
    el.hidden = false;
    announce(el.querySelector("p").textContent);
    placeCoach();
    if (t && sel !== "#wrap") t.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    if (sel === "#wrap" && window.matchMedia("(max-width: 860px)").matches) t.scrollIntoView({ block: "start", behavior: reduce ? "auto" : "smooth" });
    setTimeout(placeCoach, 450);
  }
  function hideCoach() {
    $("coach").hidden = true; $("coach").innerHTML = "";
    document.querySelectorAll(".coachring").forEach((x) => x.classList.remove("coachring"));
  }
  // Below the target when there's room, otherwise above it; for the globe, over its lower part.
  function placeCoach() {
    const el = $("coach");
    if (!tut || el.hidden || !tut.target) return;
    const t = document.querySelector(tut.target);
    if (!t) return;
    const r = t.getBoundingClientRect(), w = Math.min(340, window.innerWidth - 24), h = el.offsetHeight, vh = window.innerHeight;
    let x = Math.max(12, Math.min(window.innerWidth - w - 12, r.left + r.width / 2 - w / 2)), y;
    // The globe: on a phone just below it (so nothing covers where you tap), on a wide screen along its
    // bottom edge.
    if (tut.target === "#wrap") y = window.matchMedia("(max-width: 860px)").matches ? Math.min(vh - h - 12, r.bottom + 8) : Math.max(12, Math.min(vh, r.bottom) - h - 16);
    else if (r.bottom + h + 16 < vh) y = r.bottom + 12;
    else if (r.top - h - 16 > 0) y = r.top - h - 12;
    else y = Math.max(12, vh - h - 90);
    el.style.width = `${w}px`; el.style.left = `${x}px`; el.style.top = `${y}px`;
  }
  // Leaving for another mode mid-tutorial ends it (it can be replayed from the quiz setup).
  function abortTutorial() { if (tut) { tut = null; hideCoach(); hideTutCard(); } }
  window.addEventListener("resize", placeCoach);
  window.addEventListener("scroll", placeCoach, { passive: true });
  $("qtutorial").onclick = () => startTutorial();
  // First visit: wait for the globe and the facts, then offer it.
  setTimeout(() => { if (byId.has(TUT_ANSWER)) maybeTutorial(); }, 1200);
  if (window.ATLAS_TEST) window.__startTutorial = () => startTutorial();
  // ---- 47-arcade.js ----
  /* ---------- Arcade extras ---------- */
  // Jackpot country, mystery multiplier, free spin, combo meter, near misses, rank titles, high
  // scores with initials and attract mode. Scoring for the multipliers lives in logic.js.

  // Today's secret jackpot country: the same for everyone on a given UTC day, worth JACKPOT × when
  // named right. Only places with facts can be quiz answers, so it's picked from those.
  function jackpotId(day = L.utcDayKey()) {
    const pool = withFacts().map((f) => String(f.id)).sort();
    return pool.length ? pool[Math.floor(seededRng("curious-atlas-jackpot:" + day)() * pool.length)] : null;
  }
  // Mark a freshly built round: the final question gets a mystery multiplier, and today's jackpot
  // country is flagged wherever it appears.
  function addArcadeExtras(qs, rnd) {
    if (!qs.length) return qs;
    qs[qs.length - 1].mm = L.weighted(L.MYSTERY, rnd());
    const jp = jackpotId();
    qs.forEach((q) => { if (q.a === jp) q.jp = 1; });
    return qs;
  }

  // Free spin: a perfect round (every base question right, with the pin inside) earns one more
  // question with a random reward multiplier, after any bonus round. Solo quizzes and the daily.
  function freeSpinEarned() {
    if (!extrasRound() || quiz.freeSpinGiven || quiz.log.length < quiz.baseN) return false;
    const items = myRun().items.slice(0, quiz.baseN);
    return items.every((it, j) => it && it.right && quiz.kms[j] === 0);
  }
  function addFreeSpin() {
    quiz.freeSpinGiven = true;
    const used = new Set(quiz.qs.map((q) => q.a));
    const f = shuffle(withFacts().filter((x) => !used.has(String(x.id))))[0];
    if (!f) return;
    const q = { a: String(f.id), f: Math.floor(Math.random() * factsOf(f.id).length), o: shuffle([f, ...distractors(f, 3)]).map((x) => String(x.id)), fs: 1, fsm: L.weighted(L.FREESPIN, Math.random()) };
    quiz.qs.push(q); quiz.order.push(f);
  }

  // The slot reel shown before a mystery-multiplier or free-spin question: three reels spin and
  // land, one after another, on the multiplier. Resolves when they've stopped.
  const SLOT_FACES = [1, 2, 3, 5];
  function playSlot(value, label) {
    const el = $("qslot");
    const strip = () => {
      const faces = []; for (let i = 0; i < 12; i++) faces.push(SLOT_FACES[i % SLOT_FACES.length]);
      faces.push(value);
      return faces.map((v) => `<span>×${v}</span>`).join("");
    };
    el.innerHTML = `<span class="slotlabel">${esc(label)}</span><span class="reels">${[0, 1, 2].map((i) => `<span class="reel"><span class="strip s${i}">${strip()}</span></span>`).join("")}</span><span class="slotout" aria-live="polite"></span>`;
    el.hidden = false;
    el.classList.remove("landed");
    el.scrollIntoView({ block: "nearest", behavior: reduce ? "auto" : "smooth" });
    const done = () => { const out = el.querySelector(".slotout"); if (!out) return; el.classList.add("landed"); out.textContent = `× ${value}`; sfx(value >= 3 ? "streak" : "right"); };
    clearTimeout(playSlot.t);
    if (reduce) { done(); return Promise.resolve(); }
    sfx("slot");
    return new Promise((res) => { playSlot.t = setTimeout(() => { done(); res(); }, 1650); });
  }
  const hideSlot = () => { clearTimeout(playSlot.t); const el = $("qslot"); el.hidden = true; el.innerHTML = ""; };

  // Combo meter: the streak multiplier as a bar that fills toward × 4, with marks where each step
  // lands; it shatters when a streak breaks.
  function updateCombo(heat, broke = false) {
    const el = $("qcombo");
    if (!quiz) { el.hidden = true; return; }
    const m = L.streakMult(heat || 0), fill = Math.log(m) / Math.log(L.STREAK_CAP);
    // Shown once there's a streak to show (or one just broke), so a first question starts calm.
    el.hidden = !(heat > 0 || broke);
    el.style.setProperty("--fill", fill.toFixed(3));
    el.classList.toggle("hot", m >= 2.25);
    el.classList.toggle("max", m >= L.STREAK_CAP);
    el.querySelector(".cval").textContent = `× ${+m.toFixed(2)}`;
    if (broke) { el.classList.remove("shatter"); void el.offsetWidth; el.classList.add("shatter"); }
  }

  // Near misses: say how close it was, so a miss still teaches the map (never invented: always the
  // real distance).
  function nearMissHTML(right, fi, km, ans) {
    if (!Number.isFinite(km) || km <= 0) return "";
    const nm = esc(nameOf(ans));
    if (fi && !right) { const over = Math.round(km - L.findKm(info(ans.id)?.area)); return over <= 150 ? `<p class="nearmiss">So close! Only ${fmtKm(over)} beyond the margin around ${nm}.</p>` : ""; }
    if (right && km <= 50) return `<p class="nearmiss">So close to a perfect: your pin was just ${fmtKm(km)} outside ${nm}.</p>`;
    if (!right && km <= 50) return `<p class="nearmiss">So close! Your pin was just ${fmtKm(km)} from ${nm}.</p>`;
    return "";
  }

  // Jackpot effect: a gold banner and a shower of coins over the globe.
  function playJackpot() {
    const el = $("jackpotfx");
    el.innerHTML = `<b>JACKPOT</b><span>× ${L.JACKPOT}</span>` + (reduce ? "" : Array.from({ length: 28 }, (_, i) => `<i style="left:${(i * 37) % 100}%;animation-delay:${((i * 0.071) % 0.9).toFixed(2)}s;--r:${(i * 47) % 360}deg"></i>`).join(""));
    el.hidden = false;
    el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
    sfx("jackpot");
    clearTimeout(playJackpot.t);
    playJackpot.t = setTimeout(() => { el.hidden = true; el.innerHTML = ""; }, 3600);
  }
  const clearJackpot = () => { clearTimeout(playJackpot.t); $("jackpotfx").hidden = true; $("jackpotfx").innerHTML = ""; };

  // Rank titles, earned with lifetime perfect answers.
  const RANKS = [[0, "Tourist"], [5, "Backpacker"], [15, "Navigator"], [40, "Explorer"], [100, "Cartographer"], [250, "Atlas"]];
  function rankOf(perfects = getStats().perfects || 0) {
    let i = 0; while (i + 1 < RANKS.length && perfects >= RANKS[i + 1][0]) i++;
    const next = RANKS[i + 1];
    return { title: RANKS[i][1], perfects, next: next ? next[1] : null, toNext: next ? next[0] - perfects : 0 };
  }
  const rankText = (r = rankOf()) => `${r.title}${r.next ? ` · ${plural(r.toNext, "more perfect")} to ${r.next}` : " · the top rank"}`;
  function notePerfect() {
    const before = rankOf().title;
    bumpStat("perfects");
    const after = rankOf();
    if (after.title !== before) { toastQueue.push({ title: after.title, desc: `New rank, earned with ${after.perfects} perfect answers.`, kind: "Rank up" }); showNextToast(); }
  }

  // High scores: arcade-style initials (three letters) and a top ten per board (each level, plus
  // Survival), in two lists. Global: shared on this page, one entry per qualifying game, so one player
  // can hold several places (topscores/<player>-<time>). Personal: this browser's own ten best per
  // board (atlas-mybest). The standalone site has only the personal list.
  const getInitials = () => (lsGet("atlas-initials") || "").replace(/[^A-Z]/g, "").slice(0, 3);
  const HI_PLACES = 10;
  const HI_BOARDS = () => [...Object.keys(DIFFS), "survival"];
  const hiLabel = (b) => (DIFFS[b] ? DIFFS[b].label : "Survival");
  const cleanIni = (x) => String(x || "").replace(/[^A-Z]/g, "").slice(0, 3) || "???";
  const byScore = (a, b) => b.s - a.s || a.at - b.at;
  // The global top ten for a board, from every game entry (plus the older one-best-per-player table).
  async function readTop(board) {
    if (STANDALONE || (await initMp()) !== true) return null;
    try {
      const [snap, old] = await Promise.all([mp.db.collection("topscores").where("board", "==", board).limit(400).get(), mp.db.collection("hiscores").get()]);
      const rows = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((r) => r && r.board === board && typeof r.pid === "string" && Number.isFinite(r.s) && r.s > 0)
        .map((r) => ({ id: r.id, pid: r.pid, ini: cleanIni(r.ini), s: Math.round(r.s), at: r.at || 0 }));
      const seen = new Set(rows.map((r) => `${r.pid}|${r.s}`));
      old.docs.map((d) => d.data()).forEach((r) => {
        const e = r && r[board];
        if (e && Number.isFinite(e.s) && e.s > 0 && typeof r.pid === "string" && !seen.has(`${r.pid}|${Math.round(e.s)}`)) rows.push({ id: `old-${r.pid}`, pid: r.pid, ini: cleanIni(r.ini), s: Math.round(e.s), at: e.at || 0 });
      });
      return rows.sort(byScore).slice(0, HI_PLACES);
    } catch (e) { return null; }
  }
  // This browser's ten best for a board (from atlas-mybest; older single bests are folded in).
  function myTop(board) {
    const all = lsJSON("atlas-mybest", {}), list = Array.isArray(all[board]) ? all[board].slice() : [];
    const old = Number(lsGet(`atlas-best2-${board}`) || 0);
    if (old && !list.some((r) => r.s === old)) list.push({ s: old, at: 0, ini: getInitials() || "YOU" });
    return list.filter((r) => Number.isFinite(r.s) && r.s > 0).map((r) => ({ ...r, ini: cleanIni(r.ini || getInitials() || "YOU") })).sort(byScore).slice(0, HI_PLACES);
  }
  // Record a finished game: always in the personal list; in the global one when it makes the top ten
  // and you have initials. Returns {at, id} to find this run in the tables.
  async function postScore(board, score) {
    const at = Date.now(), entry = { s: Math.round(score), at, ini: getInitials() || "YOU" };
    if (score > 0) {
      const all = lsJSON("atlas-mybest", {});
      all[board] = (Array.isArray(all[board]) ? all[board] : []).concat(entry).sort(byScore).slice(0, HI_PLACES);
      lsSaveJSON("atlas-mybest", all);
    }
    const run = { at, s: entry.s, id: null };
    await postGlobal(board, run);
    return run;
  }
  async function postGlobal(board, run) {
    if (run.id || run.s <= 0 || !getInitials() || STANDALONE || (await initMp()) !== true) return;
    const top = await readTop(board);
    if (!top || (top.length >= HI_PLACES && run.s <= top[HI_PLACES - 1].s)) return;
    try {
      run.id = `${mp.pid}-${run.at}`;
      await mp.db.doc(`topscores/${run.id}`).set({ pid: mp.pid, ini: getInitials(), board, s: run.s, at: run.at });
    } catch (e) { run.id = null; /* the table is a bonus; the score still counts here */ }
  }
  // Always ten places, arcade style: empty places show dashes until someone takes them.
  const hiTable = (rows, isMine = () => false, isNew = () => false) => `<ol class="hiscores">${Array.from({ length: HI_PLACES }, (_, i) => rows[i]).map((r, i) => (r
    ? `<li class="${isMine(r) ? "me" : ""}${isNew(r) ? " new" : ""}"><span class="rank">${i + 1}</span><b class="ini">${esc(r.ini)}</b><span class="s">${r.s.toLocaleString("en-US")}</span></li>`
    : `<li class="empty"><span class="rank">${i + 1}</span><b class="ini">---</b><span class="s">0</span></li>`)).join("")}</ol>`;
  // The tabs over a table: Global or Personal, and which board.
  const hiTabs = (list, board, global) => `<div class="hitabs" role="group" aria-label="Which list">${global ? ["global", "personal"].map((l) => `<button type="button" data-list="${l}" aria-pressed="${l === list}">${l === "global" ? "Global best" : "Personal best"}</button>`).join("") : '<span class="hionly">Personal best</span>'}</div>
    <div class="hiboards" role="group" aria-label="Which board">${HI_BOARDS().map((b) => `<button type="button" data-board="${b}" aria-pressed="${b === board}">${hiLabel(b)}</button>`).join("")}</div>`;
  let hiView = { list: STANDALONE ? "personal" : "global", board: null };
  async function renderSetupHiscores() {
    const el = $("qhiscores");
    if (!el) return;
    if (!hiView.board) hiView.board = loadCfg().survival ? "survival" : loadCfg().diff;
    const global = !STANDALONE;
    if (!global) hiView.list = "personal";
    const rows = hiView.list === "global" ? await readTop(hiView.board) : myTop(hiView.board);
    if (!(quiz === null || quiz === undefined)) return;
    el.hidden = false;
    el.innerHTML = `<span class="cat">High scores</span>${hiTabs(hiView.list, hiView.board, global)}
      ${rows ? hiTable(rows, (r) => hiView.list === "personal" || r.pid === mp.pid) : '<p class="hinone">The global list isn\'t available right now.</p>'}
      <p class="rankline">Your rank: <b>${esc(rankText())}</b></p>`;
    el.querySelectorAll("[data-list]").forEach((b) => { b.onclick = () => { hiView.list = b.dataset.list; renderSetupHiscores(); }; });
    el.querySelectorAll("[data-board]").forEach((b) => { b.onclick = () => { hiView.board = b.dataset.board; renderSetupHiscores(); }; });
  }
  // At the end of a solo quiz or Survival: save the score, enter initials (once, or to change them),
  // and see where this game landed in both lists.
  async function showEndHiscores(board, score) {
    const box = document.createElement("div");
    box.className = "board hiend"; box.id = "hiend";
    $("qextra").prepend(box);
    const run = await postScore(board, score);
    let list = STANDALONE ? "personal" : "global";
    const draw = async () => {
      const glob = STANDALONE ? null : await readTop(board), mine = myTop(board);
      const gPlace = glob ? glob.findIndex((r) => r.id === run.id) : -1, pPlace = mine.findIndex((r) => r.at === run.at);
      const rows = list === "global" ? glob : mine;
      const isNew = (r) => (list === "global" ? r.id === run.id : r.at === run.at);
      box.innerHTML = `<span class="cat">${hiLabel(board)} high scores</span>
        ${gPlace >= 0 ? `<p class="hinew">New high score! You're number ${gPlace + 1} in the world.</p>` : ""}
        ${pPlace >= 0 ? `<p class="hinew mine">${pPlace === 0 ? "Your best ever on this board!" : `Number ${pPlace + 1} on your personal list.`}</p>` : ""}
        <form class="iniform" id="iniform"><label for="initials">Your initials</label><input id="initials" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false" value="${esc(getInitials())}" placeholder="AAA"><button class="btn" type="submit">${getInitials() ? "Update" : "Save"}</button></form>
        ${STANDALONE ? "" : `<div class="hitabs" role="group" aria-label="Which list">${["global", "personal"].map((l) => `<button type="button" data-list="${l}" aria-pressed="${l === list}">${l === "global" ? "Global best" : "Personal best"}</button>`).join("")}</div>`}
        ${rows ? hiTable(rows, (r) => list === "personal" || r.pid === mp.pid, isNew) : '<p class="hinone">The global list isn\'t available right now.</p>'}`;
      box.querySelectorAll("[data-list]").forEach((b) => { b.onclick = () => { list = b.dataset.list; draw(); }; });
      box.querySelector("#iniform").onsubmit = async (e) => {
        e.preventDefault();
        const v = $("initials").value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3);
        if (!v) return;
        lsSet("atlas-initials", v);
        if (run.id) { try { await mp.db.doc(`topscores/${run.id}`).update({ ini: v }); } catch (err) {} }
        else await postGlobal(board, run);
        const all = lsJSON("atlas-mybest", {});
        (all[board] || []).forEach((r) => { if (r.at === run.at) r.ini = v; });
        lsSaveJSON("atlas-mybest", all);
        draw();
      };
      $("initials").oninput = (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 3); };
    };
    await draw();
  }

  // Attract mode: after a while with nobody touching anything on Explore or the Quiz screen, the globe tours the world
  // with a fact on screen and PRESS START pulsing. Any input stops it.
  const ATTRACT_MS = window.ATLAS_ATTRACT_MS || (window.ATLAS_TEST ? 0 : 45000);
  let attractIdle = null, attractTour = null, attractOn = false;
  function attractStep() {
    const pool = withFacts(), f = pool[Math.floor(Math.random() * pool.length)];
    if (!f) return;
    const fact = factsOf(f.id)[Math.floor(Math.random() * factsOf(f.id).length)];
    $("attractfact").innerHTML = `<b>${esc(nameOf(f))}</b> ${esc(fact[1])}`;
    if (!reduce) flyTo(f, Math.max(1.6, targetZoom(f, 5)), { duration: 2200 });
  }
  function startAttract() {
    // On Explore, or the Quiz screen before a game starts; never over a card like the tutorial's.
    const idleScreen = mode === "explore" || (mode === "quiz" && !quiz);
    if (attractOn || !idleScreen || document.hidden || !$("tutcard").hidden || !$("skincard").hidden) return;
    attractOn = true;
    $("attract").hidden = false;
    attractStep();
    attractTour = setInterval(attractStep, 7000);
  }
  function stopAttract() {
    if (attractOn) { attractOn = false; clearInterval(attractTour); $("attract").hidden = true; }
    clearTimeout(attractIdle);
    if (ATTRACT_MS) attractIdle = setTimeout(startAttract, ATTRACT_MS);
  }
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach((t) => window.addEventListener(t, (e) => { if (attractOn && e.target && e.target.closest && e.target.closest("#attractstart")) return; stopAttract(); }, { passive: true }));
  $("attractstart").onclick = () => { stopAttract(); setMode("quiz"); startQuiz(); };
  stopAttract();
  // Tests only: force the random parts so they can be checked.
  if (window.ATLAS_TEST) {
    window.__jackpotId = () => jackpotId();
    window.__forceJackpot = () => { if (quiz && quiz.spec) { quiz.spec.jp = 1; } };
    window.__nearMiss = (right, fi, km, id) => nearMissHTML(right, fi, km, byId.get(id));
    window.__allPerfect = () => { if (quiz) quiz.kms = quiz.kms.map(() => 0); };
  }
  // ---- 48-power.js ----
  /* ---------- Power-ups, fever, the prize chest and the shared jackpot ---------- */
  // Power-ups: every game you play (solo quizzes, Survival, the daily and party games; not the
  // tutorial or a friend's challenge, which replay fixed questions). Every perfect answer earns one, and so does every
  // L.POWER_EVERY points you reach in a game. You hold up to L.POWER_MAX; unused ones carry over to
  // your next game. Fever scoring lives in logic.js (scoreRun); this draws it.

  // Freeze holds the clock for this long, then it runs on from where it stopped.
  const FREEZE_MS = 10000;
  const POWER_KINDS = ["solo", "survival", "daily", "party"];
  const powerOK = () => !!quiz && POWER_KINDS.includes(quiz.kind);
  // The settings that decide which power-ups can drop: Freeze needs the speed-bonus clock, an
  // Extra life needs Survival.
  const powerCtx = (q = quiz) => ({ timed: !!(q && q.cfg && q.cfg.timer), survival: !!(q && q.kind === "survival") });
  // Power-ups held between games (older versions stored a single name).
  function carriedPowers() {
    const raw = lsGet("atlas-power");
    let list = [];
    try { const v = JSON.parse(raw); list = Array.isArray(v) ? v : [v]; } catch (e) { list = raw ? [raw] : []; }
    return list.filter((p) => L.POWERS[p]).slice(0, L.POWER_MAX);
  }
  const keepPowers = (list) => lsSet("atlas-power", JSON.stringify((list || []).filter((p) => L.POWERS[p]).slice(0, L.POWER_MAX)));
  const randomPower = (ctx) => L.pickPower(ctx);
  // Add power-ups to the game in play (solo or Survival), or to the ones waiting for your next game.
  // Returns the kinds that fit; any past L.POWER_MAX are lost.
  // In a game, no more than L.POWER_ROUND_MAX are earned in all (quiz.powersEarned counts them).
  const roundRoom = () => (powerOK() && !quiz.done ? Math.max(0, L.POWER_ROUND_MAX - (quiz.powersEarned || 0)) : Infinity);
  function grantPowers(n, kinds) {
    const live = powerOK() && !quiz.done;
    const held = live ? quiz.powers : carriedPowers(), got = [], room = roundRoom();
    for (let i = 0; i < n && held.length < L.POWER_MAX && got.length < room; i++) {
      const k = (kinds && kinds[i]) || randomPower(live ? powerCtx() : { timed: loadCfg().timer });
      held.push(k); got.push(k);
    }
    if (!live) keepPowers(held);
    else quiz.powersEarned = (quiz.powersEarned || 0) + got.length;
    return got;
  }
  // Why a held power-up can't be used on this question (null when it can).
  function powerBlocked(kind) {
    const spec = quiz.spec || {};
    if (quiz.revealed || quiz.locked) return "after you lock in";
    if ((quiz.powersOn || []).includes(kind)) return "Already on for this question";
    if (kind === "freeze" && !quiz.cfg.timer) return "Only in a timed game (turn on the speed bonus)";
    if (kind === "freeze" && quiz.frozenMs != null) return "The clock is already frozen";
    if (kind === "lens" && spec.fi) return "Not in a Find it round";
    if (kind === "half" && (spec.fi || spec.hl || spec.ns)) return "Not with only two choices";
    if (kind === "compass" && quiz.hints.includes("continent")) return "You already know the continent";
    if (kind === "life" && quiz.kind !== "survival") return "Only in Survival";
    return null;
  }
  // Everyone gets one free Second chance a day (the UTC day, like the daily challenge), on top of the power-ups held.
  // It doesn't take a slot and doesn't pile up: unused, it's simply there again tomorrow.
  const dailyRetryLeft = () => lsGet("atlas-dailyretry") !== L.utcDayKey();
  function useDailyRetry() {
    if (!powerOK() || !dailyRetryLeft() || powerBlocked("retry")) return;
    lsSet("atlas-dailyretry", L.utcDayKey());
    quiz.retryOn = true;
    quiz.powersOn = (quiz.powersOn || []).concat("retry");
    sfx("power");
    announce("Daily second chance on. If this answer is wrong, you get one more try.");
    renderPower();
  }
  function renderPower() {
    const el = $("qpower");
    // The saved copy follows every change, so quitting or reloading mid-game loses nothing.
    if (powerOK() && !quiz.done) keepPowers(quiz.powers);
    if (!powerOK() || quiz.revealed || quiz.done) { el.hidden = true; el.innerHTML = ""; return; }
    const on = (quiz.powersOn || []).map((k) => L.POWERS[k]), held = quiz.powers || [];
    const daily = dailyRetryLeft() && !quiz.retryOn, dailyWhy = daily ? powerBlocked("retry") : null;
    el.hidden = false;
    // Nothing to use or on: no box (the help text explains how to earn them).
    if (!on.length && !held.length && !daily) { el.hidden = true; el.innerHTML = ""; return; }
    el.className = "power";
    const btn = (k, attrs, label, desc, why, extra = "") => `<button type="button" class="powerbtn${extra}${why ? " blocked" : ""}" ${attrs} aria-label="${esc(`${label}: ${why || desc}`)}"${why ? ' aria-disabled="true"' : ""}><span class="picon" aria-hidden="true">${esc(L.POWERS[k].icon)}</span><span class="ptip" role="tooltip"><b>${esc(label)}</b>${esc(why || desc)}</span></button>`;
    // Each power-up is a symbol: hover over it (or tab to it) to see what it does, press it to use it.
    el.innerHTML = `<span class="pinnote-label">Power-ups · ${held.length} of ${L.POWER_MAX}</span>
      ${on.map((p) => `<span class="powerlive">${esc(p.icon)} ${esc(p.label)} on</span>`).join("")}
      ${held.length || daily ? `<div class="powerlist">${daily ? btn("retry", 'data-daily="1"', "Daily second chance", "Free once a day: if your answer is wrong, you get one more try (right on the retry, the country pays half). It doesn't use a slot.", dailyWhy, " daily") : ""}${[...new Set(held)].map((k) => { const n = held.filter((x) => x === k).length; return btn(k, `data-i="${held.indexOf(k)}" data-kind="${k}"${n > 1 ? ` data-count="×${n}"` : ""}`, n > 1 ? `${L.POWERS[k].label} (×${n})` : L.POWERS[k].label, L.POWERS[k].desc, powerBlocked(k), n > 1 ? " many" : ""); }).join("")}</div>` : ""}
      ${!held.length ? `<small>Perfect answers can drop power-ups, and so does every ${L.POWER_EVERY.toLocaleString("en-US")} points (up to ${L.POWER_ROUND_MAX} a game).</small>` : ""}`;
    el.querySelectorAll(".powerbtn").forEach((b) => { b.onclick = () => (b.dataset.daily ? useDailyRetry() : usePower(Number(b.dataset.i))); });
  }
  function usePower(i = 0) {
    const kind = quiz && quiz.powers && quiz.powers[i];
    if (!kind || powerBlocked(kind)) return;
    quiz.powers.splice(i, 1);
    quiz.powersOn = (quiz.powersOn || []).concat(kind);
    sfx("power");
    if (kind === "freeze") { quiz.frozenMs = Math.max(0, Date.now() - quiz.startedAt); quiz.frozeAt = Date.now(); $("qtimer").classList.add("frozen"); }
    if (kind === "lens") { quiz.lens = { type: "FeatureCollection", features: (quiz.opts || quiz.spec.o).map((id) => byId.get(id)).filter(Boolean) }; render(); }
    if (kind === "half") halfOut();
    if (kind === "shield") quiz.shieldOn = true;
    if (kind === "double") quiz.doubleOn = true;
    if (kind === "retry") quiz.retryOn = true;
    if (kind === "compass") compassOut();
    if (kind === "life") { quiz.lives += 1; updateLives(); }
    announce(`${L.POWERS[kind].label} used. ${L.POWERS[kind].desc}`);
    renderPower();
  }
  // Compass: the continent clue, free. Its clue button goes, since it's no longer needed.
  function compassOut() {
    const cont = info(quiz.answer.id)?.cont;
    quiz.contGlow = continentOutline(cont);
    if (quiz.contGlow) flyToPoint(d3.geoCentroid(quiz.contGlow), Math.min(k, 1.15), { duration: 900, dip: 0 });
    $("qhints").querySelector('[data-hint="continent"]')?.remove();
    const out = $("qhintout");
    out.textContent = `Compass: it's in ${cont || "an unknown region"}. ${out.hidden ? "" : out.textContent}`.trim();
    out.hidden = false;
    render();
  }
  // 50/50: two wrong answers go. Easy crosses out two options; a typed level offers two buttons.
  function halfOut() {
    const ans = String(quiz.answer.id);
    if (picksAnswer(quiz.cfg)) {
      // Half the wrong answers go: two of three on Easy, three of five on Medium.
      const left = [...$("qopts").querySelectorAll(".opt")].filter((b) => b.dataset.id !== ans && !b.disabled);
      const wrong = shuffle(left).slice(0, Math.max(1, Math.ceil(left.length / 2)));
      wrong.forEach((b) => { b.disabled = true; b.classList.add("elim"); if (quiz.choice && String(quiz.choice.id) === b.dataset.id) { quiz.choice = null; b.classList.remove("chosen"); } });
      updateSteps(); dropSpentElims();
      return;
    }
    const other = shuffle(quiz.spec.o.filter((id) => id !== ans && byId.has(id)))[0];
    const box = $("qelim"); box.innerHTML = "";
    shuffle([ans, other]).map((id) => byId.get(id)).forEach((f) => {
      const b = document.createElement("button");
      b.type = "button"; b.className = "opt"; b.textContent = nameOf(f); b.dataset.id = f.id;
      b.onclick = () => { $("qtype").value = nameOf(f); choose(f); box.querySelectorAll(".opt").forEach((x) => x.classList.toggle("chosen", x === b)); };
      box.appendChild(b);
    });
    box.hidden = false;
    dropSpentElims();
  }
  // Clearing a wrong answer would leave only the right one: those clues go.
  const dropSpentElims = () => { if (wrongLeft().length < 2) $("qhints").querySelectorAll('[data-hint="elim"]:not(.used), [data-hint="elim2"]:not(.used)').forEach((b) => b.remove()); };
  // Second chance: a wrong lock-in doesn't count. The pick is crossed out (on Easy), the pin lifts,
  // and the clock keeps running. Returns true when it stepped in.
  function secondChance(km) {
    const fi = !!quiz.spec.fi;
    const wrong = fi ? km > L.findKm(info(quiz.answer.id)?.area) : quiz.choice !== quiz.answer;
    if (!wrong || !quiz.retryOn) return false;
    quiz.retryOn = false; quiz.retried = true;
    sfx("wrong");
    if (!fi) {
      const id = String(quiz.choice.id);
      [...$("qopts").querySelectorAll(".opt"), ...$("qelim").querySelectorAll(".opt")].forEach((b) => { if (b.dataset.id === id) { b.disabled = true; b.classList.add("elim"); b.classList.remove("chosen"); } });
      quiz.choice = null; $("qtype").value = "";
    }
    quiz.pin = null; $("qlat").value = ""; $("qlon").value = "";
    quiz.powersOn = quiz.powersOn.filter((x) => x !== "retry");
    updateSteps(); render();
    const out = $("qhintout");
    out.textContent = fi ? "Second chance: that pin was too far. Drop it again." : "Second chance: not that one. Choose again and drop a new pin. A right answer now pays half for the country.";
    out.hidden = false;
    announce(out.textContent);
    renderPower();
    if (quiz.cfg.timer || quiz.spec.b) startTimer();
    return true;
  }
  // Earn power-ups after an answer: a perfect drops one L.POWER_DROP of the time, and each
  // L.POWER_EVERY points reached drops one. Returns {got: kinds earned, missed: how many didn't fit,
  // capped: the round's limit stopped them (else full slots did)}.
  function earnPowers(perfect, before, after) {
    if (!powerOK()) return { got: [], missed: 0 };
    const drop = perfect && Math.random() < L.POWER_DROP, miles = L.powerMilestones(before, after);
    const n = (drop ? 1 : 0) + miles, room = roundRoom();
    const got = grantPowers(n);
    return { got, missed: n - got.length, capped: n - got.length > 0 && got.length >= room, perfect: drop, miles };
  }
  function powerDropHTML(r) {
    if (!r || (!r.got.length && !r.missed)) return "";
    const why = [r.perfect ? "a perfect answer" : "", r.miles ? `reaching ${(Math.floor(quiz.score / L.POWER_EVERY) * L.POWER_EVERY).toLocaleString("en-US")} points` : ""].filter(Boolean).join(" and ");
    const names = r.got.map((k) => `<b>${esc(L.POWERS[k].label)}</b>`).join(" and ");
    return `<p class="powerdrop">${r.got.length ? `<b>Power-up${r.got.length > 1 ? "s" : ""}!</b> ${names}, for ${why}. Use ${r.got.length > 1 ? "them" : "it"} on any question.` : `You earned a power-up for ${why}, but`}${r.missed ? (r.capped ? ` ${r.got.length ? "That's" : "You've reached"} the most for one game (${L.POWER_ROUND_MAX}).` : ` ${r.got.length ? "One more didn't fit: " : ""}your ${L.POWER_MAX} slots are full, so use one to make room.`) : ""}</p>`;
  }

  // Fever: the globe glows hot while it lasts; pips under the combo meter count perfects toward it.
  function updateFever() {
    const on = !!quiz && quiz.feverLeft > 0 && !quiz.done;
    wrap.classList.toggle("fever", on);
    const el = $("qfever");
    // Shown once the first perfect counts toward it (or while it burns).
    if (!quiz || quiz.done || !(on || (quiz.perf || 0) > 0)) { el.hidden = true; return; }
    el.hidden = false;
    el.classList.toggle("on", on);
    const n = on ? 0 : Math.min(L.FEVER_AFTER, quiz.perf || 0);
    el.innerHTML = on
      ? `<span class="clabel">Fever</span><b>× ${L.FEVER_X} · ${plural(quiz.feverLeft, "question")} left</b>`
      : `<span class="clabel">Fever</span><span class="pips" aria-hidden="true">${Array.from({ length: L.FEVER_AFTER }, (_, i) => `<i class="${i < n ? "lit" : ""}"></i>`).join("")}</span><small>${L.FEVER_AFTER - n} more perfect${L.FEVER_AFTER - n === 1 ? "" : "s"} in a row</small>`;
  }
  function playFever() {
    const el = $("feverfx");
    el.innerHTML = `<b>FEVER</b><span>× ${L.FEVER_X} for ${plural(L.FEVER_Q, "question")}</span>`;
    el.hidden = false;
    el.classList.remove("go"); void el.offsetWidth; el.classList.add("go");
    sfx("fever");
    clearTimeout(playFever.t);
    playFever.t = setTimeout(() => { el.hidden = true; el.innerHTML = ""; }, 3200);
  }
  const clearFever = () => { clearTimeout(playFever.t); $("feverfx").hidden = true; $("feverfx").innerHTML = ""; wrap.classList.remove("fever"); };

  // Prize chest: after a bonus round or a free spin, pick one of three. Two hold points (scaled by
  // the level), one a power-up for your next question or round; all three open once you choose.
  const chestEarned = () => powerOK() && !quiz.chestDone && quiz.log.length > quiz.baseN;
  function showChest() {
    quiz.chestDone = true;
    stopTimer(); hideSlot(); clearJackpot(); clearPerfect();
    const m = (DIFFS[quiz.cfg.diff] || DIFFS.easy).mult;
    const prizes = shuffle([{ pts: Math.round(50 * m) }, { pts: Math.round(150 * m) }, { power: randomPower(powerCtx()) }]);
    const label = (p) => (p.pts ? `+${p.pts} points` : `${L.POWERS[p.power].label} power-up`);
    $("qnum").textContent = "Prize chest";
    ["qfact", "qprompt", "qsteps", "qlock", "qtypeform", "qelim", "qcluehead", "qpower", "qhintout"].forEach((id) => { $(id).hidden = true; });
    $("qbadges").innerHTML = ""; $("qhints").innerHTML = "";
    const res = $("qresult");
    res.className = "qresult chestbox";
    res.innerHTML = `<b class="chesthead">Pick a chest</b><p>You played past the end of the round, so one of these is yours.</p>
      <div class="chests">${prizes.map((p, i) => `<button type="button" class="chest" data-i="${i}" aria-label="Chest ${i + 1}"><span class="lid"></span><span class="box"></span><span class="prize" hidden>${esc(label(p))}</span></button>`).join("")}</div>
      <p class="chestout" id="chestout" aria-live="polite"></p>`;
    res.hidden = false;
    $("qnext").hidden = true;
    sfx("slot");
    res.querySelectorAll(".chest").forEach((b) => { b.onclick = () => openChest(Number(b.dataset.i), prizes); });
    res.querySelector(".chest").focus({ preventScroll: true });
  }
  function openChest(i, prizes) {
    const res = $("qresult");
    if (res.classList.contains("opened")) return;
    res.classList.add("opened");
    const p = prizes[i];
    res.querySelectorAll(".chest").forEach((b, j) => { b.disabled = true; b.classList.add(j === i ? "mine" : "other", "open"); b.querySelector(".prize").hidden = false; });
    let msg;
    if (p.pts) { quiz.extraPts = (quiz.extraPts || 0) + p.pts; quiz.score += p.pts; msg = `+${p.pts} points, added to your score.`; }
    else if (quiz.powers.length >= L.POWER_MAX || !roundRoom()) { quiz.extraPts = (quiz.extraPts || 0) + 75; quiz.score += 75; msg = `A ${L.POWERS[p.power].label} power-up, but ${quiz.powers.length >= L.POWER_MAX ? `your ${L.POWER_MAX} slots are full` : `you've earned the most for one game`}, so it's worth +75 points instead.`; }
    else { quiz.powers.push(p.power); quiz.powersEarned = (quiz.powersEarned || 0) + 1; keepPowers(quiz.powers); msg = `A ${L.POWERS[p.power].label} power-up! It's waiting for your next round.`; }
    $("chestout").textContent = msg;
    $("qscore").textContent = `${plural(quiz.score, "point")} · ${cfgText(quiz.cfg)}`;
    sfx(p.pts && p.pts > 100 ? "jackpot" : "streak");
    announce(`You opened chest ${i + 1}: ${msg}`);
    $("qnext").textContent = "See my score"; $("qnext").hidden = false; $("qnext").focus({ preventScroll: true });
  }

  // The shared progressive jackpot: one pool a day (UTC) for everyone on this page. It starts at
  // JP_BASE and grows with every finished solo or daily game anyone plays. The first perfect answer
  // on today's secret jackpot country takes the whole pool. No shared counter is ever rewritten:
  // each player files their own count (jackpot/<day>/plays/<player>) and claim
  // (jackpot/<day>/wins/<player>); the pool is their sum, and the earliest claim wins.
  const JP_BASE = 500, JP_PER_GAME = 10, JP_CAP = 2500, JP_MAX_PER_PLAYER = 30;
  async function readPool(day = L.utcDayKey()) {
    if (STANDALONE || !(await initMp()) || !mp.db) return null;
    try {
      const [plays, wins] = await Promise.all([mp.db.collection(`jackpot/${day}/plays`).get(), mp.db.collection(`jackpot/${day}/wins`).get()]);
      const games = plays.docs.reduce((a, d) => a + Math.max(0, Math.min(JP_MAX_PER_PLAYER, Math.floor(Number(d.data()?.n) || 0))), 0);
      const ws = wins.docs.map((d) => d.data()).filter((w) => w && typeof w.pid === "string" && Number.isFinite(w.at))
        .sort((a, b) => a.at - b.at || (a.pid < b.pid ? -1 : 1));
      return { pool: Math.min(JP_CAP, JP_BASE + JP_PER_GAME * games), games, winner: ws[0] || null };
    } catch (e) { return null; }
  }
  // A finished game adds to today's pool.
  async function notePoolPlay() {
    if (STANDALONE || (await initMp()) !== true) return;
    const day = L.utcDayKey(), mine = lsJSON("atlas-jpplays", {});
    const n = (mine.day === day ? mine.n : 0) + 1;
    lsSaveJSON("atlas-jpplays", { day, n });
    try { await mp.db.doc(`jackpot/${day}/plays/${mp.pid}`).set({ pid: mp.pid, n: Math.min(n, JP_MAX_PER_PLAYER), at: Date.now() }); } catch (e) { /* the pool is a bonus */ }
  }
  // A perfect on the jackpot country in a solo quiz: claim the pool. Resolves {won, pts, winner}.
  async function claimPool() {
    const before = await readPool();
    if (!before) return null;
    if (before.winner) return { won: before.winner.pid === mp.pid, pts: 0, winner: before.winner, already: true };
    if ((await initMp()) !== true) return null;
    const day = L.utcDayKey();
    try {
      await mp.db.doc(`jackpot/${day}/wins/${mp.pid}`).set({ pid: mp.pid, ini: getInitials() || "???", at: Date.now(), pool: before.pool });
      const after = await readPool(day);
      const w = after && after.winner;
      return { won: !!w && w.pid === mp.pid, pts: w && w.pid === mp.pid ? Math.round(w.pool) : 0, winner: w };
    } catch (e) { return null; }
  }
  // Run the claim and write the outcome into the answer's result.
  async function settlePool() {
    const q = quiz, note = $("poolnote");
    const r = await claimPool();
    if (quiz !== q || !note) return;
    if (!r) { note.remove(); return; }
    if (r.won && r.pts) {
      q.extraPts = (q.extraPts || 0) + r.pts; q.score += r.pts;
      note.innerHTML = `<b>You won today's shared jackpot: +${r.pts.toLocaleString("en-US")} points!</b> Your initials go on the board for everyone who plays today.`;
      note.classList.add("won");
      $("qscore").textContent = `${plural(q.score, "point")} · ${cfgText(q.cfg)}`;
      sfx("jackpot");
      announce(`You won the shared jackpot: ${r.pts} points.`);
    } else if (r.winner) {
      note.textContent = r.won ? "You already won today's shared jackpot." : `So close: ${String(r.winner.ini || "???").replace(/[^A-Z?]/g, "").slice(0, 3)} took today's shared jackpot first. A new pool opens at midnight UTC.`;
    } else note.remove();
  }
  async function renderPoolBanner() {
    const el = $("qpool");
    const info = await readPool();
    if (!info || quiz) { el.hidden = true; return; }
    el.hidden = false;
    const ini = info.winner ? String(info.winner.ini || "???").replace(/[^A-Z?]/g, "").slice(0, 3) : "";
    el.classList.toggle("won", !!info.winner);
    el.innerHTML = info.winner
      ? `<span class="cat">Shared jackpot</span><b class="poolamt">${Math.round(info.winner.pool).toLocaleString("en-US")} <small>points</small></b><p>Won today by <b>${esc(ini)}</b>${info.winner.pid === mp.pid ? " (that's you)" : ""}. A new pool opens at midnight UTC.</p>`
      : `<span class="cat">Shared jackpot</span><b class="poolamt">${info.pool.toLocaleString("en-US")} <small>points</small></b><p>The first player to drop a perfect pin on today's secret jackpot country wins it all. It grows by ${JP_PER_GAME} with every game anyone plays today${info.pool >= JP_CAP ? " (it's at its cap)" : ""}.</p>`;
  }
  if (window.ATLAS_TEST) {
    window.__givePower = (k) => { if (quiz) { quiz.powers = [].concat(k); renderPower(); } };
    window.__ageFreeze = () => { if (quiz && quiz.frozenMs != null) quiz.frozeAt -= FREEZE_MS; };
    window.__earned = () => (quiz ? quiz.powersEarned || 0 : 0);
    window.__powers = () => (quiz ? quiz.powers.slice() : null);
    window.__feverState = () => (quiz ? { perf: quiz.perf || 0, left: quiz.feverLeft || 0, on: wrap.classList.contains("fever") } : null);
    window.__readPool = () => readPool();
    window.__showChest = () => { if (quiz) showChest(); };
    // A [lat, lon] inside the current answer (its center can fall outside, as with a crescent).
    window.__insidePin = () => {
      const f = quiz && quiz.answer; if (!f) return null;
      const sh = scoreShape(f), c = centroidOf(f);
      if (d3.geoContains(sh, c)) return [c[1], c[0]];
      const [[x0, y0], [x1, y1]] = d3.geoBounds(sh);
      for (let n = 8; n <= 256; n *= 2) for (let i = 1; i < n; i++) for (let j = 1; j < n; j++) {
        const p = [x0 + ((x1 >= x0 ? x1 - x0 : x1 + 360 - x0) * i) / n, y0 + ((y1 - y0) * j) / n];
        if (d3.geoContains(sh, p)) return [p[1], ((p[0] + 540) % 360) - 180];
      }
      return [c[1], c[0]];
    };
  }
  // ---- 49-rewards.js ----
  /* ---------- Daily login calendar and Passport set bonuses ---------- */
  // Daily login: claim a reward once a day (on the same UTC calendar as the daily challenge, so every
  // "new day" in the game arrives together) along a 7-day row that builds to a
  // bigger one on day 7, then starts over. Like the daily streak it forgives one missed day; miss two
  // and it starts again at day 1. Rewards are power-ups, waiting for your next game.
  const LOGIN_REWARDS = [1, 1, 2, 1, 2, 2, 3];
  const loadLogin = () => Object.assign({ last: "", n: 0 }, lsJSON("atlas-login", {}));
  // Which day of the row today is, and whether it's been claimed.
  function loginToday(st = loadLogin(), today = L.utcDayKey()) {
    if (st.last === today) return { day: st.n, claimed: true };
    const y = L.prevDay(today), y2 = L.prevDay(y);
    const keep = st.n > 0 && (st.last === y || st.last === y2);
    return { day: keep ? (st.n % LOGIN_REWARDS.length) + 1 : 1, claimed: false };
  }
  const powerName = (k) => `${L.POWERS[k].icon} ${L.POWERS[k].label}`;
  function renderLogin(msg = "") {
    const el = $("qlogin");
    if (!el) return;
    const t = loginToday(), held = carriedPowers(), room = L.POWER_MAX - held.length;
    el.hidden = false;
    el.innerHTML = `<span class="cat">Daily login</span>
      <ol class="logincal">${LOGIN_REWARDS.map((r, i) => {
        const d = i + 1, cls = d < t.day || (t.claimed && d === t.day) ? "got" : d === t.day ? "today" : "";
        return `<li class="${cls}${d === LOGIN_REWARDS.length ? " big" : ""}"><span>Day ${d}</span><b>${r}</b><small>${r === 1 ? "power-up" : "power-ups"}</small></li>`;
      }).join("")}</ol>
      ${t.claimed ? `<p class="loginmsg">${msg || `Day ${t.day} claimed. Day ${(t.day % LOGIN_REWARDS.length) + 1} opens in ${untilMidnight()}.`}</p>`
        : `<button class="btn primary" id="qclaim" type="button"${room ? "" : " disabled"}>Claim day ${t.day}: ${plural(LOGIN_REWARDS[t.day - 1], "power-up")}</button>${room ? "" : `<p class="loginmsg">Your ${L.POWER_MAX} power-up slots are full. Use one in a game, then claim today's reward.</p>`}`}
      <p class="held"><span class="pinnote-label">Your power-ups for the next game · ${held.length} of ${L.POWER_MAX}</span>${held.length ? held.map((k) => `<span class="heldp" title="${esc(L.POWERS[k].desc)}">${esc(powerName(k))}</span>`).join("") : "<small>None yet. Earn them with perfect answers and every 500 points.</small>"}</p>`;
    const b = $("qclaim");
    if (b) b.onclick = () => claimLogin();
  }
  function claimLogin() {
    const t = loginToday();
    if (t.claimed) return;
    const want = LOGIN_REWARDS[t.day - 1];
    const got = grantPowers(want);
    if (!got.length) return renderLogin();
    lsSaveJSON("atlas-login", { last: L.utcDayKey(), n: t.day });
    sfx(t.day === LOGIN_REWARDS.length ? "jackpot" : "power");
    const msg = `Day ${t.day} claimed: ${got.map(powerName).join(", ")}.${got.length < want ? ` ${want - got.length} more didn't fit in your slots.` : ""} ${t.day === LOGIN_REWARDS.length ? `That's the full week! A new one starts in ${untilMidnight()}.` : `Day ${t.day + 1} opens in ${untilMidnight()}.`}`;
    announce(msg);
    renderLogin(msg);
  }

  // Passport sets: stamp every place on a continent and you complete its set, earning the
  // continent's badge and SET_REWARD power-ups (in your current game, or waiting for the next one).
  const SET_REWARD = 2;
  const getSets = () => lsJSON("atlas-sets", {});
  const contPlaces = (c) => withFacts().filter((f) => info(f.id)?.cont === c);
  function checkSet(id) {
    const cont = info(id)?.cont;
    if (!cont) return;
    const sets = getSets();
    if (sets[cont]) return;
    const st = getStamps(), list = contPlaces(cont);
    if (!list.length || !list.every((f) => st[f.id])) return;
    sets[cont] = Date.now(); lsSaveJSON("atlas-sets", sets);
    checkSkins();
    const got = grantPowers(SET_REWARD);
    toastQueue.push({ kind: "Set complete", title: cont, desc: `Every place in ${cont} is stamped. ${got.length ? `Reward: ${got.map((k) => L.POWERS[k].label).join(" and ")} power-ups.` : "Your power-up slots were full, but the badge is yours."}` });
    showNextToast();
    sfx("jackpot");
  }
  if (window.ATLAS_TEST) {
    window.__contIds = (c) => contPlaces(c).map((f) => String(f.id));
    window.__stamp = (id) => stamp(id);
  }
  // ---- 49-survival.js ----
  /* ---------- Survival and golden landmarks (scatter symbols) ---------- */
  // Survival: endless questions on the clock, three lives. A wrong answer or running out of time
  // costs a life, and the clock gets shorter every three questions, down to SURV_MIN_S.
  const SURV_LIVES = 3, SURV_MIN_S = 8;
  const survivalLimit = (i) => Math.max(SURV_MIN_S, TIMER_S - 2 * Math.floor(i / 3));
  // Ten more questions, with the round's mixed special rounds but no "final question" extras.
  function survivalBatch(diff) {
    const qs = buildQs(10, Math.random, { diff });
    qs.forEach((q) => { delete q.mm; });
    return qs;
  }
  function startSurvival(cfg = loadCfg()) {
    refreshFactDiff();
    newQuiz("survival", { diff: cfg.diff, timer: true }, survivalBatch(cfg.diff), { baseN: Infinity, lives: SURV_LIVES });
    quiz.powers = carriedPowers();
    nextQuestion();
  }
  function extendSurvival() {
    const qs = survivalBatch(quiz.cfg.diff);
    quiz.qs = quiz.qs.concat(qs);
    quiz.order = quiz.order.concat(qs.map((q) => byId.get(q.a)));
  }
  function updateLives(lost = false) {
    const el = $("qlives");
    if (!quiz || quiz.kind !== "survival" || quiz.done) { el.hidden = true; return; }
    el.hidden = false;
    const shown = Math.max(SURV_LIVES, quiz.lives);
    el.innerHTML = `<span class="clabel">Lives</span><span class="hearts" aria-label="${plural(quiz.lives, "life", "lives")} left">${Array.from({ length: shown }, (_, i) => `<i class="${i < quiz.lives ? "on" : ""}">♥</i>`).join("")}</span>`;
    if (lost) { el.classList.remove("hit"); void el.offsetWidth; el.classList.add("hit"); }
  }
  function loseLife() {
    quiz.lives = Math.max(0, quiz.lives - 1);
    updateLives(true);
    announce(quiz.lives ? `You lost a life. ${plural(quiz.lives, "life", "lives")} left.` : "You lost your last life.");
  }
  // Out of time in Survival: the answer shows and a life goes.
  function survivalTimeout() {
    const ans = quiz.answer;
    quiz.kms.push(0);
    quiz.log.push({ timeout: true, choice: null, pin: null, hints: quiz.hints.slice(), ms: null, bet: 0 });
    quiz.results.push(0);
    quiz.revealed = true;
    setLockedUI(); sfx("wrong");
    const broke = (quiz.heat || 0) > 0;
    const run = myRun();
    Object.assign(quiz, { streak: run.streak, heat: run.heat, perf: run.perf, feverLeft: run.feverLeft });
    quiz.score = run.total - (quiz.penalty || 0) + (quiz.extraPts || 0);
    setHeat(0); updateCombo(0, broke);
    loseLife();
    selected = ans; paintClasses();
    ["qprompt", "qsteps", "qlock", "qtypeform", "qelim", "qcluehead"].forEach((id) => { $(id).hidden = true; });
    $("qhints").innerHTML = ""; $("qtimer").hidden = true;
    const res = $("qresult");
    res.className = "qresult no";
    res.innerHTML = `<span class="pts">+0</span>Time's up! It was ${esc(nameOf(ans))}.<p class="lifenote"><b>−1 life.</b> ${quiz.lives ? `${plural(quiz.lives, "life", "lives")} left.` : "That was your last one."}</p>`;
    res.hidden = false;
    renderPower(); updateFever(); updateScatter();
    $("qnext").textContent = quiz.lives > 0 ? "Next question" : "Game over · see my score";
    $("qnext").hidden = false; $("qnext").focus({ preventScroll: true });
    flyTo(ans, Math.max(1.8, targetZoom(ans, 7)), { duration: 1200, dip: 0 });
  }
  function survivalEnd() {
    stopTimer(); clearPerfect(); recordFactStats(); clearFever(); clearScatter();
    wrap.classList.remove("noborders");
    $("qpower").hidden = true;
    notePoolPlay();
    keepPowers(quiz.powers);
    const s = quiz.score, n = quiz.log.length;
    const best = Math.max(Number(lsGet("atlas-best2-survival") || 0), s);
    lsSet("atlas-best2-survival", String(best));
    quiz.done = true; quiz.revealed = false; quiz.line = null; quiz.pin = null;
    updateLives();
    showQuizPart("end");
    $("qendtag").textContent = "Game over";
    $("qbest").textContent = `Best in Survival: ${best.toLocaleString("en-US")}`;
    $("qfinal").innerHTML = `${s} <span class="of">points</span>`;
    const avg = quiz.kms.reduce((a, b) => a + b, 0) / Math.max(1, n);
    $("qmsg").textContent = `You survived ${plural(n, "question")} on ${DIFFS[quiz.cfg.diff].label} and named ${quiz.names}. Your pins landed ${fmtKm(avg)} away on average.`;
    $("qdots").innerHTML = dotsHTML(myRun().items, quiz.cfg);
    showEndHiscores("survival", s);
    $("qnum").textContent = "Game over";
    $("qbar").parentElement.hidden = false; $("qbar").style.width = "100%";
    $("qagain").textContent = "Play Survival again";
    $("qsettings").hidden = false;
    selected = null; paintClasses(); render();
  }

  // Golden landmarks: on some questions in any game with power-ups, a gold coin hides somewhere on
  // the globe. Tap it before you lock in. Three in a solo round or the daily unlock the bonus round at
  // the end; in Survival, three earn an extra life; in a party game, a power-up. Each is also worth a
  // few points (in a party game they go into the shared score with that answer).
  const SCATTER_NEED = 3, SCATTER_P = 0.35, SCATTER_PTS = 25;
  function maybeScatter() {
    quiz.scatter = null;
    if (powerOK() && !quiz.spec.fs && !(extrasRound() && (quiz.scatters || 0) >= SCATTER_NEED) && Math.random() < SCATTER_P) {
      // Somewhere on the side of the globe facing you, away from the middle.
      const p = scatterSpot(Math.random() * 2 * Math.PI, 0.35 + Math.random() * 0.45);
      if (p) quiz.scatter = { p, got: false };
      announce("A golden landmark appeared on the globe. Find it and tap it before you lock in.", 600);
    }
    updateScatter();
  }
  // The place under a screen point at angle b, a share f of the globe's radius out from its middle.
  function scatterSpot(b, f) {
    const [tx, ty] = projection.translate(), r = base * Math.min(k, 1.6) * f;
    const p = projection.invert([tx + r * Math.cos(b), ty + r * Math.sin(b)]);
    return p && Number.isFinite(p[0]) && onFront(p) ? p : null;
  }
  function updateScatter() {
    const el = $("qscatter");
    if (!powerOK() || quiz.done) { el.hidden = true; return; }
    const n = quiz.scatters || 0, live = quiz.scatter && !quiz.scatter.got && !quiz.revealed;
    // Shown from the first golden landmark on.
    el.hidden = !(n > 0 || live);
    if (el.hidden) return;
    el.classList.toggle("live", !!live);
    el.innerHTML = `<span class="clabel">Golden landmarks</span><span class="coins" aria-hidden="true">${Array.from({ length: SCATTER_NEED }, (_, i) => `<i class="${i < n ? "lit" : ""}"></i>`).join("")}</span><small>${live ? "One is on the globe right now. Tap it!" : quiz.kind === "survival" ? `${SCATTER_NEED} earn an extra life` : !extrasRound() ? `${SCATTER_NEED} earn a power-up` : n >= SCATTER_NEED ? "Bonus round unlocked for the end of the round" : `${SCATTER_NEED} unlock a bonus round`}</small>`;
  }
  // A click near the coin collects it instead of dropping a pin. Returns true when it did.
  function scatterHit(xy) {
    const sc = quiz && quiz.scatter;
    if (!sc || sc.got || quiz.revealed || !onFront(sc.p)) return false;
    const p = projection(sc.p);
    if (Math.hypot(p[0] - xy[0], p[1] - xy[1]) > 22) return false;
    collectScatter();
    return true;
  }
  function collectScatter() {
    const sc = quiz && quiz.scatter;
    if (!sc || sc.got || quiz.revealed) return;
    sc.got = true;
    quiz.scatters = (quiz.scatters || 0) + 1;
    const pts = Math.round(SCATTER_PTS * (DIFFS[quiz.cfg.diff] || DIFFS.easy).mult);
    quiz.extraPts = (quiz.extraPts || 0) + pts; quiz.score += pts; quiz.qxp = (quiz.qxp || 0) + pts;
    $("qscore").textContent = `${plural(quiz.score, "point")} · ${cfgText(quiz.cfg)}`;
    let msg = `Golden landmark! +${pts} points.`;
    if (quiz.kind === "survival" && quiz.scatters >= SCATTER_NEED) { quiz.scatters = 0; quiz.lives += 1; updateLives(); msg += " Three collected: an extra life!"; }
    else if (extrasRound() && quiz.scatters === SCATTER_NEED) msg += " That's three: a bonus round waits at the end of this round.";
    else if (quiz.kind === "party" && quiz.scatters >= SCATTER_NEED) {
      // Party games have no bonus round: three landmarks earn a power-up instead.
      quiz.scatters = 0;
      const got = grantPowers(1);
      msg += got.length ? ` Three collected: a ${L.POWERS[got[0]].label} power-up!` : " Three collected, but your power-up slots are full.";
      renderPower();
    }
    else msg += ` ${quiz.scatters} of ${SCATTER_NEED}.`;
    sfx(quiz.scatters === 0 || quiz.scatters >= SCATTER_NEED ? "jackpot" : "streak");
    const fx = $("scatterfx");
    fx.textContent = `+${pts}`; fx.hidden = false; fx.classList.remove("go"); void fx.offsetWidth; fx.classList.add("go");
    clearTimeout(collectScatter.t); collectScatter.t = setTimeout(() => { fx.hidden = true; }, 1400);
    announce(msg);
    updateScatter();
    $("qscatter").querySelector("small").textContent = msg;
    render();
  }
  const clearScatter = () => { if (quiz) quiz.scatter = null; $("qscatter").hidden = true; $("scatterfx").hidden = true; render(); };
  d3.select("#scatter").on("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); collectScatter(); } });
  if (window.ATLAS_TEST) {
    window.__scatterXY = () => { const sc = quiz && quiz.scatter; if (!sc || sc.got || !onFront(sc.p)) return null; const p = projection(sc.p), r = svg.node().getBoundingClientRect(), vb = svg.node().viewBox.baseVal; const sx = vb && vb.width ? r.width / vb.width : 1, sy = vb && vb.height ? r.height / vb.height : 1; return [r.left + p[0] * sx, r.top + p[1] * sy]; };
    window.__forceScatter = () => { if (quiz) { quiz.scatter = { p: scatterSpot(0.6, 0.5), got: false }; updateScatter(); render(); } };
    window.__lives = () => (quiz ? quiz.lives : null);
  }
  // ---- 50-party.js ----
  /* ---------- Party games (2 to 8 players) ---------- */
  // games/<code>                        questions, settings and who is playing
  // games/<code>/locks/<player>         only which question a player has locked in, never the answer
  // games/<code>/answers/<player>-<q>   written by each player only after EVERY player has locked question q
  const mp = { db: null, user: null, pid: null, code: null, game: null, locks: {}, answers: {}, gotLocks: false, gotAnswers: false, unsubs: [], writing: {}, profiles: {} };
  const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const newCode = () => Array.from({ length: 5 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join("");
  const vmsg = (t) => { $("vmsg").textContent = t || ""; };
  let mpReady = null;
  function initMp() {
    if (mpReady) return mpReady;
    mpReady = (async () => {
      if (STANDALONE) return false;
      if (!window.claude || typeof window.claude.use !== "function") return false;
      const [db, user] = await Promise.all([window.claude.use("db"), window.claude.use("user")]);
      if (!db) return false;
      mp.db = db; mp.user = user;
      let id = user ? await user.id() : null;
      if (!id) { id = lsGet("atlas-pid"); if (!id) { id = "p_" + Math.random().toString(36).slice(2, 12); lsSet("atlas-pid", id); } }
      mp.pid = id;
      const saved = lsGet("atlas-vname"); if (saved && !$("vname").value) $("vname").value = saved;
      if (user && (await user.can("data.write")) === false) return "readonly";
      if (user && (await user.isOwner())) setTimeout(housekeeping, window.ATLAS_TEST ? 300 : 5000);
      return true;
    })().catch(() => false);
    return mpReady;
  }
  function errorText(e) {
    const code = e && e.code;
    if (code === "invalid_argument" || code === "not_granted") return "This page won't let you save a game. Ask the page's owner to share it with you as a Contributor (or Editor), then reload.";
    if (code === "quota_exceeded") return "The game storage for this page is full. Ask the page's owner to clear out old games.";
    if (code === "revoked") return "Your access to this page changed. Reload to keep playing.";
    return "Couldn't reach the game just now. Check your connection and try again.";
  }
  async function showVersusLobby() {
    buildSetup($("party-setup"), "party");
    const ok = await initMp(), note = $("vunavail");
    if (ok === true) { note.hidden = true; $("vcreate").disabled = $("vjoin").disabled = false; return; }
    note.hidden = false;
    note.textContent = ok === "readonly"
      ? "You can play solo quizzes, but not party games or shared high scores: your access is view-only. Ask the page's owner to share it with you as a Contributor (or Editor), then reload."
      : "Party games need you signed in to claude.ai, with Contributor (or Editor) access to this page. Ask the page's owner to share it with you, then open it from that invite.";
    $("vcreate").disabled = $("vjoin").disabled = true;
  }
  const myName = () => $("vname").value.trim().slice(0, 24);
  const saveName = () => lsSet("atlas-vname", myName());
  const g = () => mp.game || {};
  const players = () => (Array.isArray(g().players) ? g().players.filter((p) => typeof p === "string") : []);
  const dropped = () => (Array.isArray(g().dropped) ? g().dropped : []);
  const active = () => players().filter((p) => !dropped().includes(p));
  const others = () => active().filter((p) => p !== mp.pid);
  const isHost = () => g().host === mp.pid;
  const gameCfg = () => ({ diff: DIFFS[g().diff] ? g().diff : "easy", timer: !!g().timer });
  function colorOf(pid) {
    if (pid === mp.pid) return "var(--accent)";
    const list = players().filter((p) => p !== mp.pid);
    return PLAYER_COLORS[Math.max(0, list.indexOf(pid)) % PLAYER_COLORS.length];
  }
  function playerName(pid) {
    const typed = g().names && g().names[pid];
    if (typeof typed === "string" && typed.trim()) return typed.trim().slice(0, 24);
    const p = pid && mp.profiles[pid];
    if (p && p.name) return p.name;
    if (pid === mp.pid) return "You";
    return `Player ${players().indexOf(pid) + 1 || ""}`.trim();
  }
  async function refreshProfiles() {
    if (!mp.user || !players().length) return;
    try { mp.profiles = await mp.user.profiles(players()); } catch (e) {}
  }
  const pairKey = (a, b) => [a, b].sort().join("~");

  async function createGame() {
    if ((await initMp()) !== true) return showVersusLobby();
    saveName(); vmsg("");
    const cfg = readSetup("party"), code = newCode();
    $("vcreate").disabled = true;
    try {
      await mp.db.doc(`games/${code}`).set({ v: 2, host: mp.pid, players: [mp.pid], names: { [mp.pid]: myName() }, status: "lobby", diff: cfg.diff, timer: cfg.timer, dropped: [], qs: hideAnswers(buildQs(ROUND, Math.random, { diff: cfg.diff }), code), created: Date.now() });
    } catch (e) { $("vcreate").disabled = false; return vmsg(errorText(e)); }
    $("vcreate").disabled = false;
    openGame(code);
  }
  async function joinGame(raw) {
    if ((await initMp()) !== true) return showVersusLobby();
    const code = String(raw || "").trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) return vmsg("Game codes are 5 letters and numbers, like KX4QP.");
    saveName(); vmsg("Joining…");
    const ref = mp.db.doc(`games/${code}`);
    try {
      const lease = await ref.acquire({ holder: mp.pid, ttlMs: 5000 });
      if (!lease.acquired) await new Promise((r) => setTimeout(r, 1500));
      const snap = await ref.get();
      if (!snap.exists) return vmsg(`There's no game with the code ${code}. Check the code with the other players.`);
      const d = snap.data(), list = Array.isArray(d.players) ? d.players : [];
      if (!list.includes(mp.pid)) {
        if (d.status !== "lobby") return vmsg("That game has already started. Ask for a new code.");
        if (list.length >= MAX_PLAYERS) return vmsg(`That game is full (${MAX_PLAYERS} players).`);
        await ref.update({ players: list.concat(mp.pid), names: { [mp.pid]: myName() } });
      }
    } catch (e) { return vmsg(errorText(e)); }
    vmsg("");
    openGame(code);
  }
  function leaveGame() {
    mp.unsubs.forEach((u) => { try { u(); } catch (e) {} });
    Object.assign(mp, { unsubs: [], code: null, game: null, locks: {}, answers: {}, gotLocks: false, gotAnswers: false, writing: {} });
    if (quiz && quiz.kind === "party") { stopTimer(); quiz = null; }
  }
  function openGame(code) {
    leaveGame();
    mp.code = code;
    try { history.replaceState(null, "", `#game-${code}`); } catch (e) {}
    showPanel("lobby"); showWaiting();
    const path0 = `games/${code}`;
    const timer = setTimeout(() => { if (!mp.game && mp.code === code) vmsg("Can't reach the game yet. It will keep trying."); }, 10000);
    const fail = (e) => { clearTimeout(timer); if (mp.code === code) vmsg(errorText(e)); };
    // A safety net for live updates that arrive late or not at all: while this game sits in its lobby,
    // read it directly every few seconds and apply anything new (players joining, the host starting).
    const poll = setInterval(async () => {
      if (mp.code !== code) return clearInterval(poll);
      if (mp.game && mp.game.status !== "lobby") return;
      try {
        const snap = await mp.db.doc(path0).get();
        if (mp.code !== code || !snap.exists) return;
        const d = snap.data(), cur = mp.game || {};
        if (d.status !== cur.status || JSON.stringify(d.players) !== JSON.stringify(cur.players)) {
          mp.game = d;
          if (Array.isArray(mp.game.qs)) mp.game.qs = showAnswers(mp.game.qs, code);
          renderWaiting(); onMpChange();
        }
      } catch (e) { /* the live listener may still deliver */ }
    }, 4000);
    mp.unsubs.push(() => clearInterval(poll));
    mp.unsubs.push(mp.db.doc(path0).onSnapshot((s) => {
      if (mp.code !== code) return;
      if (!s.exists) { if (!s.metadata.fromCache) { clearTimeout(timer); vmsg(`There's no game with the code ${code}.`); } return; }
      if (!s.metadata.fromCache) clearTimeout(timer);
      mp.game = s.data();
      if (mp.game && Array.isArray(mp.game.qs)) mp.game.qs = showAnswers(mp.game.qs, code);
      // Redraw now (the player list and the Start button), then again once account names arrive: a
      // guest's name can take a while to look up, and the lobby shouldn't wait for it.
      renderWaiting();
      refreshProfiles().then(() => { if (mp.code === code) { renderWaiting(); if (quiz && quiz.kind === "party") renderStandings(); } });
      onMpChange();
    }, fail));
    mp.unsubs.push(mp.db.collection(`${path0}/locks`).onSnapshot((qs) => {
      if (mp.code !== code) return;
      mp.locks = {}; qs.docs.forEach((d) => { mp.locks[d.id] = d.data(); });
      mp.gotLocks = true; onMpChange();
    }, fail));
    mp.unsubs.push(mp.db.collection(`${path0}/answers`).onSnapshot((qs) => {
      if (mp.code !== code) return;
      // Keep the first version of each answer this player saw: an answer edited after the reveal changes nothing.
      qs.docs.forEach((d) => {
        const a = d.data();
        if (!a || typeof a.pid !== "string" || !Number.isInteger(a.q) || d.id !== `${a.pid}-${a.q}`) return;
        const key = `${a.pid}:${a.q}`;
        if (!mp.answers[key]) mp.answers[key] = a;
      });
      mp.gotAnswers = true; onMpChange();
    }, fail));
  }
  function showLobby() { $("vlobby").hidden = false; $("vwait").hidden = true; $("vstatus").textContent = ""; }
  function showWaiting() {
    $("vlobby").hidden = true; $("vwait").hidden = false;
    $("vcodeshow").textContent = mp.code || "";
    renderWaiting();
  }
  function renderWaiting() {
    if ($("vwait").hidden) return;
    const list = players();
    $("vstatus").textContent = `${list.length} of ${MAX_PLAYERS} players`;
    $("plist").innerHTML = list.map((p) => `<li><span class="dot" style="background:${colorOf(p)}"></span><span class="pn"></span><small>${p === g().host ? "host" : ""}${p === mp.pid ? (p === g().host ? " · you" : "you") : ""}</small></li>`).join("");
    $("plist").querySelectorAll(".pn").forEach((n, i) => { n.textContent = playerName(list[i]); });
    $("vsettings").textContent = mp.game ? `Settings: ${cfgText(gameCfg())} · ${ROUND} questions` : "";
    const host = isHost(), enough = list.length >= 2;
    $("vstart").hidden = !host;
    $("vstart").disabled = !enough;
    $("vwaittext").textContent = host
      ? (enough ? "Everyone in? Start the game when you're ready. More players can join until you start." : "Send the others this code. They open this page, choose Party and enter it. Start the game once at least one person has joined.")
      : `Waiting for ${playerName(g().host)} to start the game.`;
  }
  function showPanel(which) {
    $("versus-view").hidden = which !== "lobby";
    $("quiz-view").hidden = which !== "game";
  }
  async function startGame() {
    if (!isHost() || players().length < 2) return;
    $("vstart").disabled = true;
    const list = players();
    const change = { status: "playing", pair: list.length === 2 ? pairKey(list[0], list[1]) : null, started: Date.now() };
    try { await mp.db.doc(`games/${mp.code}`).update(change); }
    catch (e) { $("vstart").disabled = false; return vmsg(errorText(e)); }
    // Go straight into the game; don't wait for the live update to come back around.
    if (mp.game && mp.game.status === "lobby") { mp.game = { ...mp.game, ...change }; onMpChange(); }
    if (list.length >= 4) unlock("host4");
  }
  const lockedQ = (pid) => { const l = pid && mp.locks[pid]; return l && Number.isInteger(l.q) ? l.q : -1; };
  function answerFor(pid, q) {
    const a = pid && mp.answers[`${pid}:${q}`];
    if (!a || !Array.isArray(a.pin) || a.pin.length !== 2 || !a.pin.every(Number.isFinite) || typeof a.choice !== "string") return null;
    return a;
  }
  const pendingKey = (q) => `atlas-mp-${mp.code}-${mp.pid}-${q}`;
  // This player's answer to the question in play, with the power-ups that change its score (Shield,
  // Double up, a Second chance retry) and any golden-landmark points, so everyone scores it the same.
  const myPick = () => ({ choice: String(quiz.choice.id), pin: quiz.pin, hints: quiz.hints.slice(), ms: quiz.ms, bet: quiz.bet || 0,
    shield: !!quiz.shieldOn, dbl: !!quiz.doubleOn, retried: !!quiz.retried, xp: quiz.qxp || 0 });
  function pendingPick(q) {
    if (quiz && quiz.i === q && quiz.locked && quiz.pin && quiz.choice) return myPick();
    const v = lsJSON(pendingKey(q), null);
    return v && Array.isArray(v.pin) && typeof v.choice === "string" ? v : null;
  }
  const validGame = (d) => d && Array.isArray(d.qs) && d.qs.length > 0 && d.qs.every((q) => q && byId.has(q.a) && Array.isArray(q.o));
  function startMpQuiz() {
    const d = mp.game;
    if (!validGame(d)) { showPanel("lobby"); showLobby(); return vmsg("This game can't be loaded. Start a new one."); }
    newQuiz("party", gameCfg(), d.qs, { mpCode: mp.code });
    showPanel("game");
    // Resume after a reload: skip questions every active player has already answered.
    let start = 0;
    while (start < quiz.order.length && active().every((p) => answerFor(p, start))) start++;
    quiz.i = start - 1;
    nextQuestion();
    if (quiz.done) return;
    if (lockedQ(mp.pid) >= quiz.i) {
      const p = pendingPick(quiz.i) || answerFor(mp.pid, quiz.i);
      const choice = p && byId.get(p.choice);
      if (choice) {
        quiz.pin = p.pin; quiz.choice = choice; quiz.hints = Array.isArray(p.hints) ? p.hints : []; quiz.ms = Number.isFinite(p.ms) ? p.ms : null;
        $("qopts").querySelectorAll(".opt").forEach((b) => b.classList.toggle("chosen", b.dataset.id === String(choice.id)));
        stopTimer(); setLockedUI(); updateSteps(); render();
      }
    }
    onMpChange();
  }
  // Pin distances are the slow part of scoring (point-in-country tests on detailed borders). Answers
  // never change once saved, so each distance is worked out once and remembered.
  const kmCache = new Map();
  function cachedKm(key, pin, answerId) {
    const k = `${key}:${answerId}:${pin[0]},${pin[1]}`;
    if (!kmCache.has(k)) { if (kmCache.size > 2000) kmCache.clear(); kmCache.set(k, distanceKm(pin, byId.get(answerId))); }
    return kmCache.get(k);
  }
  // Player p's answers to questions 0..last, scored as one run (streaks and bets carry over).
  // Landmark points on one answer: at most two landmarks' worth on Expert, so a bad record can't swing a game.
  const xpOf = (a) => (a && Number.isFinite(a.xp) ? Math.min(Math.round(SCATTER_PTS * DIFFS.expert.mult * 2), Math.max(0, Math.round(a.xp))) : 0);
  function mpRun(p, last) {
    const answers = [];
    for (let q = 0; q <= last; q++) {
      const a = answerFor(p, q), spec = quiz.qs[q];
      answers.push(a ? { ...answerExtras(spec), right: a.choice === spec.a, km: cachedKm(`${mp.code}:${p}:${q}`, a.pin, spec.a), hints: Array.isArray(a.hints) ? a.hints : [], ms: a.ms, bet: Number.isFinite(a.bet) ? a.bet : 0, shield: !!a.shield, dbl: !!a.dbl, retried: !!a.retried } : null);
    }
    const run = L.scoreRun(answers, quiz.cfg, quiz.qs.length);
    // Golden-landmark points ride along with the answer they were found on.
    run.items.forEach((it, q) => { const x = xpOf(answerFor(p, q)); if (it && x) { it.pts += x; run.total += x; } });
    return run;
  }
  function mpScores() {
    const last = Math.min(quiz.revealed || quiz.done ? quiz.i : quiz.i - 1, quiz.qs.length - 1);
    const totals = {}, names = {}, perQ = Array.from({ length: Math.max(0, last + 1) }, () => ({}));
    players().forEach((p) => {
      const run = mpRun(p, last);
      totals[p] = run.total;
      names[p] = run.items.filter((it) => it.right).length;
      run.items.forEach((it, q) => { perQ[q][p] = it.pts; });
    });
    const order = players().slice().sort((a, b) => totals[b] - totals[a]);
    return { totals, names, perQ, order };
  }
  function renderStandings() {
    const el = $("standings");
    if (!quiz || quiz.kind !== "party") { el.hidden = true; return; }
    const s = mpScores();
    el.hidden = false;
    el.innerHTML = s.order.map((p) => `<li class="${p === mp.pid ? "me" : ""}${!quiz.revealed && lockedQ(p) >= quiz.i ? " locked" : ""}${dropped().includes(p) ? " gone" : ""}"><span class="dot" style="background:${colorOf(p)}"></span><span class="pn"></span><b>${s.totals[p]}</b></li>`).join("");
    el.querySelectorAll(".pn").forEach((n, i) => { n.textContent = s.order[i] === mp.pid ? "You" : playerName(s.order[i]); });
  }
  function updateOppStatus() {
    const el = $("oppstatus");
    if (!quiz || quiz.kind !== "party" || quiz.revealed || quiz.done) { el.hidden = true; $("qdrop").hidden = true; return; }
    const waiting = others().filter((p) => lockedQ(p) < quiz.i), names = waiting.map(playerName);
    const list = names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
    el.hidden = false;
    el.classList.toggle("waiting", !!quiz.locked && waiting.length > 0);
    el.textContent = quiz.locked
      ? (waiting.length ? `You're locked in. Waiting for ${list}…` : "Everyone's locked in. Revealing…")
      : (waiting.length === others().length ? "Nobody has locked in yet." : waiting.length ? `Still deciding: ${list}.` : "Everyone else has locked in.");
    // The host can move on without players who seem to have left.
    const longWait = quiz.locked && waiting.length && quiz.waitSince && Date.now() - quiz.waitSince > 30000;
    $("qdrop").hidden = !(isHost() && longWait);
    $("qdrop").textContent = `Continue without ${list}`;
    if (quiz.locked && waiting.length && !quiz.waitSince) {
      quiz.waitSince = Date.now();
      const q = quiz;
      setTimeout(() => { if (quiz === q && !q.revealed) updateOppStatus(); }, 30500);
    }
  }
  function otherRowHTML(o, ans) {
    const nm = esc(nameOf(ans)), pick = o.choice ? esc(nameOf(o.choice)) : "another country";
    return `<div class="opprow"><span class="who" style="--c:${o.color}"><span class="dot" style="background:${o.color}"></span>${esc(o.name || playerName(o.pid))}</span><span class="pts">${o.pts >= 0 ? "+" : "−"}${Math.abs(o.pts)}</span>${o.right ? `Also picked ${nm}` : `Picked ${pick}`}, with a pin ${o.km === 0 ? `inside ${nm}` : `${fmtKm(o.km)} away`}${o.hints ? `, ${plural(o.hints, "hint")}` : ""}${o.stake ? `, bet ${o.stake} and ${o.betPts >= 0 ? "won" : "lost"} it` : ""}.</div>`;
  }
  async function mpLock() {
    const i = quiz.i, code = quiz.mpCode;
    lsSaveJSON(pendingKey(i), myPick());
    setLockedUI();
    updateOppStatus();
    try { await mp.db.doc(`games/${code}/locks/${mp.pid}`).set({ q: i, at: Date.now() }); }
    catch (e) {
      quiz.locked = false;
      $("qopts").querySelectorAll(".opt").forEach((b) => { b.disabled = false; });
      $("qtype").disabled = false;
      $("qlock").textContent = "Lock in answer"; updateSteps();
      $("oppstatus").hidden = false; $("oppstatus").textContent = errorText(e);
      return;
    }
    onMpChange();
  }
  async function onMpChange() {
    if (!mp.code || mode !== "versus" || !mp.game) return;
    const d = mp.game, inGame = players().includes(mp.pid);
    if (d.status !== "playing") { if (!(quiz && quiz.mpCode === mp.code)) { showPanel("lobby"); showWaiting(); } return; }
    if (!inGame) { showPanel("lobby"); showLobby(); return vmsg("That game started without you. Ask for a new code."); }
    if (dropped().includes(mp.pid)) { showPanel("lobby"); showLobby(); leaveGame(); return vmsg("You were removed from that game after it waited for you. Start or join a new one."); }
    if (!mp.gotLocks || !mp.gotAnswers) return;
    if (!(quiz && quiz.mpCode === mp.code)) { $("vstatus").textContent = ""; startMpQuiz(); return; }
    if (quiz.done) { updateRematchButton(); return; }
    renderStandings(); updateOppStatus();
    const i = quiz.i, act = active();
    // Only once every active player has locked in does this player's answer go to the shared game.
    if (quiz.locked && act.every((p) => lockedQ(p) >= i) && !answerFor(mp.pid, i) && !mp.writing[i]) {
      const pick = pendingPick(i);
      if (pick) {
        mp.writing[i] = true;
        try { await mp.db.doc(`games/${quiz.mpCode}/answers/${mp.pid}-${i}`).set({ pid: mp.pid, q: i, choice: pick.choice, pin: pick.pin, hints: pick.hints || [], ms: Number.isFinite(pick.ms) ? pick.ms : null, bet: Number.isFinite(pick.bet) ? Math.min(1, Math.max(0, pick.bet)) : 0, shield: !!pick.shield, dbl: !!pick.dbl, retried: !!pick.retried, xp: xpOf(pick) }); }
        catch (e) { $("oppstatus").textContent = errorText(e); }
        mp.writing[i] = false;
      }
    }
    if (quiz.locked && !quiz.revealed && act.every((p) => answerFor(p, i))) {
      const ans = quiz.answer, spec = quiz.qs[i];
      quiz.others = others().map((p) => {
        const a = answerFor(p, i), right = a.choice === spec.a, km = cachedKm(`${mp.code}:${p}:${i}`, a.pin, spec.a);
        const run = mpRun(p, i), s = run.items[i];
        return { pid: p, pin: a.pin, choice: byId.get(a.choice), right, km, pts: s.pts, stake: s.stake, betPts: s.betPts, hints: Array.isArray(a.hints) ? a.hints.length : 0, color: colorOf(p) };
      });
      reveal();
    }
  }
  $("qdrop").onclick = async () => {
    if (!quiz || !isHost()) return;
    const waiting = others().filter((p) => lockedQ(p) < quiz.i);
    if (!waiting.length) return;
    $("qdrop").disabled = true;
    try { await mp.db.doc(`games/${mp.code}`).update({ dropped: dropped().concat(waiting) }); } catch (e) { $("oppstatus").textContent = errorText(e); }
    $("qdrop").disabled = false;
  };
  function mpEnd() {
    quiz.done = true;
    const s = mpScores(), n = quiz.order.length, list = s.order;
    quiz.revealed = false; quiz.line = null; quiz.pin = null; quiz.others = null;
    showQuizPart("end");
    $("qbest").hidden = true;
    const top = s.totals[list[0]], winners = list.filter((p) => s.totals[p] === top);
    const iWon = winners.length === 1 && winners[0] === mp.pid;
    $("qfinal").textContent = winners.length > 1 ? (winners.includes(mp.pid) ? "You tied for first" : "It's a tie") : iWon ? "You win!" : `${playerName(winners[0])} wins`;
    const mine = s.totals[mp.pid];
    $("qmsg").textContent = `You scored ${mine} of ${maxFor(quiz.cfg, quiz.qs, n)} and named ${s.names[mp.pid]} of ${n} countries. ${cfgText(quiz.cfg)}.`;
    $("qdots").innerHTML = dotsHTML(mpRun(mp.pid, n - 1).items.map((it) => it || { pts: 0 }), quiz.cfg);
    $("qnum").textContent = "Finished";
    $("qbar").style.width = "100%";
    $("qagain").textContent = "New game";
    $("qagain").classList.remove("primary");
    $("oppstatus").hidden = true;
    $("qendtag").textContent = "Game over";
    $("qrematch").hidden = false;
    $("qrematch").disabled = false;
    updateRematchButton();
    offerShareImage();
    // Final standings for everyone; a head-to-head record when exactly two played.
    $("qextra").innerHTML = `<div class="board"><span class="cat">Final standings</span><ol>${list.map((p, i) => `<li class="${p === mp.pid ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who"></span><span class="sq">${plural(s.names[p], "name")}</span><b>${s.totals[p]}</b></li>`).join("")}</ol></div>`;
    $("qextra").querySelectorAll("li .who").forEach((el, i) => { el.textContent = list[i] === mp.pid ? "You" : playerName(list[i]); });
    const games = bumpStat("partyGames");
    if (iWon) { bumpStat("partyWins"); unlock("win"); }
    if (games >= 10) unlock("rival");
    selected = null; paintClasses(); render();
    recordFinal(s);
  }
  async function recordFinal(s) {
    const code = mp.code, d = mp.game;
    if (!code || !d) return;
    const fin = d.final || {};
    if (players().some((p) => fin[p] !== s.totals[p])) {
      try { await mp.db.doc(`games/${code}`).update({ final: s.totals }); } catch (e) {}
    }
    if (players().length === 2) showHeadToHead(code, s);
  }
  async function showHeadToHead(code, s) {
    const opp = players().find((p) => p !== mp.pid), key = pairKey(mp.pid, opp);
    let w = 0, l = 0, t = 0;
    const tally = (me, them) => { if (me > them) w++; else if (me < them) l++; else t++; };
    tally(s.totals[mp.pid], s.totals[opp]);
    try {
      const snap = await mp.db.collection("games").where("pair", "==", key).get();
      snap.docs.forEach((d) => {
        if (d.id === code) return;
        const f = d.data() && d.data().final;
        if (f && Number.isFinite(f[mp.pid]) && Number.isFinite(f[opp])) tally(f[mp.pid], f[opp]);
      });
    } catch (e) {}
    if (mp.code !== code || !quiz || !quiz.done) return;
    const name = esc(playerName(opp)), games = w + l + t;
    const verdict = games === 1 ? "Your first game together." : w > l ? `You lead after ${games} games.` : w < l ? `${name} leads after ${games} games.` : `All square after ${games} games.`;
    $("qextra").insertAdjacentHTML("afterbegin", `<div class="h2h"><span class="cat">Head to head with ${name}</span>
      <div class="h2h-row"><span><b>${w}</b>You</span><span><b>${l}</b>${name}</span>${t ? `<span><b>${t}</b>${t === 1 ? "Tie" : "Ties"}</span>` : ""}</div>
      <p>${verdict}</p></div>`);
  }
  function updateRematchButton() {
    const b = $("qrematch");
    if (!quiz || quiz.kind !== "party" || !quiz.done) return;
    const r = mp.game && mp.game.rematch;
    if (r && r.by !== mp.pid) { b.textContent = "Join the rematch"; $("qendtag").textContent = `${playerName(r.by)} started a rematch`; }
    else b.textContent = r ? "Go to the rematch" : "Rematch";
  }
  async function rematch() {
    const old = mp.code;
    if (!old) return;
    const b = $("qrematch"); b.disabled = true;
    const ref = mp.db.doc(`games/${old}`);
    try {
      await ref.acquire({ holder: mp.pid, ttlMs: 5000 });
      const d = (await ref.get()).data() || {};
      if (d.rematch && typeof d.rematch.code === "string") { b.disabled = false; return openGame(d.rematch.code); }
      const list = (Array.isArray(d.players) ? d.players : []).filter((p) => !(d.dropped || []).includes(p));
      const code = newCode();
      await mp.db.doc(`games/${code}`).set({ v: 2, host: mp.pid, players: list, names: d.names || {}, status: "playing", diff: d.diff || "easy", timer: !!d.timer, dropped: [], qs: hideAnswers(buildQs(ROUND, Math.random, { diff: d.diff || "easy" }), code), pair: list.length === 2 ? pairKey(list[0], list[1]) : null, created: Date.now(), started: Date.now(), rematchOf: old });
      await ref.update({ rematch: { code, by: mp.pid } });
      b.disabled = false;
      openGame(code);
    } catch (e) { b.disabled = false; $("qmsg").textContent = errorText(e); }
  }
  $("qrematch").onclick = () => rematch();
  $("vcreate").onclick = () => createGame();
  $("vstart").onclick = () => startGame();
  $("vjoinform").addEventListener("submit", (e) => { e.preventDefault(); joinGame($("vcode").value); });
  $("vcancel").onclick = async () => {
    const code = mp.code, d = mp.game;
    if (code && d && d.status === "lobby" && players().includes(mp.pid) && mp.db) {
      try { await mp.db.doc(`games/${code}`).update({ players: players().filter((p) => p !== mp.pid) }); } catch (e) {}
    }
    leaveGame(); showLobby(); vmsg("");
    try { history.replaceState(null, "", "#versus"); } catch (e) {}
  };
  $("vinvite").onclick = () => {
    const code = mp.code, say = (t) => { $("vwaittext").textContent = t; };
    try { navigator.clipboard.writeText(code).then(() => say(`Copied ${code}. Send it to the others; they open this page, choose Party and enter it.`), () => say(`Send the others the code ${code}.`)); }
    catch (e) { say(`Send the others the code ${code}.`); }
  };
  // ---- 55-housekeeping.js ----
  /* ---------- Housekeeping: keep the shared database small ---------- */
  // The page's database holds at most 25,000 documents. When the page's owner opens it (at most once a
  // day), finished business is deleted: party games after 30 days, challenges and daily scores after 60, shared jackpot pools after two days,
  // and global high scores below each board's top 30.
  const DAY_MS = 86400000;
  async function deleteCollection(path, limit = 200) {
    const snap = await mp.db.collection(path).get();
    let n = 0;
    for (const d of snap.docs.slice(0, limit)) { await mp.db.doc(`${path}/${d.id}`).delete(); n++; }
    return n;
  }
  async function housekeeping() {
    const today = dayKey();
    if (!mp.db || lsGet("atlas-cleanup") === today) return;
    lsSet("atlas-cleanup", today);
    let removed = 0;
    try {
      const old = await mp.db.collection("games").where("created", "<", Date.now() - 30 * DAY_MS).limit(25).get();
      for (const d of old.docs) {
        removed += await deleteCollection(`games/${d.id}/locks`);
        removed += await deleteCollection(`games/${d.id}/answers`);
        await mp.db.doc(`games/${d.id}`).delete(); removed++;
      }
      const oldCh = await mp.db.collection("challenges").where("created", "<", Date.now() - 60 * DAY_MS).limit(25).get();
      for (const d of oldCh.docs) {
        removed += await deleteCollection(`challenges/${d.id}/results`);
        await mp.db.doc(`challenges/${d.id}`).delete(); removed++;
      }
      // Daily scores are filed by date; sweep the month that just passed the 60-day mark.
      const now = new Date();
      for (let back = 61; back <= 91; back++) removed += await deleteCollection(`daily/${dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back))}/scores`);
      // Shared jackpot pools are only read on their own day; clear out last week's.
      for (let back = 2; back <= 9; back++) {
        const d = L.utcDayKey(new Date(Date.now() - back * DAY_MS));
        removed += await deleteCollection(`jackpot/${d}/plays`) + await deleteCollection(`jackpot/${d}/wins`);
      }
      // Global high scores: only the top ten of each board are shown; keep a few spare, drop the rest.
      for (const board of [...Object.keys(DIFFS), "survival"]) {
        const snap = await mp.db.collection("topscores").where("board", "==", board).limit(400).get();
        const extra = snap.docs.map((d) => ({ id: d.id, s: Number(d.data()?.s) || 0, at: d.data()?.at || 0 })).sort((a, b) => b.s - a.s || a.at - b.at).slice(30);
        for (const d of extra.slice(0, 50)) { await mp.db.doc(`topscores/${d.id}`).delete(); removed++; }
      }
    } catch (e) { /* try again tomorrow */ lsSet("atlas-cleanup", ""); }
    if (window.ATLAS_TEST) window.__cleanupRemoved = removed;
  }

  // Tell players when their connection drops; shared moves catch up when it returns.
  function updateOnline() {
    const off = navigator.onLine === false;
    const bar = $("offline");
    if (bar) bar.hidden = !off;
  }
  window.addEventListener("online", updateOnline);
  window.addEventListener("offline", updateOnline);
  updateOnline();
  // ---- 60-daily.js ----
  /* ---------- Daily challenge ---------- */
  const DAILY_CFG = { diff: "easy", timer: false };
  const dailyQs = (key) => buildQs(DAILY_N, seededRng("curious-atlas-daily:" + key), { useFilter: false });
  const dailyMax = (key = today()) => maxFor(DAILY_CFG, dailyQs(key), DAILY_N);
  function loadDaily() {
    const v = lsJSON("atlas-daily", null);
    return v && v.history ? v : { last: null, streak: 0, best: 0, played: 0, history: {} };
  }
  const today = () => L.utcDayKey();
  // A streak survives one missed day in any 7 (a "free pass"); two missed days in a row, or a second
  // miss within the week, resets it.
  const passUsedRecently = (st, key) => (st.passes || []).some((d) => { let k = key; for (let i = 0; i < 7; i++) { if (k === d) return true; k = prevDay(k); } return false; });
  const canPass = (st, key) => st.last === prevDay(prevDay(key)) && !passUsedRecently(st, key);
  const liveStreak = (st) => (st.last === today() || st.last === prevDay(today()) || canPass(st, today()) ? st.streak : 0);
  // The streak after playing on day `key`.
  function advanceStreak(st, key) {
    if (st.last === prevDay(key)) return st.streak + 1;
    if (canPass(st, key)) { st.passes = (st.passes || []).concat(prevDay(key)).slice(-8); return st.streak + 1; }
    return 1;
  }
  // Time until the next daily: midnight UTC, the same moment for everyone.
  function untilMidnight() {
    const now = new Date(), m = new Date(now); m.setUTCHours(24, 0, 0, 0);
    const mins = Math.max(1, Math.round((m - now) / 60000)), h = Math.floor(mins / 60);
    return h ? `${h} h ${mins % 60} min` : `${mins} min`;
  }
  // Share squares by how good each answer was (rec.q, 0 to 1). Records from before that was kept fall
  // back to points against a plain 100-point answer.
  const qualities = (rec) => (Array.isArray(rec.q) ? rec.q : (rec.pts || []).map((p, i) => (Number(p) || 0) / (100 * (i === DAILY_N - 1 ? 2 : 1))));
  const squares = (rec) => qualities(rec).map((q) => (q >= 0.75 ? "🟩" : q >= 0.4 ? "🟨" : "🟥")).join("");
  // Longest run of consecutive days in the kept history.
  function bestDailyStreak(st) {
    let best = 0, run = 0, prev = null;
    Object.keys(st.history).sort().forEach((k) => { run = prev && prevDay(k) === prev ? run + 1 : 1; best = Math.max(best, run); prev = k; });
    return Math.max(best, st.streak || 0);
  }
  // The big streak number at the top of the Daily tab.
  function renderDailyStreak() {
    const st = loadDaily(), todayKey = today(), streak = liveStreak(st), doneToday = !!st.history[todayKey];
    const best = bestDailyStreak(st);
    const msg = doneToday
      ? (streak === 1 ? `You've started a streak. The next daily opens in ${untilMidnight()}: play it to make it 2.` : `The next daily opens in ${untilMidnight()}: play it to make it ${streak + 1}.`)
      : streak ? `Play today's daily to make it ${streak + 1}.${canPass(st, todayKey) ? " You missed yesterday, but your free pass for this week keeps the streak alive." : " Miss one day a week and it holds; miss two and it resets."}` : "Play today's daily to start a streak.";
    const days = []; let k = todayKey;
    for (let i = 0; i < 7; i++) { days.unshift(k); k = prevDay(k); }
    const el = $("dstreak");
    el.classList.toggle("zero", !streak);
    el.innerHTML = `<span class="num">${streak}</span><span class="what">${streak === 1 ? "day in a row" : "days in a row"}</span>
      <p class="msg">${msg}${best > streak ? ` Your best is ${best}.` : ""}</p>
      <span class="week" aria-label="Last 7 days">${days.map((d) => `<i class="${st.history[d] ? "on" : ""}${d === todayKey ? " today" : ""}" title="${d}${st.history[d] ? ": played" : ""}"></i>`).join("")}<span>last 7 days</span></span>`;
    el.hidden = false;
  }
  // The daily's card at the top of the Quiz screen: today's puzzle, your streak and the last 7 days.
  function renderDailyCard() {
    const el = $("qdailycard");
    if (!el) return;
    const st = loadDaily(), key = today(), streak = liveStreak(st), rec = st.history[key];
    const days = []; let k = key;
    for (let i = 0; i < 7; i++) { days.unshift(k); k = prevDay(k); }
    el.hidden = false;
    el.innerHTML = `<div class="dtop"><div><span class="cat">Daily challenge</span><h3>${rec ? "Today's daily: done" : "Today's daily is ready"}</h3></div>
        <span class="dstreakn">${streak} <small>${streak === 1 ? "day in a row" : "days in a row"}</small></span></div>
      <p>${rec ? `You scored ${Number(rec.score || 0).toLocaleString("en-US")}. The next one opens in ${untilMidnight()}${streak ? `: play it to make your streak ${streak + 1}` : ""}. Until then, keep playing: every round counts toward your rank, skins and high scores.` : `The same ${DAILY_N} questions for everyone today.${streak ? ` Play to make your streak ${streak + 1}.` : " Play it to start a streak."}`}</p>
      <div class="dtop"><span class="week" aria-label="Last 7 days">${days.map((d) => `<i class="${st.history[d] ? "on" : ""}${d === key ? " today" : ""}" title="${d}${st.history[d] ? ": played" : ""}"></i>`).join("")}</span>
        ${rec ? `<span class="dkeep"><button type="button" class="linkbtn" id="qdaily">Today's results</button><button type="button" class="btn primary" data-keep="quiz" id="qkeep">Keep playing: start a quiz</button></span>`
          : `<button type="button" class="btn primary" id="qdaily">Play today's daily</button>`}</div>`;
    $("qdaily").onclick = () => setMode("daily");
    wireKeepPlaying(el);
  }
  function startDaily() {
    renderDailyStreak();
    const key = today(), qs = dailyQs(key);
    newQuiz("daily", DAILY_CFG, qs, { daily: key });
    if (loadDaily().history[key]) { quiz.done = true; quiz.i = qs.length; showDailyEnd(key); paintClasses(); render(); return; }
    nextQuestion();
    // Already played today on another device (or before clearing this browser)? Then today's daily
    // is done: bring that score here instead of letting it be played again.
    remoteDaily(key).then((rec) => {
      if (!rec || !(quiz && quiz.kind === "daily" && quiz.daily === key && !quiz.done)) return;
      const st = loadDaily();
      if (!st.history[key]) {
        st.streak = advanceStreak(st, key);
        st.last = key; st.played += 1; st.best = Math.max(st.best, rec.score);
        st.history[key] = { score: rec.score, pts: Array.isArray(rec.pts) ? rec.pts : [], q: Array.isArray(rec.q) ? rec.q : null, names: Number.isFinite(rec.names) ? rec.names : null };
        lsSaveJSON("atlas-daily", st);
      }
      stopTimer();
      quiz.done = true; quiz.i = qs.length; quiz.revealed = false; quiz.line = null; quiz.pin = null; selected = null;
      showDailyEnd(key); renderDailyStreak(); paintClasses(); render();
      $("qmsg").textContent = `You already played today's daily (on another device or before this browser was cleared), so that score stands. ${$("qmsg").textContent}`;
    });
  }
  async function remoteDaily(key) {
    if (STANDALONE || (await initMp()) !== true) return null;
    try { const snap = await mp.db.doc(`daily/${key}/scores/${mp.pid}`).get(); const d = snap.exists ? snap.data() : null; return d && d.sv === 2 && Number.isFinite(d.score) ? d : null; }
    catch (e) { return null; }
  }
  function dailyEnd() {
    const key = quiz.daily, st = loadDaily();
    if (!st.history[key]) {
      st.streak = advanceStreak(st, key);
      st.last = key; st.played += 1; st.best = Math.max(st.best, quiz.score);
      st.history[key] = { score: quiz.score, pts: quiz.results.slice(), names: quiz.names, q: myRun().items.map((it) => +L.answerQuality(it, DAILY_CFG).toFixed(2)) };
      const keys = Object.keys(st.history).sort();
      while (keys.length > 90) delete st.history[keys.shift()];
      lsSaveJSON("atlas-daily", st);
      if (st.streak >= 7) unlock("streak7");
      if (quiz.score >= 1000) unlock("daily500");
      postDailyScore(key, st.history[key]);
    }
    quiz.done = true; quiz.revealed = false; quiz.line = null; quiz.pin = null;
    showDailyEnd(key);
    renderDailyStreak();
    offerShareImage();
    selected = null; paintClasses(); render();
  }
  function shareText(key, rec, streak) {
    const [y, m, d] = key.split("-").map(Number);
    const date = new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return `Curious Atlas daily · ${date}\n${rec.score}/${dailyMax(key)} ${squares(rec)}${streak > 1 ? `\n🔥 ${streak}-day streak` : ""}`;
  }
  function showDailyEnd(key) {
    const st = loadDaily(), rec = st.history[key], streak = liveStreak(st);
    showQuizPart("end");
    $("qendtag").textContent = "Today's daily · done";
    $("qbest").textContent = ""; // the streak is shown big at the top of the tab
    $("qfinal").innerHTML = `${rec.score} <span class="of">of ${dailyMax(key)}</span>`;
    $("qmsg").textContent = `${Number.isFinite(rec.names) ? `You named ${rec.names} of ${DAILY_N} countries. ` : ""}Your best daily score is ${st.best}, over ${plural(st.played, "day")} played. A new daily starts in ${untilMidnight()}.`;
    $("qdots").innerHTML = qualities(rec).map((q, i) => dotHTML(rec.pts[i], q)).join("");
    $("qnum").textContent = "Daily challenge";
    $("qscore").textContent = "";
    $("qbar").style.width = "100%";
    $("qagain").textContent = "Back to the quiz menu";
    $("qagain").classList.remove("primary");
    const text = shareText(key, rec, streak);
    $("qextra").innerHTML = `${keepPlayingHTML()}<div class="share"><span class="cat">Share your result</span><pre class="sharecard" id="sharecard"></pre><div class="actions"><button class="btn" id="sharecopy" type="button">Copy result</button><span class="toast" id="sharemsg"></span></div></div><div class="board" id="dboard" hidden></div><div class="board" id="dweek" hidden></div>`;
    $("sharecard").textContent = text;
    const selectCard = () => { const r = document.createRange(); r.selectNodeContents($("sharecard")); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); };
    $("sharecopy").onclick = () => {
      const say = (t) => { $("sharemsg").textContent = t; };
      try { navigator.clipboard.writeText(text).then(() => say("Copied"), () => { selectCard(); say("Selected. Copy it with your keyboard."); }); }
      catch (e) { selectCard(); say("Selected. Copy it with your keyboard."); }
    };
    wireKeepPlaying();
    loadBoard(key);
    loadWeek(key);
  }
  // After today's daily: the way on, front and center. A regular round with your saved level, or Survival.
  const keepPlayingHTML = () => `<div class="keepplay"><span class="cat">Keep playing</span><h3>Today's daily is done. Want more?</h3>
    <p>Play a full ${ROUND}-question round on ${DIFFS[loadCfg().diff].label}, or see how long you last in Survival. The next daily opens in ${untilMidnight()}.</p>
    <div class="actions"><button class="btn primary" type="button" data-keep="quiz">Start a quiz</button><button class="btn" type="button" data-keep="survival">Play Survival</button></div></div>`;
  function keepPlaying(kind) {
    const c = loadCfg();
    setMode("quiz");
    if (kind === "survival") startSurvival({ ...c, survival: true });
    else startQuiz({ diff: c.diff, timer: c.timer });
  }
  const wireKeepPlaying = (root = document) => root.querySelectorAll("[data-keep]").forEach((b) => { b.onclick = () => keepPlaying(b.dataset.keep); });
  async function postDailyScore(key, rec) {
    if ((await initMp()) !== true) return;
    const name = getInitials() || (lsGet("atlas-vname") || "").trim().slice(0, 24); // arcade initials when set
    // The first score of the day is final: a replay (another device, or cleared browser data) never
    // replaces it.
    try {
      const ref = mp.db.doc(`daily/${key}/scores/${mp.pid}`);
      if (!(await ref.get()).exists) await ref.set({ pid: mp.pid, name, score: rec.score, pts: rec.pts, q: rec.q || null, names: rec.names, sv: 2, at: Date.now() });
    } catch (e) { return; }
    if (quiz && quiz.daily === key && quiz.done) { loadBoard(key); loadWeek(key); }
  }
  async function readDay(key) {
    try {
      return (await mp.db.collection(`daily/${key}/scores`).get()).docs.map((d) => d.data())
        // sv 2: scored with streak multipliers and bets; older scores aren't comparable, so they're left out.
        .filter((r) => r && typeof r.pid === "string" && Number.isFinite(r.score) && r.sv === 2);
    } catch (e) { return []; }
  }
  async function labelRows(rows, el) {
    let profiles = {};
    if (mp.user && rows.length) { try { profiles = await mp.user.profiles(rows.map((r) => r.pid)); } catch (e) {} }
    const label = (r) => (r.pid === mp.pid ? "You" : (typeof r.name === "string" && r.name.trim()) || (profiles[r.pid] && profiles[r.pid].name) || "A player");
    el.querySelectorAll("li .who").forEach((n, i) => { n.textContent = label(rows[i]).slice(0, 24); });
  }
  async function loadBoard(key) {
    if ((await initMp()) !== true) return;
    const rows = await readDay(key), el = $("dboard");
    if (!el || !(quiz && quiz.daily === key && quiz.done) || !rows.length) return;
    rows.sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0));
    const top = rows.slice(0, 10);
    el.hidden = false;
    el.innerHTML = `<span class="cat">Today's scores on this page</span><ol>${top.map((r, i) => `<li class="${r.pid === mp.pid ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who"></span><span class="sq">${squares({ pts: (Array.isArray(r.pts) ? r.pts : []).slice(0, DAILY_N), q: Array.isArray(r.q) ? r.q.slice(0, DAILY_N) : null })}</span><b>${r.score}</b></li>`).join("")}</ol>`;
    labelRows(top, el);
  }
  // Weekly league: daily scores added up from Monday to today.
  async function loadWeek(key) {
    if ((await initMp()) !== true) return;
    const [y, m, d] = key.split("-").map(Number), day = new Date(y, m - 1, d);
    const back = (day.getDay() + 6) % 7, keys = [];
    for (let i = back; i >= 0; i--) keys.push(dayKey(new Date(y, m - 1, d - i)));
    const totals = {};
    (await Promise.all(keys.map(readDay))).forEach((rows) => rows.forEach((r) => {
      const t = totals[r.pid] || (totals[r.pid] = { pid: r.pid, name: r.name, score: 0, days: 0 });
      t.score += r.score; t.days += 1; if (r.name) t.name = r.name;
    }));
    const rows = Object.values(totals).sort((a, b) => b.score - a.score), el = $("dweek");
    if (!el || !(quiz && quiz.daily === key && quiz.done) || !rows.length) return;
    const top = rows.slice(0, 10);
    const startLabel = new Date(y, m - 1, d - back).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    el.hidden = false;
    el.innerHTML = `<span class="cat">This week's league · since Monday, ${startLabel}</span><ol>${top.map((r, i) => `<li class="${r.pid === mp.pid ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who"></span><span class="sq">${plural(r.days, "day")}</span><b>${r.score}</b></li>`).join("")}</ol>`;
    labelRows(top, el);
  }
  // ---- 70-challenges.js ----
  /* ---------- Challenges: the same questions, played at different times ---------- */
  // challenges/<code>                    the questions and settings
  // challenges/<code>/results/<player>   each player's answers and total, written when they finish
  const savedName = () => (lsGet("atlas-vname") || "").trim().slice(0, 24);
  const myChallenges = () => lsJSON("atlas-challenges", []);
  function rememberChallenge(code, role) {
    const l = myChallenges().filter((c) => c.code !== code);
    l.unshift({ code, role, at: Date.now() });
    lsSaveJSON("atlas-challenges", l.slice(0, 20));
  }
  function renderChallengeList() {
    const l = myChallenges();
    $("chmine").hidden = !l.length;
    $("chlist").innerHTML = l.map((c) => `<li><button type="button" class="linkbtn" data-code="${esc(c.code)}">${esc(c.code)}</button><small>${c.role === "created" ? "you sent it" : "you played it"} · ${new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</small></li>`).join("");
    $("chlist").querySelectorAll("button").forEach((b) => { b.onclick = () => openChallenge(b.dataset.code); });
  }
  const validAnswer = (a) => a && Array.isArray(a.pin) && a.pin.length === 2 && a.pin.every(Number.isFinite) && typeof a.choice === "string";
  async function readResults(code) {
    const snap = await mp.db.collection(`challenges/${code}/results`).get();
    return snap.docs.map((d) => d.data()).filter((r) => r && typeof r.pid === "string" && Array.isArray(r.answers));
  }
  // Re-score a stored set of answers with the same rule the quiz uses.
  // Re-score a stored set of answers with the same rules the quiz uses (streaks and bets included).
  function runOf(r, qs, cfg, upTo = qs.length - 1) {
    const answers = qs.slice(0, upTo + 1).map((spec, i) => {
      const a = r.answers[i];
      if (!validAnswer(a) || !byId.has(spec.a)) return null;
      return { ...answerExtras(spec), right: a.choice === spec.a, km: cachedKm(`ch:${r.pid}:${i}`, a.pin, spec.a), hints: Array.isArray(a.hints) ? a.hints : [], ms: a.ms, bet: Number.isFinite(a.bet) ? a.bet : 0 };
    });
    return L.scoreRun(answers, cfg, qs.length);
  }
  const scoreRun = (r, qs, cfg) => runOf(r, qs, cfg).items.map((it) => it.pts);
  function challengeOthers(ans) {
    const spec = quiz.qs[quiz.i];
    return (quiz.rivals || []).map((r, idx) => {
      const a = r.answers[quiz.i];
      if (!validAnswer(a)) return null;
      const right = a.choice === spec.a, km = distanceKm(a.pin, ans);
      const s = runOf(r, quiz.qs, quiz.cfg, quiz.i).items[quiz.i];
      return { stake: s.stake, betPts: s.betPts, pid: r.pid, name: r.label, pin: a.pin, choice: byId.get(a.choice), right, km, pts: s.pts, hints: Array.isArray(a.hints) ? a.hints.length : 0, color: PLAYER_COLORS[idx % PLAYER_COLORS.length] };
    }).filter(Boolean);
  }
  async function labelResults(results) {
    let profiles = {};
    if (mp.user && results.length) { try { profiles = await mp.user.profiles(results.map((r) => r.pid)); } catch (e) {} }
    results.forEach((r) => { r.label = r.pid === mp.pid ? "You" : ((typeof r.name === "string" && r.name.trim()) || (profiles[r.pid] && profiles[r.pid].name) || "A friend").slice(0, 24); });
    return results;
  }
  async function openChallenge(raw) {
    const code = String(raw || "").trim().toUpperCase(), say = (t) => { $("chmsg").textContent = t || ""; };
    if (mode !== "quiz") setMode("quiz");
    if (!/^[A-Z0-9]{5}$/.test(code)) return say("Challenge codes are 5 letters and numbers, like KX4QP.");
    if ((await initMp()) !== true) return say("Challenges need you signed in to claude.ai, with Contributor (or Editor) access to this page. Ask the page's owner to share it with you.");
    say("Loading the challenge…");
    let d, results;
    try {
      const snap = await mp.db.doc(`challenges/${code}`).get();
      if (!snap.exists) return say(`There's no challenge with the code ${code}. Check it with your friend.`);
      d = snap.data();
      if (d && Array.isArray(d.qs)) d.qs = showAnswers(d.qs, code);
      results = await labelResults(await readResults(code));
    } catch (e) { return say(errorText(e)); }
    if (!validGame(d)) return say("This challenge can't be loaded. Ask your friend for a new one.");
    say("");
    try { history.replaceState(null, "", `#ch-${code}`); } catch (e) {}
    const cfg = { diff: DIFFS[d.diff] ? d.diff : "easy", timer: !!d.timer };
    const rivals = results.filter((r) => r.pid !== mp.pid);
    newQuiz("challenge", cfg, d.qs, { chCode: code, rivals });
    if (results.some((r) => r.pid === mp.pid)) { quiz.done = true; quiz.i = d.qs.length; showChallengeResults(code); return; }
    nextQuestion();
  }
  async function challengeEnd() {
    const code = quiz.chCode;
    quiz.done = true; quiz.revealed = false; quiz.line = null; quiz.pin = null; quiz.others = null;
    bumpStat("quizzes");
    showQuizPart("end");
    $("qfinal").textContent = "Saving your answers…";
    // Your first finished run is the one that counts: never overwrite a result that's already saved
    // (from another tab or device).
    try {
      const ref = mp.db.doc(`challenges/${code}/results/${mp.pid}`);
      if (!(await ref.get()).exists) await ref.set({ pid: mp.pid, name: savedName(), total: quiz.score, names: quiz.names, answers: quiz.log, at: Date.now() });
    }
    catch (e) { $("qfinal").textContent = `${quiz.score} points`; $("qmsg").textContent = `Your result couldn't be saved. ${errorText(e)}`; return; }
    rememberChallenge(code, "played");
    showChallengeResults(code);
    offerShareImage();
  }
  async function showChallengeResults(code) {
    showQuizPart("end");
    const cfg = quiz.cfg, qs = quiz.qs, n = qs.length;
    $("qendtag").textContent = `Challenge ${code}`;
    $("qbest").textContent = cfgText(cfg);
    $("qnum").textContent = "Challenge";
    $("qscore").textContent = "";
    $("qbar").style.width = "100%";
    $("qagain").textContent = "Play a new quiz";
    $("qfinal").textContent = "Loading results…";
    $("qmsg").textContent = ""; $("qdots").innerHTML = ""; $("qextra").innerHTML = "";
    let results = [];
    try { results = await labelResults(await readResults(code)); } catch (e) { $("qfinal").textContent = "Results unavailable"; $("qmsg").textContent = errorText(e); return; }
    if (!(quiz && quiz.chCode === code)) return;
    results.forEach((r) => { r.pts = scoreRun(r, qs, cfg); r.sum = r.pts.reduce((a, b) => a + b, 0); r.named = r.answers.filter((a, i) => validAnswer(a) && qs[i] && a.choice === qs[i].a).length; });
    results.sort((a, b) => b.sum - a.sum || (a.at || 0) - (b.at || 0));
    const me = results.find((r) => r.pid === mp.pid), rank = results.indexOf(me) + 1;
    const leader = results[0];
    $("qfinal").textContent = results.length < 2 ? "Waiting for your friends"
      : rank === 1 && (results[1].sum < me.sum) ? "You're in first place"
      : rank === 1 || (me && me.sum === leader.sum) ? "You're tied for first"
      : `${leader.label} is ahead`;
    $("qmsg").textContent = me
      ? `You scored ${me.sum} of ${maxFor(cfg, qs, n)} and named ${me.named} of ${n} countries. ${results.length < 2 ? `Nobody else has played yet. Send them the code ${code}.` : `${plural(results.length, "player")} played this challenge${rank ? `; you're ${rank} of ${results.length}` : ""}.`}`
      : "";
    if (me) $("qdots").innerHTML = dotsHTML(runOf(me, qs, cfg).items, cfg);
    // Side-by-side comparison: you plus up to three others.
    const cols = [me, ...results.filter((r) => r !== me)].filter(Boolean).slice(0, 4);
    const rows = qs.map((spec, i) => {
      const best = Math.max(...cols.map((c) => c.pts[i]));
      const f = byId.get(spec.a);
      return `<tr><td>${i + 1}. ${esc(f ? nameOf(f) : "")}</td>${cols.map((c) => `<td class="${c.pts[i] === best && cols.length > 1 ? "best" : ""}">${c.pts[i]}</td>`).join("")}</tr>`;
    }).join("");
    const head = `<tr><th>Question</th>${cols.map((c) => `<th></th>`).join("")}</tr>`;
    const foot = `<tr><td>Total</td>${cols.map((c) => `<td>${c.sum}</td>`).join("")}</tr>`;
    $("qextra").innerHTML = `${results.length > 1 ? `<div class="board"><span class="cat">Standings</span><ol>${results.map((r, i) => `<li class="${r.pid === mp.pid ? "me" : ""}"><span class="rank">${i + 1}</span><span class="who"></span><span class="sq">${plural(r.named, "name")}</span><b>${r.sum}</b></li>`).join("")}</ol></div>` : ""}
      <div class="cmp"><span class="cat">Question by question</span><table><thead>${head}</thead><tbody>${rows}</tbody><tfoot>${foot}</tfoot></table></div>
      <div class="chmake"><span class="cat">Challenge more friends</span><div class="vcode">${esc(code)}</div><p>They open this page, choose Quiz and enter the code under “Got a challenge code?”. Their results will show up here.</p><div class="actions"><button class="btn" type="button" id="chcopy2">Copy code</button><span class="toast" id="chcopymsg2"></span></div></div>`;
    $("qextra").querySelectorAll(".board li .who").forEach((el, i) => { el.textContent = results[i].label; });
    $("qextra").querySelectorAll(".cmp thead th").forEach((el, i) => { if (i > 0) el.textContent = cols[i - 1].label; });
    $("chcopy2").onclick = () => copyCode(code, $("chcopymsg2"));
    selected = null; paintClasses(); render();
  }
  function copyCode(code, el) {
    try { navigator.clipboard.writeText(code).then(() => { el.textContent = `Copied ${code}`; }, () => { el.textContent = `The code is ${code}`; }); }
    catch (e) { el.textContent = `The code is ${code}`; }
  }
  // From the end of a solo quiz: turn its questions into a challenge for friends.
  function offerChallenge() {
    if (!quiz || quiz.kind !== "solo" || !quiz.done) return;
    $("qchallenge").hidden = true;
    const box = document.createElement("div");
    box.className = "chmake";
    box.innerHTML = `<span class="cat">Challenge a friend</span><p>Friends play these exact ${quiz.qs.length} questions whenever they like, then you both see who did better, question by question.</p>
      <label class="field" for="chname"><span>Your name</span><input id="chname" maxlength="24" autocomplete="nickname" placeholder="Shown to your friends"></label>
      <div class="actions"><button class="btn primary" type="button" id="chcreate">Create the challenge</button></div><p class="toast" id="chmakemsg"></p>`;
    $("qextra").prepend(box);
    $("chname").value = savedName();
    $("chcreate").onclick = () => createChallenge();
  }
  async function createChallenge() {
    const q = quiz, say = (t) => { $("chmakemsg").textContent = t; };
    if (!q || q.kind !== "solo") return;
    if ((await initMp()) !== true) return say("Challenges need you signed in to claude.ai with edit access to this page.");
    const name = $("chname").value.trim().slice(0, 24);
    lsSet("atlas-vname", name);
    if ($("vname")) $("vname").value = name;
    $("chcreate").disabled = true; say("Creating…");
    // A challenge is the regular round only; bonus questions stay with the player who earned them.
    const code = newCode(), qs = hideAnswers(q.qs.slice(0, q.baseN).map(({ r, ...rest }) => rest), code);
    try {
      await mp.db.doc(`challenges/${code}`).set({ v: 1, by: mp.pid, diff: q.cfg.diff, timer: !!q.cfg.timer, qs, created: Date.now() });
      await mp.db.doc(`challenges/${code}/results/${mp.pid}`).set({ pid: mp.pid, name, total: q.score, names: q.names, answers: q.log.slice(0, q.baseN), at: Date.now() });
    } catch (e) { $("chcreate").disabled = false; return say(errorText(e)); }
    rememberChallenge(code, "created");
    try { history.replaceState(null, "", `#ch-${code}`); } catch (e) {}
    const box = $("chcreate").closest(".chmake");
    box.innerHTML = `<span class="cat">Challenge created</span><div class="vcode">${code}</div><p>Send this code to your friends. They open this page, choose Quiz and enter it under “Got a challenge code?”. You can also use the Share menu's Copy link while this screen is open; that link opens the challenge directly.</p><div class="actions"><button class="btn primary" type="button" id="chcopy">Copy code</button><button class="btn" type="button" id="chview">See results</button></div><p class="toast" id="chcopymsg"></p>`;
    $("chcopy").onclick = () => copyCode(code, $("chcopymsg"));
    $("chview").onclick = () => openChallenge(code);
  }
  $("qchallenge").onclick = () => offerChallenge();
  $("chform").addEventListener("submit", (e) => { e.preventDefault(); openChallenge($("chcode").value); });
  // ---- 80-share.js ----
  /* ---------- Shareable result image ---------- */
  // At the end of a round: a 1080×1350 picture with the score, a neon globe of your guesses
  // (orange: named right, red: named wrong, a line from each pin to the answer) and one square per question.
  function shareCardCanvas() {
    const W = 1080, H = 1350, cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const g = cv.getContext("2d"), css = getComputedStyle(wrap);
    const col = (name, fb) => (css.getPropertyValue(name) || fb).trim() || fb;
    const orange = "#ff9a3d", red = "#ff3b3b", teal = "#3aa892", ink = "#e4edef", muted = "#8ea2a9";
    // Background.
    const bg = g.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0b2230"); bg.addColorStop(1, "#071017");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    const display = col("--font-display", "sans-serif"), mono = col("--font-mono", "monospace");
    // Header.
    const n = quiz.order.length, max = maxFor(quiz.cfg, quiz.qs, n);
    const label = quiz.kind === "daily" ? `Daily challenge · ${quiz.daily}` : quiz.kind === "challenge" ? `Challenge ${quiz.chCode}` : quiz.kind === "party" ? "Party game" : `Quiz · ${DIFFS[quiz.cfg.diff].label}`;
    g.fillStyle = muted; g.font = `500 30px ${mono}`; g.textBaseline = "alphabetic";
    g.fillText("CURIOUS ATLAS", 80, 110);
    g.fillText(label.toUpperCase(), 80, 152);
    g.fillStyle = ink; g.font = `800 132px ${display}`;
    g.fillText(String(quiz.score), 80, 290);
    const sw = g.measureText(String(quiz.score)).width;
    g.fillStyle = muted; g.font = `600 48px ${display}`;
    g.fillText(`of ${max}`, 80 + sw + 24, 290);
    g.fillStyle = ink; g.font = `500 36px ${display}`;
    g.fillText(`Named ${quiz.names} of ${n}${quiz.bestStreak >= 2 ? ` · best streak ${quiz.bestStreak}` : ""}`, 80, 350);
    // Globe centered on the answers.
    const pts = quiz.order.map((f) => centroidOf(f));
    const mean = d3.geoCentroid({ type: "MultiPoint", coordinates: pts });
    const R = 360, cx = W / 2, cy = 780;
    const proj = d3.geoOrthographic().scale(R).translate([cx, cy]).rotate([-mean[0], -mean[1]]).clipAngle(90).precision(0.6);
    const gp = d3.geoPath(proj, g);
    // Halo: warmer and bigger with a good streak.
    const heatNow = Math.min(quiz.bestStreak, 8) / 8;
    const halo = g.createRadialGradient(cx, cy, R * 0.9, cx, cy, R * (1.14 + 0.12 * heatNow));
    halo.addColorStop(0, heatNow > 0.3 ? "rgba(255,160,50,0.85)" : "rgba(60,210,200,0.55)"); halo.addColorStop(1, "rgba(0,0,0,0)");
    g.fillStyle = halo; g.beginPath(); g.arc(cx, cy, R * (1.14 + 0.12 * heatNow), 0, Math.PI * 2); g.fill();
    g.fillStyle = "#071c27"; g.beginPath(); gp({ type: "Sphere" }); g.fill();
    g.fillStyle = teal; g.strokeStyle = "#0b2a2c"; g.lineWidth = 0.6;
    features.forEach((f) => { g.beginPath(); gp(scoreShape(f)); g.fill(); g.stroke(); });
    // Each question: neon outline of the answer, a line from the pin, the pin.
    quiz.order.forEach((f, i) => {
      const a = quiz.log[i]; if (!a) return;
      const right = !!myRun().items[i]?.right, c = right ? orange : red;
      g.save(); g.shadowColor = c; g.shadowBlur = 18;
      g.fillStyle = right ? orange : "rgba(255,59,59,0.85)"; g.beginPath(); gp(scoreShape(f)); g.fill();
      g.restore();
      if (a.pin) {
        g.save(); g.strokeStyle = "rgba(255,255,255,0.75)"; g.setLineDash([8, 8]); g.lineWidth = 3;
        g.beginPath(); gp({ type: "LineString", coordinates: [a.pin, centroidOf(f)] }); g.stroke(); g.restore();
        const p = proj(a.pin);
        if (p && d3.geoDistance(a.pin, [mean[0], mean[1]]) < Math.PI / 2) { g.fillStyle = "#fff"; g.beginPath(); g.arc(p[0], p[1], 7, 0, Math.PI * 2); g.fill(); }
      }
    });
    // One square per question, like the daily share text.
    const sq = 56, gap = 14, total = n * sq + (n - 1) * gap, x0 = (W - total) / 2, y0 = 1210;
    myRun().items.forEach((it, i) => {
      const q = L.answerQuality(it, quiz.cfg);
      g.fillStyle = q >= 0.75 ? orange : q >= 0.4 ? "#f2b84b" : red;
      g.beginPath(); g.roundRect(x0 + i * (sq + gap), y0, sq, sq, 12); g.fill();
    });
    return cv;
  }
  async function saveShareImage() {
    const btn = $("qshareimg");
    const blob = await new Promise((res) => shareCardCanvas().toBlob(res, "image/png"));
    if (!blob) return;
    const filename = `curious-atlas-${quiz.kind === "daily" ? `daily-${quiz.daily}` : "result"}.png`;
    try {
      if (!STANDALONE) {
        const dl = window.claude ? await claude.use("downloads") : null;
        if (!dl) { btn.hidden = true; return; }
        await dl.save({ filename, data: blob });
        return;
      }
      const file = new File([blob], filename, { type: "image/png" });
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: "Curious Atlas" }); return; }
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    } catch (e) {
      if (e && (e.code === "unavailable" || e.code === "not_granted")) btn.hidden = true;
    }
  }
  // Called by every end screen once a round has been played start to finish in this browser.
  function offerShareImage() {
    $("qshareimg").hidden = !(quiz && quiz.log && quiz.log.length === quiz.order.length);
  }
  $("qshareimg").onclick = () => saveShareImage();
  if (window.ATLAS_TEST) window.shareCardForTest = () => shareCardCanvas().toDataURL("image/png");
  // ---- 90-modes-boot.js ----
  /* ---------- Modes and controls ---------- */
  // The daily lives inside Quiz (a card on its screen), so it has no tab of its own.
  const MODES = ["quiz", "versus", "explore", "passport"];
  let countryOfDay = null;
  function setMode(m) {
    clearPerfect(); clearFever(); clearScatter(); clearCues(); endCountdown();
    if (!(m === "quiz" && quiz && quiz.kind === "tutorial")) abortTutorial();
    if (m !== "explore") stopAttract();
    mode = m;
    document.body.dataset.mode = m;
    if (m !== "quiz" && m !== "daily" && !(m === "versus" && quiz && quiz.kind === "party" && !quiz.done)) document.body.classList.remove("playing");
    MODES.forEach((x) => $("mode-" + x).setAttribute("aria-pressed", String(m === x || (x === "quiz" && m === "daily"))));
    $("explore-view").hidden = m !== "explore";
    $("quiz-view").hidden = !(m === "quiz" || m === "daily");
    $("dstreak").hidden = m !== "daily";
    $("versus-view").hidden = m !== "versus";
    $("passport-view").hidden = m !== "passport";
    $("surprise").hidden = m !== "explore";
    $("standings").hidden = true;
    $("oppstatus").hidden = true;
    $("qtimer").hidden = true;
    wrap.classList.toggle("quizzing", inQuiz());
    wrap.classList.remove("noborders");
    if (!(m === "versus" && quiz && quiz.kind === "party")) stopTimer();
    if (quiz && quiz.kind !== "party" && m !== "quiz" && m !== "daily") quiz = null;
    const hash = (h) => { try { history.replaceState(null, "", h); } catch (e) {} };
    if (m === "quiz") { hash("#quiz"); showSetup(); }
    else if (m === "daily") { hash("#daily"); startDaily(); }
    else if (m === "versus") {
      if (quiz && quiz.kind !== "party") quiz = null;
      showVersusLobby();
      if (mp.code && quiz && quiz.mpCode === mp.code) {
        showPanel("game"); renderStandings(); updateOppStatus();
        if (!quiz.revealed && !quiz.locked && !quiz.done) startTimer();
        if (quiz.cfg.diff === "expert" && !quiz.revealed && !quiz.done) wrap.classList.add("noborders");
        hash(`#game-${mp.code}`);
      } else if (mp.code) { showPanel("lobby"); showWaiting(); onMpChange(); }
      else { showPanel("lobby"); showLobby(); hash("#versus"); }
      paintClasses(); render();
    } else if (m === "passport") {
      hash("#passport");
      selected = null;
      renderPassport(); paintClasses(); render(); zoomOut();
    } else {
      const f = selected || withFacts()[0];
      select(f, f === countryOfDay ? { tag: "Country of the day" } : {});
    }
  }
  // Tapping a flag (phones have no hover) toggles it big; tapping anywhere else shrinks it.
  document.addEventListener("click", (e) => {
    const fl = e.target.closest && e.target.closest(".zoomflag");
    document.querySelectorAll(".zoomflag.big").forEach((x) => { if (x !== fl) x.classList.remove("big"); });
    if (fl) fl.classList.toggle("big");
  });
  MODES.forEach((x) => { $("mode-" + x).onclick = () => { if (mode !== x || x === "quiz") setMode(x); }; });
  $("qback").onclick = $("pback").onclick = () => setMode("explore");
  // Leaving a quiz, daily, Survival or the tutorial goes back to the Quiz screen; a party game, to Explore.
  $("qquit").onclick = () => { const party = quiz && quiz.kind === "party"; abortTutorial(); setMode(party ? "explore" : "quiz"); };
  $("qagain").onclick = () => {
    if (quiz && quiz.kind === "party") { leaveGame(); setMode("versus"); }
    else if (quiz && quiz.kind === "challenge") setMode("quiz");
    else if (quiz && quiz.kind === "survival") startSurvival(quiz.cfg);
    else if (quiz && quiz.kind === "daily") { mode = "quiz"; MODES.forEach((x) => $("mode-" + x).setAttribute("aria-pressed", String(x === "quiz"))); try { history.replaceState(null, "", "#quiz"); } catch (e) {} showSetup(); }
    else startQuiz(quiz ? quiz.cfg : loadCfg());
  };

  // Topics: "All topics" is the default; a dropdown narrows the map and quizzes to one topic.
  function setChips() {
    $("allchip").setAttribute("aria-pressed", String(!filter));
    $("topicsel").value = filter || "";
    $("topicsel").classList.toggle("on", !!filter);
  }
  function setFilter(val) {
    filter = val || null; setChips(); paintClasses();
    if (mode === "explore" && selected) select(selected, { noFly: true });
  }
  function buildFilters() {
    const counts = {};
    Object.values(FACTS).forEach((list) => new Set(list.map((x) => x[0])).forEach((c) => (counts[c] = (counts[c] || 0) + 1)));
    const all = document.createElement("button");
    all.type = "button"; all.className = "chip"; all.id = "allchip"; all.textContent = "All topics";
    all.onclick = () => setFilter(null);
    const label = document.createElement("label");
    label.className = "topicpick"; label.htmlFor = "topicsel";
    label.innerHTML = `<span class="sr-only">Pick one topic</span><select id="topicsel"><option value="">One topic…</option>${CATS.filter((c) => counts[c]).sort((a, b) => catLabel(a).localeCompare(catLabel(b))).map((c) => `<option value="${esc(c)}">${esc(catLabel(c))} (${counts[c]})</option>`).join("")}</select>`;
    $("chiprow").append(all, label);
    $("topicsel").addEventListener("change", (e) => setFilter(e.target.value));
    setChips();
  }
  function fromHash() {
    const m = /^#c-([A-Za-z0-9-]+)$/.exec(location.hash);
    return m ? byId.get(m[1]) : null;
  }
  // #daily, #quiz, #passport, #versus, #game-KX4QP (join or rejoin that game)
  function route() {
    const h = location.hash;
    if (h === "#quiz") { if (mode !== "quiz") setMode("quiz"); return true; }
    if (h === "#daily") { if (mode !== "daily") setMode("daily"); return true; }
    if (h === "#passport") { if (mode !== "passport") setMode("passport"); return true; }
    if (STANDALONE) return false;
    const m = /^#game-([A-Za-z0-9]{5})$/.exec(h);
    if (m) {
      const code = m[1].toUpperCase();
      if (mode !== "versus") setMode("versus");
      if (mp.code !== code) joinGame(code);
      return true;
    }
    if (h === "#versus") { if (mode !== "versus") setMode("versus"); return true; }
    const c = /^#ch-([A-Za-z0-9]{5})$/.exec(h);
    if (c) { if (!(quiz && quiz.chCode === c[1].toUpperCase())) openChallenge(c[1]); return true; }
    return false;
  }

  // The light map is only for drawing while the globe moves, so the page doesn't wait for it.
  const getJSON = (key, file) => (window.ATLAS_PRE && window.ATLAS_PRE[key]) || fetch(file).then((r) => r.json());
  getJSON("m110", "countries-110m.json").then((lite) => {
    const lo = topojson.feature(lite, lite.objects.countries).features;
    lo.forEach((f) => { if (!f.id) f.id = f.properties.name.replace(/[^A-Za-z]/g, ""); });
    landsLo = d3.select("#lands-lo").selectAll("path").data(lo).join("path").attr("class", "country has");
    // First paint: if the standard map is still downloading, show the globe now with this light map.
    if (!features.length) { setLowRes(true); size(); }
  }).catch(() => {});
  // Rivers and lakes are decoration: they start downloading only once the globe is drawn.
  const loadHydro = () => fetch("hydro.json").then((r) => r.json()).then((h) => {
    hydro = { rivers: topojson.feature(h, h.objects.rivers), lakes: topojson.feature(h, h.objects.lakes) };
    render();
  }).catch(() => {});
  getJSON("m50", "countries-50m.json").then((world) => {
    worldTopo = world;
    features = topojson.feature(world, world.objects.countries).features;
    features.forEach((f) => { if (!f.id) f.id = f.properties.name.replace(/[^A-Za-z]/g, ""); byId.set(String(f.id), f); });
    // Give each country one of six colors so that no two neighbors match, spreading the colors evenly:
    // busiest countries first, each taking the least-used color its neighbors don't have.
    const nb = topojson.neighbors(world.objects.countries.geometries), counts = [0, 0, 0, 0, 0, 0, 0];
    features.forEach((f, i) => NEIGHBORS.set(String(f.id), nb[i].map((j) => String(features[j].id))));
    const order = features.map((_, i) => i).sort((a, b) => nb[b].length - nb[a].length || String(features[a].id).localeCompare(String(features[b].id)));
    order.forEach((i) => {
      const used = new Set(nb[i].map((j) => features[j].mc));
      const free = [1, 2, 3, 4, 5, 6].filter((c) => !used.has(c));
      const c = (free.length ? free : [1, 2, 3, 4, 5, 6]).sort((a, b) => counts[a] - counts[b] || a - b)[0];
      features[i].mc = c; counts[c]++;
    });
    $("names").innerHTML = features.map((f) => nameOf(f)).sort().map((n) => `<option value="${esc(n)}"></option>`).join("");
    const nFacts = Object.values(FACTS).reduce((a, l) => a + l.length, 0);
    $("sub").textContent = `${nFacts} field notes · ${withFacts().length} countries and territories`;
    const onCountryClick = (ev, f) => { if (mode === "explore" || mode === "passport") { if (mode === "passport") setMode("explore"); select(f, { peek: true }); } };
    const onCountryHover = (ev, f) => {
      if (ev.pointerType !== "mouse") return;
      if (inQuiz() && quiz && !quiz.revealed && !quiz.done) { $("tip").hidden = true; return; }
      const [x, y] = d3.pointer(ev, wrap);
      const tip = $("tip"); tip.hidden = false; tip.textContent = nameOf(f);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    };
    lands = d3.select("#lands").selectAll("path").data(features).join("path")
      .attr("class", (f) => `country m${f.mc}`)
      .on("click", onCountryClick)
      .on("pointermove", onCountryHover)
      .on("pointerenter", function () { if (!wrap.classList.contains("noborders")) d3.select(this).raise(); })
      .on("pointerleave", () => { $("tip").hidden = true; });
    if (STANDALONE) {
      $("mode-versus").hidden = true;
      document.querySelector(".chbox").hidden = true;
      $("offline").textContent = "You're offline. Everything already loaded keeps working.";
      document.querySelector("#passport-view .vintro").textContent = "Name a country correctly in any quiz or daily challenge to stamp it into your passport. Stamped places glow on the globe.";
    }
    buildFilters();
    // Skins: Neon Night for everyone, the rest won by playing (45-skins.js). Remembered per browser.
    checkSkins(true);
    applySkin(lsGet("atlas-look"));
    if (lowRes && !moving) setLowRes(false); // the full map is here: swap out the light one
    size();
    new ResizeObserver(size).observe(wrap);
    setTimeout(loadHydro, 400);
    if (route()) return;
    const start = fromHash();
    if (start) { select(start); return; }
    const pool = withFacts().sort((a, b) => String(a.id).localeCompare(String(b.id)));
    const day = Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
    const f = pool[day % pool.length];
    const [lon, lat] = centroidOf(f);
    rot = [-lon, -lat, 0];
    // Players open on the Quiz screen (today's daily on top); Explore keeps the country of the day.
    countryOfDay = f;
    selected = f;
    setK(targetZoom(f));
    setMode("quiz");
  }).catch((e) => {
    console.error(e);
    $("name").textContent = "The map didn't load";
    $("facts").innerHTML = `<li><p class="empty">Reload the page to try again.</p></li>`;
  });

  window.addEventListener("hashchange", () => {
    if (route()) return;
    const f = fromHash();
    if (f && f !== selected) { if (mode !== "explore") { selected = f; setMode("explore"); } else select(f); }
  });
  $("surprise").onclick = () => surprise();
  $("next").onclick = () => surprise();
  $("q").addEventListener("change", (e) => {
    const v = simpleName(e.target.value);
    if (!v) return;
    const f = findByName(v) || features.find((x) => simpleName(nameOf(x)).startsWith(v)) || features.find((x) => simpleName(nameOf(x)).includes(v));
    if (f) {
      e.target.value = ""; e.target.blur();
      if (mode !== "explore") { selected = f; setMode("explore"); } else select(f, { focus: true });
    } else {
      if (mode !== "explore") setMode("explore");
      $("toast").textContent = `No country matches "${e.target.value}". Check the spelling or pick from the list.`;
    }
  });
  $("copy").onclick = () => {
    const url = location.href, done = () => ($("toast").textContent = "Link copied");
    try { navigator.clipboard.writeText(url).then(done, () => ($("toast").textContent = url)); }
    catch (e) { $("toast").textContent = url; }
  };
})();
