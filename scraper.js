const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const BASE_URL = "http://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx";

const FILES = {
  input: path.join(__dirname, "college_branch_start_regno_2023_updated.txt"),
  state: path.join(__dirname, "state.json"),
  seen: path.join(__dirname, "seen.txt"),
  output: path.join(__dirname, "result_regnos.txt"),
  log: path.join(__dirname, "run.log"),
};

const SETTINGS = {
  sem: "II",
  requestTimeoutMs: 60000,
  politeDelayMs: 1200,
  maxRetries: 3,
  initialRetryDelayMs: 1500,
  startRoll: 1,
  maxRuntimeMs: 5 * 60 * 60 * 1000, // 5 hours
  extensionMissBreak: 5,
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n", "utf8");
}

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(v) {
  return String(v || "").trim();
}

function parseNumber(v) {
  const cleaned = String(v || "").replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function buildResultUrl(regNo) {
  return `${BASE_URL}?Sem=${SETTINGS.sem}&RegNo=${regNo}`;
}

function isBackPaper(grade, ese) {
  const g = normalizeText(grade).toUpperCase();
  const e = normalizeText(ese).toUpperCase();
  return g === "F" || g === "I" || g === "X" || e === "AB";
}

function loadState() {
  ensureFile(
    FILES.state,
    JSON.stringify({ lineIndex: 0, rollIndex: 1, updatedAt: new Date().toISOString() }, null, 2)
  );

  try {
    return JSON.parse(fs.readFileSync(FILES.state, "utf8"));
  } catch {
    return { lineIndex: 0, rollIndex: 1 };
  }
}

function saveState(lineIndex, rollIndex) {
  fs.writeFileSync(
    FILES.state,
    JSON.stringify({ lineIndex, rollIndex, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function loadSeenSet() {
  ensureFile(FILES.seen, "");
  const content = fs.readFileSync(FILES.seen, "utf8");
  return new Set(content.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
}

function appendSeen(regNo) {
  fs.appendFileSync(FILES.seen, regNo + "\n", "utf8");
}

async function fetchWithRetries(url, maxRetries = SETTINGS.maxRetries, initialDelay = SETTINGS.initialRetryDelayMs) {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: SETTINGS.requestTimeoutMs,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Connection": "keep-alive",
        },
        validateStatus: status => status >= 200 && status < 400,
      });

      if (
        response.status === 200 &&
        typeof response.data === "string" &&
        !response.data.includes("No Record Found !!!")
      ) {
        return { ok: true, html: response.data, kind: "FOUND" };
      }

      return { ok: true, html: null, kind: "NO_RECORD" };
    } catch (error) {
      if (attempt === maxRetries) {
        return { ok: false, html: null, kind: "ERROR", error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { ok: false, html: null, kind: "ERROR", error: "Unknown fetch error" };
}

function extractCurCgpa($) {
  let curCgpa = null;

  $("#ContentPlaceHolder1_GridView3 tr:nth-child(2) td").each((index, cell) => {
    if (index === 8) {
      const val = normalizeText($(cell).text());
      if (val && val !== "NA") {
        curCgpa = parseNumber(val);
      }
    }
  });

  return curCgpa;
}

function hasBackOnlyNotYearBack(html) {
  if (!html || typeof html !== "string") return false;

  const $ = cheerio.load(html);

  const curCgpa = extractCurCgpa($);
  if (curCgpa === null || curCgpa < 5.0) {
    return false;
  }

  let hasBack = false;

  $("#ContentPlaceHolder1_GridView1 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      const ese = normalizeText($(cells[2]).text());
      const grade = normalizeText($(cells[5]).text());
      if (isBackPaper(grade, ese)) {
        hasBack = true;
      }
    }
  });

  $("#ContentPlaceHolder1_GridView2 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      const ese = normalizeText($(cells[2]).text());
      const grade = normalizeText($(cells[5]).text());
      if (isBackPaper(grade, ese)) {
        hasBack = true;
      }
    }
  });

  return hasBack;
}

function loadBranchRows() {
  if (!fs.existsSync(FILES.input)) {
    throw new Error(`Missing input file: ${FILES.input}`);
  }

  const rawLines = fs.readFileSync(FILES.input, "utf8").split(/\r?\n/);

  return rawLines
    .map(line => line.trim())
    .filter(line => /^\d{11}\s*\|/.test(line))
    .map(line => {
      const parts = line.split("|").map(s => s.trim());
      return {
        startRegNo: parts[0],
        collegeCode: parts[1],
        collegeName: parts[2],
        branchCode: parts[3],
        branchName: parts[4],
      };
    });
}

function getZoneType(r) {
  if (r >= 1 && r <= 60) return "G60";
  if (r >= 61 && r <= 75) return "E75";
  if (r >= 76 && r <= 120) return "G120";
  if (r >= 121 && r <= 135) return "E135";
  return "OUT";
}

async function runMassiveScrape() {
  ensureFile(FILES.output, "");
  ensureFile(FILES.log, "");
  ensureFile(FILES.seen, "");

  const seen = loadSeenSet();
  const rows = loadBranchRows();
  const state = loadState();
  const startedAt = Date.now();
  let processedCount = 0;

  log(`Loaded ${rows.length} college-branch rows`);
  log(`Resuming from lineIndex=${state.lineIndex}, rollIndex=${state.rollIndex}`);

  for (let i = state.lineIndex; i < rows.length; i++) {
    const row = rows[i];
    const regBase = row.startRegNo.slice(0, -3);
    const startRoll = i === state.lineIndex ? state.rollIndex : SETTINGS.startRoll;

    log(`START branch ${i + 1}/${rows.length} :: ${row.collegeName} :: ${row.branchName} :: scan=1-135`);

    let extensionMisses = 0;

    for (let r = startRoll; r <= 135; r++) {
      if (Date.now() - startedAt > SETTINGS.maxRuntimeMs) {
        log(`STOP max runtime reached`);
        saveState(i, r);
        return;
      }

      const zone = getZoneType(r);
      const currentRegNo = `${regBase}${String(r).padStart(3, "0")}`;
      const url = buildResultUrl(currentRegNo);
      const result = await fetchWithRetries(url);

      let studentStatus = "MISS";

      if (!result.html) {
        if (result.kind === "ERROR") {
          studentStatus = "ERR";
        } else {
          studentStatus = "MISS";
        }

        if (zone === "E75" || zone === "E135") {
          extensionMisses++;

          if (extensionMisses >= SETTINGS.extensionMissBreak) {
            processedCount++;
            log(`[${processedCount}] ${row.collegeCode}-${row.branchCode} ${currentRegNo} -> ${studentStatus} -> ${url} -> BREAK`);
            saveState(i + 1, SETTINGS.startRoll);
            break;
          }
        }
      } else {
        extensionMisses = 0;

        const matched = hasBackOnlyNotYearBack(result.html);

        if (matched) {
          if (!seen.has(currentRegNo)) {
            fs.appendFileSync(FILES.output, currentRegNo + "\n", "utf8");
            appendSeen(currentRegNo);
            seen.add(currentRegNo);
            studentStatus = "SAVE";
          } else {
            studentStatus = "DUP";
          }
        } else {
          studentStatus = "IGNORE";
        }
      }

      processedCount++;
      log(`[${processedCount}] ${row.collegeCode}-${row.branchCode} ${currentRegNo} -> ${studentStatus} -> ${url}`);

      saveState(i, r + 1);
      await sleep(SETTINGS.politeDelayMs);
    }

    saveState(i + 1, SETTINGS.startRoll);
    log(`DONE branch :: ${row.collegeName} :: ${row.branchName}`);
  }

  log(`COMPLETE all rows finished`);
}

runMassiveScrape().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const BASE_URL = "http://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx";

const FILES = {
  input: path.join(__dirname, "college_branch_start_regno_2023_updated.txt"),
  state: path.join(__dirname, "state.json"),
  seen: path.join(__dirname, "seen.txt"),
  output: path.join(__dirname, "result_regnos.txt"),
  log: path.join(__dirname, "run.log"),
};

const SETTINGS = {
  sem: "II",
  requestTimeoutMs: 60000,
  politeDelayMs: 1200,
  maxRetries: 3,
  initialRetryDelayMs: 1500,
  startRoll: 1,
  maxRuntimeMs: 5 * 60 * 60 * 1000, // 5 hours
  extensionMissBreak: 5,
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n", "utf8");
}

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function normalizeText(v) {
  return String(v || "").trim();
}

function parseNumber(v) {
  const cleaned = String(v || "").replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function buildResultUrl(regNo) {
  return `${BASE_URL}?Sem=${SETTINGS.sem}&RegNo=${regNo}`;
}

function isBackPaper(grade, ese) {
  const g = normalizeText(grade).toUpperCase();
  const e = normalizeText(ese).toUpperCase();
  return g === "F" || g === "I" || g === "X" || e === "AB";
}

function loadState() {
  ensureFile(
    FILES.state,
    JSON.stringify({ lineIndex: 0, rollIndex: 1, updatedAt: new Date().toISOString() }, null, 2)
  );

  try {
    return JSON.parse(fs.readFileSync(FILES.state, "utf8"));
  } catch {
    return { lineIndex: 0, rollIndex: 1 };
  }
}

function saveState(lineIndex, rollIndex) {
  fs.writeFileSync(
    FILES.state,
    JSON.stringify({ lineIndex, rollIndex, updatedAt: new Date().toISOString() }, null, 2),
    "utf8"
  );
}

function loadSeenSet() {
  ensureFile(FILES.seen, "");
  const content = fs.readFileSync(FILES.seen, "utf8");
  return new Set(content.split(/\r?\n/).map(x => x.trim()).filter(Boolean));
}

function appendSeen(regNo) {
  fs.appendFileSync(FILES.seen, regNo + "\n", "utf8");
}

async function fetchWithRetries(url, maxRetries = SETTINGS.maxRetries, initialDelay = SETTINGS.initialRetryDelayMs) {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: SETTINGS.requestTimeoutMs,
        maxRedirects: 5,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Connection": "keep-alive",
        },
        validateStatus: status => status >= 200 && status < 400,
      });

      if (
        response.status === 200 &&
        typeof response.data === "string" &&
        !response.data.includes("No Record Found !!!")
      ) {
        return { ok: true, html: response.data, kind: "FOUND" };
      }

      return { ok: true, html: null, kind: "NO_RECORD" };
    } catch (error) {
      if (attempt === maxRetries) {
        return { ok: false, html: null, kind: "ERROR", error: error.message };
      }
      await sleep(delay);
      delay *= 2;
    }
  }

  return { ok: false, html: null, kind: "ERROR", error: "Unknown fetch error" };
}

