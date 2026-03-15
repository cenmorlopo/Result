const axios = require("axios");
const cheerio = require("cheerio");
const fs = require("fs");
const path = require("path");

const BASE_URL = "https://results.beup.ac.in/ResultsBTech2ndSem2024_B2023Pub.aspx";

const FILES = {
  input: path.join(__dirname, "college_branch_start_regno_2023_updated.txt"),
  state: path.join(__dirname, "state.json"),
  seen: path.join(__dirname, "seen.txt"),
  output: path.join(__dirname, "back_students.txt"),
  log: path.join(__dirname, "run.log"),
};

const SETTINGS = {
  sem: "II",
  requestTimeoutMs: 20000,
  politeDelayMs: 900,
  maxRetries: 3,
  initialRetryDelayMs: 1200,

  // Scan design
  startRoll: 1,
  softCheckpoint60: 65,
  hardUpperLimit: 135,
  stopAfterMissesPast60: 5,
  stopAfterMissesAnytime: 8,

  // GitHub runner safety
  maxRuntimeMs: 5 * 60 * 60 * 1000, // 5 hours
};

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  fs.appendFileSync(FILES.log, line + "\n");
}

function ensureFile(filePath, defaultContent = "") {
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, defaultContent, "utf8");
  }
}

function loadState() {
  ensureFile(FILES.state, JSON.stringify({ lineIndex: 0, rollIndex: 1 }, null, 2));
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

function normalizeText(v) {
  return String(v || "").trim();
}

function parseNumber(v) {
  const cleaned = String(v || "").replace(/[^\d.]/g, "");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

function isBackPaper(grade, ese) {
  const g = normalizeText(grade).toUpperCase();
  const e = normalizeText(ese).toUpperCase();
  return g === "F" || g === "I" || g === "X" || e === "AB";
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchWithRetries(url, maxRetries = SETTINGS.maxRetries, initialDelay = SETTINGS.initialRetryDelayMs) {
  let delay = initialDelay;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const response = await axios.get(url, {
        timeout: SETTINGS.requestTimeoutMs,
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Connection": "keep-alive",
        },
        maxRedirects: 5,
        validateStatus: status => status >= 200 && status < 400,
      });

      if (
        response.status === 200 &&
        typeof response.data === "string" &&
        !response.data.includes("No Record Found !!!")
      ) {
        return response.data;
      }

      return null;
    } catch (error) {
      if (attempt === maxRetries) {
        log(`ERROR fetch failed after ${maxRetries} attempts: ${url} :: ${error.message}`);
        return null;
      }

      log(`WARN fetch retry ${attempt}/${maxRetries} for ${url} :: ${error.message}`);
      await sleep(delay);
      delay *= 2;
    }
  }

  return null;
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

function extractStudentName($) {
  return normalizeText($("#ContentPlaceHolder1_DataList1_StudentNameLabel_0").text()) || "Unknown";
}

function collectBackSubjects($, gridSelector, practical = false) {
  const subjects = [];

  $(`${gridSelector} tr`).slice(1).each((_, el) => {
    const cells = $(el).find("td");
    if (cells.length >= 7) {
      const subjectCode = normalizeText($(cells[0]).text());
      const subjectName = normalizeText($(cells[1]).text());
      const ese = normalizeText($(cells[2]).text());
      const ia = normalizeText($(cells[3]).text());
      const total = normalizeText($(cells[4]).text());
      const grade = normalizeText($(cells[5]).text());
      const credit = normalizeText($(cells[6]).text());

      if (isBackPaper(grade, ese)) {
        subjects.push({
          subject_code: subjectCode,
          subject_name: practical ? `${subjectName} (Practical)` : subjectName,
          ese,
          ia,
          total,
          grade,
          credit,
          type: practical ? "practical" : "theory",
        });
      }
    }
  });

  return subjects;
}

function parseAndFilterData(html, regNo, collegeCode, collegeName, branchCode, branchName) {
  if (!html || typeof html !== "string") return null;

  const $ = cheerio.load(html);

  const curCgpa = extractCurCgpa($);
  if (curCgpa === null || curCgpa < 5.0) {
    return null;
  }

  const theoryBacks = collectBackSubjects($, "#ContentPlaceHolder1_GridView1", false);
  const practicalBacks = collectBackSubjects($, "#ContentPlaceHolder1_GridView2", true);
  const allBacks = [...theoryBacks, ...practicalBacks];

  if (allBacks.length === 0) {
    return null;
  }

  const studentName = extractStudentName($);
  const sgpa = normalizeText($("#ContentPlaceHolder1_DataList5_GROSSTHEORYTOTALLabel_0").text()) || "N/A";
  const publishDate = normalizeText(
    $("#ContentPlaceHolder1_DataList3 tr:nth-of-type(2) td").text().split(":").pop()
  ) || "N/A";

  const backNames = allBacks.map(s => s.subject_name);
  const backCodes = allBacks.map(s => s.subject_code);

  const lines = [];
  lines.push(`Reg No: ${regNo}`);
  lines.push(`Name: ${studentName}`);
  lines.push(`College Code: ${collegeCode}`);
  lines.push(`College: ${collegeName}`);
  lines.push(`Branch Code: ${branchCode}`);
  lines.push(`Branch: ${branchName}`);
  lines.push(`Cur. CGPA: ${curCgpa}`);
  lines.push(`SGPA: ${sgpa}`);
  lines.push(`Publish Date: ${publishDate}`);
  lines.push(`Backpaper Count: ${allBacks.length}`);
  lines.push(`Backpaper Codes: ${backCodes.join(", ")}`);
  lines.push(`Backpapers: ${backNames.join(", ")}`);
  lines.push("--------------------------------------------------");

  return lines.join("\n") + "\n";
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

async function runMassiveScrape() {
  ensureFile(FILES.output, "");
  ensureFile(FILES.log, "");
  ensureFile(FILES.seen, "");

  const seen = loadSeenSet();
  const rows = loadBranchRows();
  const state = loadState();

  log(`Loaded ${rows.length} college-branch rows`);
  log(`Resuming from lineIndex=${state.lineIndex}, rollIndex=${state.rollIndex}`);

  const startedAt = Date.now();

  for (let i = state.lineIndex; i < rows.length; i++) {
    const row = rows[i];
    const regBase = row.startRegNo.slice(0, -3);

    log(`START branch ${i + 1}/${rows.length} :: ${row.collegeName} :: ${row.branchName}`);

    let consecutiveMisses = 0;
    const startRoll = i === state.lineIndex ? state.rollIndex : SETTINGS.startRoll;

    for (let r = startRoll; r <= SETTINGS.hardUpperLimit; r++) {
      if (Date.now() - startedAt > SETTINGS.maxRuntimeMs) {
        log("STOP max runtime reached, saving state and exiting");
        saveState(i, r);
        return;
      }

      const currentRegNo = `${regBase}${String(r).padStart(3, "0")}`;
      const url = `${BASE_URL}?Sem=${SETTINGS.sem}&RegNo=${currentRegNo}`;

      const html = await fetchWithRetries(url);

      if (!html) {
        consecutiveMisses++;
        log(`MISS ${currentRegNo} (miss=${consecutiveMisses})`);

        if (r >= SETTINGS.softCheckpoint60 && consecutiveMisses >= SETTINGS.stopAfterMissesPast60) {
          log(`BREAK likely end of ${row.branchName} around 60-seat boundary`);
          break;
        }

        if (consecutiveMisses >= SETTINGS.stopAfterMissesAnytime) {
          log(`BREAK likely end of branch after repeated misses`);
          break;
        }
      } else {
        consecutiveMisses = 0;

        const studentText = parseAndFilterData(
          html,
          currentRegNo,
          row.collegeCode,
          row.collegeName,
          row.branchCode,
          row.branchName
        );

        if (studentText) {
          if (!seen.has(currentRegNo)) {
            fs.appendFileSync(FILES.output, studentText, "utf8");
            appendSeen(currentRegNo);
            seen.add(currentRegNo);
            log(`SAVE ${currentRegNo}`);
          } else {
            log(`SKIP duplicate ${currentRegNo}`);
          }
        } else {
          log(`IGNORE ${currentRegNo} (pass student / CGPA<5 / no back)`);
        }
      }

      saveState(i, r + 1);
      await sleep(SETTINGS.politeDelayMs);
    }

    saveState(i + 1, SETTINGS.startRoll);
    log(`DONE branch :: ${row.collegeName} :: ${row.branchName}`);
  }

  log("COMPLETE all rows finished");
}

runMassiveScrape().catch(err => {
  log(`FATAL ${err.stack || err.message}`);
  process.exit(1);
});
