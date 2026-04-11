import { load } from "cheerio";
import { initDb } from "../src/lib/db";

const AUTH_URL =
  "https://asen-jhu.evaluationkit.com/Login/ReportPublic?id=THo7RYxiDOgppCUb8vkY%2bPMVFDNyK2ADK0u537x%2fnZsNvzOBJJZTTNEcJihG8hqZ";
const BASE = "https://asen-jhu.evaluationkit.com/";

const QUESTION_MAP: Record<string, string> = {
  "The overall quality of this course is:": "overall_quality",
  "The instructor's teaching effectiveness is:": "instructor_effectiveness",
  "The intellectual challenge of this course is:": "intellectual_challenge",
  "Compared to other Hopkins courses at this level, the workload for this course is:":
    "workload",
  "Feedback on my work for this course is useful:": "feedback_usefulness",
};

const DISCOVER_CONCURRENCY = 15;
const SCRAPE_CONCURRENCY = 20;

// ── Cookie-aware fetch with retry ───────────────────────────────────
let cookies: string[] = [];

function mergeCookies(headers: string[]) {
  for (const h of headers) {
    const c = h.split(";")[0];
    const n = c.split("=")[0];
    cookies = cookies.filter((x) => !x.startsWith(n + "="));
    cookies.push(c);
  }
}

async function fetchC(url: string, retries = 3): Promise<string> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      let u = url;
      for (let i = 0; i < 10; i++) {
        const res = await fetch(u, {
          redirect: "manual",
          headers: { Cookie: cookies.join("; "), "User-Agent": "Mozilla/5.0" },
        });
        const sc = res.headers.getSetCookie?.() ?? [];
        if (sc.length > 0) mergeCookies(sc);
        if (res.status >= 300 && res.status < 400) {
          const loc = res.headers.get("location");
          if (!loc) throw new Error("Redirect without location");
          u = loc.startsWith("http") ? loc : new URL(loc, u).toString();
          continue;
        }
        if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
        return await res.text();
      }
      throw new Error("Too many redirects");
    } catch (err) {
      if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 300 * (attempt + 1)));
      else throw err;
    }
  }
  throw new Error("Unreachable");
}

// ── Helpers ─────────────────────────────────────────────────────────
function computeWeightedAvg(freq: Record<string, number>): string {
  const entries = Object.entries(freq).filter(([l]) => l !== "N/A" && l !== "n/a");
  if (entries.length === 0) return "N/A";
  let total = 0, sum = 0;
  for (let i = 0; i < entries.length; i++) {
    total += entries[i][1];
    sum += entries[i][1] * (i + 1);
  }
  return total === 0 ? "N/A" : (sum / total).toFixed(2);
}

function countRespondents(freq: Record<string, number>): number {
  return Object.entries(freq)
    .filter(([l]) => l !== "N/A" && l !== "n/a")
    .reduce((s, [, c]) => s + c, 0);
}

// ── Phase 1: Discover all report links + metadata from search page ──
interface ReportLink {
  instanceKey: string;
  url: string;
  courseCode: string;
  courseName: string;
  instructor: string;
  responded: number;   // number who responded
  enrolled: number;    // total enrolled
  termLabel: string;   // e.g. "2017 Summer II"
}

async function discoverLinks(courseCode: string): Promise<ReportLink[]> {
  const html = await fetchC(
    `${BASE}Report/Public/Results?Course=${encodeURIComponent(courseCode)}`
  );
  const $ = load(html);
  const links: ReportLink[] = [];

  // Each result is in a .row containing the report link
  $("a.sr-view-report").each((_, el) => {
    const $el = $(el);
    const id0 = $el.attr("data-id0"),
      id1 = $el.attr("data-id1"),
      id2 = $el.attr("data-id2"),
      id3 = $el.attr("data-id3");
    if (!id0 || !id1 || !id2 || !id3) return;

    const $row = $el.closest(".row");

    // Instance key: "EN.601.226.01.FA17"
    const instanceKey = $row.find(".sr-dataitem-info-code").text().trim();
    if (!instanceKey) return;

    // Course name from h2
    const courseName = $row.find("h2").text().trim();

    // Instructor from .sr-dataitem-info-instr
    const instructor = $row.find(".sr-dataitem-info-instr").text().trim();

    // Response count: "13 of 21 responded (61.90%)"
    let responded = 0, enrolled = 0;
    const respText = $row.find(".sr-avg span").text().trim();
    const respMatch = respText.match(/(\d+)\s+of\s+(\d+)/);
    if (respMatch) {
      responded = parseInt(respMatch[1]);
      enrolled = parseInt(respMatch[2]);
    }

    // Term label from the small text
    const termLabel = $row.find(".sr-dataitem-info .small").first().text().trim().split("\n")[0].trim();

    links.push({
      instanceKey,
      url: `${BASE}Reports/StudentReport.aspx?id=${id0},${id1},${id2},${id3}`,
      courseCode,
      courseName,
      instructor,
      responded,
      enrolled,
      termLabel,
    });
  });

  return links;
}