function extractCurCgpa($) {
  let curCgpa = null;

  $("#ContentPlaceHolder1_GridView3 tr:nth-child(2) td").each((index, cell) => {
    if (index === 8) {
      const val = normalizeText($(cell).text());
      if (val && val !== "NA") {
        curCgpa = parseNumber(val);
      }
    }
  });

  return curCgpa;
}

function hasBackOnlyNotYearBack(html) {
  if (!html || typeof html !== "string") return false;

  const $ = cheerio.load(html);

  const curCgpa = extractCurCgpa($);
  if (curCgpa === null || curCgpa < 5.0) {
    return false;
  }

  let hasBack = false;

  $("#ContentPlaceHolder1_GridView1 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      const ese = normalizeText($(cells[2]).text());
      const grade = normalizeText($(cells[5]).text());
      if (isBackPaper(grade, ese)) {
        hasBack = true;
      }
    }
  });

  $("#ContentPlaceHolder1_GridView2 tr").slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      const ese = normalizeText($(cells[2]).text());
      const grade = normalizeText($(cells[5]).text());
      if (isBackPaper(grade, ese)) {
        hasBack = true;
      }
    }
  });

  return hasBack;
}

function loadBranchRows() {
  if (!fs.existsSync(FILES.input)) {
    throw new Error(`Missing input file: ${FILES.input}`);
  }

  const rawLines = fs.readFileSync(FILES.input, "utf8").split(/\r?\n/);

  return rawLines
    .map(line => line.trim())
    .filter(line => /^\d{11}\s*\|/.test(line))
    .map(line => {
      const parts = line.split("|").map(s => s.trim());
      return {
        startRegNo: parts[0],
        collegeCode: parts[1],
        collegeName: parts[2],
        branchCode: parts[3],
        branchName: parts[4],
      };
    });
}

