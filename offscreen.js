function normalizeText(value) {
  return String(value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeKey(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function parseNumberToken(token) {
  if (token === null || token === undefined) {
    return NaN;
  }

  if (typeof token === "number") {
    return Number.isFinite(token) ? token : NaN;
  }

  const cleaned = normalizeText(token).toUpperCase();
  if (!cleaned || cleaned.startsWith("#")) {
    return NaN;
  }

  const suffixMatch = cleaned.match(/([KMB])$/);
  const suffix = suffixMatch?.[1] || "";
  const withoutSuffix = suffix ? cleaned.slice(0, -1).trim() : cleaned;
  let numericText = withoutSuffix.replace(/[^\d.,-]/g, "");

  if (!numericText || numericText === "-") {
    return NaN;
  }

  if (suffix) {
    // Em números compactos, a última vírgula ou ponto é decimal.
    const lastComma = numericText.lastIndexOf(",");
    const lastDot = numericText.lastIndexOf(".");
    const decimalIndex = Math.max(lastComma, lastDot);

    if (decimalIndex >= 0) {
      const integerPart = numericText.slice(0, decimalIndex).replace(/[.,]/g, "");
      const decimalPart = numericText.slice(decimalIndex + 1).replace(/[.,]/g, "");
      numericText = `${integerPart}.${decimalPart}`;
    }

    const base = Number(numericText);
    const multiplier = suffix === "K" ? 1e3 : suffix === "M" ? 1e6 : 1e9;
    return Number.isFinite(base) ? Math.round(base * multiplier) : NaN;
  }

  // Os cards usam vírgula/ponto como separador de milhar.
  const digitsOnly = numericText.replace(/[.,]/g, "");
  const value = Number(digitsOnly);
  return Number.isFinite(value) ? value : NaN;
}

function isStandaloneNumberLine(line) {
  const text = normalizeText(line);
  if (!text || text.startsWith("#")) return false;
  return /^\d[\d.,]*\s*[KMB]?$/i.test(text);
}

function parseMetricLine(line) {
  const text = normalizeText(line);
  if (!text || text.startsWith("#")) return NaN;

  // Fortnite.GG can place the ranking in the same text node as the value,
  // for example "857 #4,618". Read only the leading player-count token.
  const match = text.match(/^(\d[\d.,]*\s*[KMB]?)(?:\s+#\s*[\d.,]+)?$/i);
  return match ? parseNumberToken(match[1]) : NaN;
}

function getVisibleTextLines(doc) {
  const lines = [];
  const root = doc.body || doc.documentElement;
  if (!root) return lines;

  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    const parent = node.parentElement;

    if (parent?.closest("script, style, noscript, svg, template")) {
      continue;
    }

    const text = normalizeText(node.nodeValue);
    if (text) lines.push(text);
  }

  return lines;
}

function findLabelLineIndex(lines, patterns) {
  return lines.findIndex((line) => patterns.some((pattern) => pattern.test(line)));
}

function findNumberBeforeLabel(lines, patterns, maxLookback = 14) {
  const labelIndex = findLabelLineIndex(lines, patterns);
  if (labelIndex < 0) return NaN;

  for (let i = labelIndex - 1; i >= Math.max(0, labelIndex - maxLookback); i -= 1) {
    const value = parseMetricLine(lines[i]);
    if (Number.isFinite(value)) return value;
  }

  return NaN;
}

function findNumberAfterLabelBeforeNext(lines, patterns, stopPatterns, maxLookahead = 12) {
  const labelIndex = findLabelLineIndex(lines, patterns);
  if (labelIndex < 0) return NaN;

  for (let i = labelIndex + 1; i < Math.min(lines.length, labelIndex + maxLookahead + 1); i += 1) {
    const line = lines[i];
    if (stopPatterns.some((pattern) => pattern.test(line))) break;

    const value = parseMetricLine(line);
    if (Number.isFinite(value)) return value;
  }

  return NaN;
}


function findMetricBetweenLabels(lines, labelPatterns, previousPatterns, nextPatterns, preference = "after") {
  const labelIndex = findLabelLineIndex(lines, labelPatterns);
  if (labelIndex < 0) return NaN;

  let start = 0;
  let end = lines.length;

  if (previousPatterns?.length) {
    for (let i = labelIndex - 1; i >= 0; i -= 1) {
      if (previousPatterns.some((pattern) => pattern.test(lines[i]))) {
        start = i + 1;
        break;
      }
    }
  }

  if (nextPatterns?.length) {
    for (let i = labelIndex + 1; i < lines.length; i += 1) {
      if (nextPatterns.some((pattern) => pattern.test(lines[i]))) {
        end = i;
        break;
      }
    }
  }

  const before = [];
  const after = [];

  for (let i = start; i < end; i += 1) {
    if (i === labelIndex) continue;
    const value = parseMetricLine(lines[i]);
    if (!Number.isFinite(value)) continue;
    const item = { value, distance: Math.abs(i - labelIndex) };
    if (i < labelIndex) before.push(item);
    else after.push(item);
  }

  before.sort((a, b) => a.distance - b.distance);
  after.sort((a, b) => a.distance - b.distance);

  if (preference === "after") {
    return after[0]?.value ?? before[0]?.value ?? NaN;
  }

  return before[0]?.value ?? after[0]?.value ?? NaN;
}

function collectNumbers(value, output = []) {
  if (typeof value === "number" && Number.isFinite(value)) {
    output.push(value);
    return output;
  }

  if (typeof value === "string") {
    const parsed = parseNumberToken(value);
    if (Number.isFinite(parsed)) output.push(parsed);
    return output;
  }

  if (Array.isArray(value)) {
    for (const item of value) collectNumbers(item, output);
    return output;
  }

  if (value && typeof value === "object") {
    if (Object.prototype.hasOwnProperty.call(value, "value")) {
      collectNumbers(value.value, output);
    } else {
      for (const child of Object.values(value)) collectNumbers(child, output);
    }
  }

  return output;
}

function findMetricInScripts(doc, keyMatchers) {
  const scripts = Array.from(doc.scripts || []);
  const candidates = [];

  for (const script of scripts) {
    const text = script.textContent || "";
    if (!text || text.length > 4_000_000) continue;

    // Tenta JSON puro primeiro.
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        walkForMetric(parsed, keyMatchers, candidates);
      } catch {
        // Scripts normais não são JSON e são tratados pelo regex abaixo.
      }
    }

    const pairRegex = /["']?([A-Za-z0-9_-]+)["']?\s*[:=]\s*["']?(\d[\d.,]*\s*[KMB]?)/gi;
    let match;

    while ((match = pairRegex.exec(text))) {
      const key = normalizeKey(match[1]);
      if (!keyMatchers.some((matcher) => matcher.test(key))) continue;

      const value = parseNumberToken(match[2]);
      if (Number.isFinite(value)) candidates.push(value);
    }
  }

  return candidates.length ? Math.max(...candidates) : NaN;
}

function walkForMetric(value, keyMatchers, output) {
  if (!value || typeof value !== "object") return;

  if (Array.isArray(value)) {
    for (const item of value) walkForMetric(item, keyMatchers, output);
    return;
  }

  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (keyMatchers.some((matcher) => matcher.test(normalized))) {
      collectNumbers(child, output);
    }
    walkForMetric(child, keyMatchers, output);
  }
}

function cleanTitle(rawTitle, code) {
  let title = normalizeText(rawTitle);
  if (!title) return "";

  title = title
    .replace(new RegExp(`\\s+${code.replace(/-/g, "\\-")}\\b.*$`, "i"), "")
    .replace(/\s+by\s+.+$/i, "")
    .replace(/\s+-\s+Fortnite.*$/i, "")
    .trim();

  return title;
}

function parseAllTimeTiming(lines) {
  const labelPatterns = [
    /\ball[- ]time peak\b/i,
    /\bpico histórico\b/i,
    /\bpico de todos os tempos\b/i
  ];

  const index = findLabelLineIndex(lines, labelPatterns);
  if (index < 0) return { occurredAt: null, ageHours: null, dateLabel: "" };

  // The chart below the cards can contain unrelated tooltip ages. Keep the
  // timing search attached to the all-time label itself (and, at most, its
  // immediately following line) so values such as "2 hours ago" from a graph
  // are never mistaken for the all-time record age.
  const context = lines.slice(index, Math.min(lines.length, index + 2)).join(" ");

  const relativeHours = context.match(/(?:há\s*)?(\d+(?:[.,]\d+)?)\s*(?:horas?|hours?)\s*(?:atrás|ago)?/i);
  if (relativeHours) {
    const value = Number(relativeHours[1].replace(",", "."));
    if (Number.isFinite(value)) {
      return { occurredAt: Date.now() - value * 3600_000, ageHours: value, dateLabel: "" };
    }
  }

  const relativeMinutes = context.match(/(?:há\s*)?(\d+(?:[.,]\d+)?)\s*(?:minutos?|minutes?)\s*(?:atrás|ago)?/i);
  if (relativeMinutes) {
    const value = Number(relativeMinutes[1].replace(",", "."));
    if (Number.isFinite(value)) {
      return { occurredAt: Date.now() - value * 60_000, ageHours: value / 60, dateLabel: "" };
    }
  }

  const relativeDays = context.match(/(?:há\s*)?(\d+(?:[.,]\d+)?)\s*(?:dias?|days?)\s*(?:atrás|ago)?/i);
  if (relativeDays) {
    const value = Number(relativeDays[1].replace(",", "."));
    if (Number.isFinite(value)) {
      return { occurredAt: Date.now() - value * 86_400_000, ageHours: value * 24, dateLabel: "" };
    }
  }

  const relativeYears = context.match(/(?:há\s*)?(\d+(?:[.,]\d+)?)\s*(?:anos?|years?)\s*(?:atrás|ago)?/i);
  if (relativeYears) {
    const value = Number(relativeYears[1].replace(",", "."));
    if (Number.isFinite(value)) {
      return { occurredAt: Date.now() - value * 365.2425 * 86_400_000, ageHours: value * 365.2425 * 24, dateLabel: "" };
    }
  }

  // The exact date may appear a few text nodes below the label.
  // Search a slightly wider card area, while keeping relative-time parsing
  // restricted above so chart tooltip ages cannot be mistaken for the record.
  const dateContext = lines
    .slice(index, Math.min(lines.length, index + 7))
    .join(" ");

  const dateMatch = dateContext.match(
    /\b(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+\d{1,2},\s+\d{4}\b/i
  );

  if (dateMatch) {
    // Fortnite.GG sometimes exposes only the date, without an exact time.
    // Show the date instead of inventing a misleading hour.
    return { occurredAt: null, ageHours: null, dateLabel: dateMatch[0] };
  }

  return { occurredAt: null, ageHours: null, dateLabel: "" };
}

function parseIslandDocument(html, code) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const lines = getVisibleTextLines(doc);

  const titleSource =
    doc.querySelector("h1")?.textContent ||
    doc.querySelector('meta[property="og:title"]')?.getAttribute("content") ||
    doc.title ||
    "";

  const name = cleanTitle(titleSource, code);

  const thumbnailRaw =
    doc.querySelector('meta[property="og:image"]')?.getAttribute("content") ||
    doc.querySelector('meta[name="twitter:image"]')?.getAttribute("content") ||
    "";

  let thumbnail = "";
  if (thumbnailRaw) {
    try {
      thumbnail = new URL(thumbnailRaw, "https://fortnite.gg").href;
    } catch {
      thumbnail = "";
    }
  }

  const currentPatterns = [
    /\bplayers right now\b/i,
    /\bjogadores agora\b/i,
    /\bjogadores neste momento\b/i
  ];
  const peak24Patterns = [
    /\b24[- ]hour peak\b/i,
    /\bpico (?:de|nas últimas) 24 horas\b/i,
    /\bpico em 24 horas\b/i
  ];
  const allTimePatterns = [
    /\ball[- ]time peak\b/i,
    /\bpico histórico\b/i,
    /\bpico de todos os tempos\b/i
  ];

  // Cada métrica é procurada somente dentro da sua própria região.
  // O Fortnite.GG pode colocar o valor antes ou depois do rótulo.
  // Para o pico de 24h, o layout atual coloca o valor depois do rótulo,
  // enquanto "Players right now" e "All-time peak" costumam usar o valor antes.
  let current = findMetricBetweenLabels(
    lines,
    currentPatterns,
    [],
    peak24Patterns,
    "before"
  );

  let peak24 = findMetricBetweenLabels(
    lines,
    peak24Patterns,
    currentPatterns,
    allTimePatterns,
    "after"
  );

  let allTime = findMetricBetweenLabels(
    lines,
    allTimePatterns,
    peak24Patterns,
    [],
    "before"
  );

  // Fallbacks para dados embutidos em scripts/JSON da página.
  if (!Number.isFinite(current)) {
    current = findMetricInScripts(doc, [
      /^(?:playersrightnow|currentplayers|currentccu|playercount)$/i
    ]);
  }

  if (!Number.isFinite(peak24)) {
    peak24 = findMetricInScripts(doc, [
      /^(?:peak24h|24hourpeak|twentyfourhourpeak|dailypeak|peakccu24h)$/i
    ]);
  }

  if (!Number.isFinite(allTime)) {
    allTime = findMetricInScripts(doc, [
      /^(?:alltimepeak|historicalpeak|maxccu|alltimeccu)$/i
    ]);
  }

  const timing = parseAllTimeTiming(lines);

  return {
    name,
    thumbnail,
    stats: {
      current,
      peak24,
      allTime
    },
    allTimeOccurredAt: timing.occurredAt,
    allTimeAgeHours: timing.ageHours,
    allTimeDateLabel: timing.dateLabel || "",
    debug: {
      lineCount: lines.length,
      foundCurrentLabel: findLabelLineIndex(lines, currentPatterns) >= 0,
      foundPeak24Label: findLabelLineIndex(lines, peak24Patterns) >= 0,
      foundAllTimeLabel: findLabelLineIndex(lines, allTimePatterns) >= 0
    }
  };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "offscreen" || message.type !== "PARSE_ISLAND_HTML") {
    return undefined;
  }

  try {
    const data = parseIslandDocument(message.html, message.code);
    sendResponse({ ok: true, data });
  } catch (error) {
    sendResponse({
      ok: false,
      error: error?.message || "Failed to parse the page HTML."
    });
  }

  return false;
});