// ── Phase 2: Scrape ratings from report pages ───────────────────────
interface EvalRow {
  courseCode: string;
  instanceKey: string;
  courseName: string;
  instructor: string;
  term: string;
  termLabel: string;
  overallQuality: string;
  instructorEffectiveness: string;
  intellectualChallenge: string;
  workload: string;
  feedbackUsefulness: string;
  numRespondents: number;
  numEnrolled: number;
}

function parseReport(html: string, link: ReportLink): EvalRow | null {
  const $ = load(html);

  const hdnData = $("#hdnReportData").val();
  if (!hdnData || typeof hdnData !== "string") return null;

  let data: unknown;
  try { data = JSON.parse(hdnData); } catch { return null; }

  const freqs: Record<string, Record<string, number>> = {};

  if (Array.isArray(data)) {
    for (const item of data) {
      const qt = item.QuestionText || item.questionText || "";
      for (const [question, key] of Object.entries(QUESTION_MAP)) {
        if (qt.includes(question) || question.includes(qt)) {
          const opts = item.Options || item.options || [];
          const f: Record<string, number> = {};
          for (const o of opts) {
            const l = o.OptionText || o.optionText || o.Label || o.label || "";
            const c = o.Frequency || o.frequency || o.Count || o.count || 0;
            if (l) f[l] = Number(c);
          }
          freqs[key] = f;
          break;
        }
      }
    }
  }

  if (!freqs.overall_quality) return null;

  const parts = link.instanceKey.split(".");
  return {
    courseCode: link.courseCode,
    instanceKey: link.instanceKey,
    courseName: link.courseName,
    instructor: link.instructor,
    term: parts[parts.length - 1] || "",
    termLabel: link.termLabel,
    overallQuality: computeWeightedAvg(freqs.overall_quality),
    instructorEffectiveness: computeWeightedAvg(freqs.instructor_effectiveness || {}),
    intellectualChallenge: computeWeightedAvg(freqs.intellectual_challenge || {}),
    workload: computeWeightedAvg(freqs.workload || {}),
    feedbackUsefulness: computeWeightedAvg(freqs.feedback_usefulness || {}),
    numRespondents: link.responded || countRespondents(freqs.overall_quality),
    numEnrolled: link.enrolled,
  };
}