function getZoneType(r) {
  if (r >= 1 && r <= 60) return "G60";
  if (r >= 61 && r <= 75) return "E75";
  if (r >= 76 && r <= 120) return "G120";
  if (r >= 121 && r <= 135) return "E135";
  return "OUT";
}

async function runMassiveScrape() {
  ensureFile(FILES.output, "");
  ensureFile(FILES.log, "");
  ensureFile(FILES.seen, "");

  const seen = loadSeenSet();
  const rows = loadBranchRows();
  const state = loadState();
  const startedAt = Date.now();
  let processedCount = 0;

  log(`Loaded ${rows.length} college-branch rows`);
  log(`Resuming from lineIndex=${state.lineIndex}, rollIndex=${state.rollIndex}`);

  for (let i = state.lineIndex; i < rows.length; i++) {
    const row = rows[i];
    const regBase = row.startRegNo.slice(0, -3);
    const startRoll = i === state.lineIndex ? state.rollIndex : SETTINGS.startRoll;

    log(`START branch ${i + 1}/${rows.length} :: ${row.collegeName} :: ${row.branchName} :: scan=1-135`);

    let extensionMisses = 0;

    for (let r = startRoll; r <= 135; r++) {
      if (Date.now() - startedAt > SETTINGS.maxRuntimeMs) {
        log(`STOP max runtime reached`);
        saveState(i, r);
        return;
      }

      const zone = getZoneType(r);
      const currentRegNo = `${regBase}${String(r).padStart(3, "0")}`;
      const url = buildResultUrl(currentRegNo);
      const result = await fetchWithRetries(url);

      let studentStatus = "MISS";

      if (!result.html) {
        if (result.kind === "ERROR") {
          studentStatus = "ERR";
        } else {
          studentStatus = "MISS";
        }

        if (zone === "E75" || zone === "E135") {
          extensionMisses++;

          if (extensionMisses >= SETTINGS.extensionMissBreak) {
            processedCount++;
            log(`[${processedCount}] ${row.collegeCode}-${row.branchCode} ${currentRegNo} -> ${studentStatus} -> ${url} -> BREAK`);
            saveState(i + 1, SETTINGS.startRoll);
            break;
          }
        }
      } else {
        extensionMisses = 0;

        const matched = hasBackOnlyNotYearBack(result.html);

        if (matched) {
          if (!seen.has(currentRegNo)) {
            fs.appendFileSync(FILES.output, currentRegNo + "\n", "utf8");
            appendSeen(currentRegNo);
            seen.add(currentRegNo);
            studentStatus = "SAVE";
          } else {
            studentStatus = "DUP";
          }
        } else {
          studentStatus = "IGNORE";
        }
      }

      processedCount++;
      log(`[${processedCount}] ${row.collegeCode}-${row.branchCode} ${currentRegNo} -> ${studentStatus} -> ${url}`);

      saveState(i, r + 1);
      await sleep(SETTINGS.politeDelayMs);
    }

    saveState(i + 1, SETTINGS.startRoll);
    log(`DONE branch :: ${row.collegeName} :: ${row.branchName}`);
  }

  log(`COMPLETE all rows finished`);
}

runMassiveScrape().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