// ── Concurrency pool ────────────────────────────────────────────────
async function pool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const db = initDb();
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";

  // Recreate evaluations table with proper schema
  db.exec("DROP TABLE IF EXISTS evaluations");
  db.exec(`
    CREATE TABLE evaluations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_code TEXT NOT NULL,
      instance_key TEXT NOT NULL UNIQUE,
      course_name TEXT DEFAULT '',
      instructor TEXT DEFAULT '',
      term TEXT DEFAULT '',
      term_label TEXT DEFAULT '',
      overall_quality REAL,
      instructor_effectiveness REAL,
      intellectual_challenge REAL,
      workload REAL,
      feedback_usefulness REAL,
      num_respondents INTEGER DEFAULT 0,
      num_enrolled INTEGER DEFAULT 0
    );
    CREATE INDEX idx_eval_course ON evaluations(course_code);
    CREATE INDEX idx_eval_instructor ON evaluations(instructor);
  `);

  const codes = (
    db.prepare("SELECT DISTINCT offering_name FROM courses ORDER BY offering_name").all() as { offering_name: string }[]
  ).map((r) => r.offering_name);

  console.log(`\n=== Phase 1: Discovering reports for ${codes.length} courses (×${DISCOVER_CONCURRENCY}) ===\n`);
  await fetchC(AUTH_URL);
  console.log(`Session ready. [${elapsed()}]\n`);

  const allLinks: ReportLink[] = [];
  const noEvalCodes: string[] = [];
  let searched = 0;

  await pool(codes, DISCOVER_CONCURRENCY, async (code) => {
    try {
      const links = await discoverLinks(code);
      if (links.length > 0) allLinks.push(...links);
      else noEvalCodes.push(code);
    } catch {
      noEvalCodes.push(code);
    }
    searched++;
    if (searched % 200 === 0)
      console.log(`  ${searched}/${codes.length} searched — ${allLinks.length} reports [${elapsed()}]`);
  });

  console.log(`\n✓ Phase 1: ${allLinks.length} reports from ${codes.length - noEvalCodes.length} courses [${elapsed()}]\n`);

  // Phase 2: Scrape all reports
  console.log(`=== Phase 2: Scraping ${allLinks.length} reports (×${SCRAPE_CONCURRENCY}) ===\n`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO evaluations (
      course_code, instance_key, course_name, instructor, term, term_label,
      overall_quality, instructor_effectiveness, intellectual_challenge,
      workload, feedback_usefulness, num_respondents, num_enrolled
    ) VALUES (
      @courseCode, @instanceKey, @courseName, @instructor, @term, @termLabel,
      @overallQuality, @instructorEffectiveness, @intellectualChallenge,
      @workload, @feedbackUsefulness, @numRespondents, @numEnrolled
    )
  `);

  let scraped = 0, failed = 0;
  let buffer: EvalRow[] = [];
  const flush = db.transaction((rows: EvalRow[]) => { for (const r of rows) insert.run(r); });

  await pool(allLinks, SCRAPE_CONCURRENCY, async (link) => {
    try {
      const html = await fetchC(link.url);
      const row = parseReport(html, link);
      if (row) {
        buffer.push(row);
        scraped++;
        if (buffer.length >= 50) flush(buffer.splice(0));
      } else {
        failed++;
      }
    } catch {
      failed++;
    }
    if ((scraped + failed) % 200 === 0)
      console.log(`  ${scraped + failed}/${allLinks.length} (${scraped} ok, ${failed} fail) [${elapsed()}]`);
  });

  if (buffer.length > 0) flush(buffer.splice(0));
  console.log(`\n✓ Phase 2: ${scraped} scraped, ${failed} failed [${elapsed()}]\n`);

  // Phase 3: Aggregate into courses table
  console.log(`=== Phase 3: Aggregating into courses ===\n`);

  db.exec(`
    UPDATE courses SET overall_quality = NULL, instructor_effectiveness = NULL,
      intellectual_challenge = NULL, workload = NULL, feedback_usefulness = NULL,
      num_evaluations = 0, num_respondents = 0;

    UPDATE courses
    SET overall_quality = agg.avg_oq, instructor_effectiveness = agg.avg_ie,
        intellectual_challenge = agg.avg_ic, workload = agg.avg_wl,
        feedback_usefulness = agg.avg_fu, num_evaluations = agg.cnt,
        num_respondents = agg.total_resp
    FROM (
      SELECT course_code,
        ROUND(AVG(overall_quality), 2) as avg_oq,
        ROUND(AVG(instructor_effectiveness), 2) as avg_ie,
        ROUND(AVG(intellectual_challenge), 2) as avg_ic,
        ROUND(AVG(workload), 2) as avg_wl,
        ROUND(AVG(feedback_usefulness), 2) as avg_fu,
        COUNT(*) as cnt,
        SUM(num_respondents) as total_resp
      FROM evaluations
      WHERE overall_quality IS NOT NULL
      GROUP BY course_code
    ) agg WHERE courses.offering_name = agg.course_code
  `);

  const withEvals = (db.prepare("SELECT COUNT(DISTINCT offering_name) as c FROM courses WHERE overall_quality IS NOT NULL").get() as { c: number }).c;
  const totalRespondents = (db.prepare("SELECT SUM(num_respondents) as c FROM evaluations WHERE overall_quality IS NOT NULL").get() as { c: number }).c;

  console.log(`✓ Done in ${elapsed()}!`);
  console.log(`  ${scraped} evaluation records`);
  console.log(`  ${withEvals} courses updated with ratings`);
  console.log(`  ${totalRespondents} total student responses`);
  console.log(`  ${noEvalCodes.length} courses with no evaluation data`);

  // Sample output
  console.log(`\n=== Sample data ===`);
  const sample = db.prepare(
    "SELECT instance_key, instructor, num_respondents, num_enrolled, overall_quality, workload FROM evaluations WHERE overall_quality IS NOT NULL ORDER BY num_respondents DESC LIMIT 5"
  ).all();
  console.table(sample);
}

main().catch(console.error);
