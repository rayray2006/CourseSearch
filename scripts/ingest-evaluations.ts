import { load } from "cheerio";
import { initDb } from "../src/lib/db";

const AUTH_URL =
  "https://asen-jhu.evaluationkit.com/Login/ReportPublic?id=THo7RYxiDOgppCUb8vkY%2bPMVFDNyK2ADK0u537x%2fnZsNvzOBJJZTTNEcJihG8hqZ";
const BASE = "https://asen-jhu.evaluationkit.com/";

const QUESTION_MAP: Record<string, string> = {
  "The overall quality of this course is:": "overall_quality",
  "The instructor's teaching effectiveness is:": "instructor_effectiveness",
  "The intellectual challenge of this course is:": "intellectual_challenge",
  "Compared to other Hopkins courses at this level, the workload for this course is:": "workload",
  "Feedback on my work for this course is useful:": "feedback_usefulness",
};

// ── Multiple independent sessions for parallel scraping ─────────────
const NUM_SESSIONS = 6;

class Session {
  cookies: string[] = [];

  private merge(headers: string[]) {
    for (const h of headers) {
      const c = h.split(";")[0];
      const n = c.split("=")[0];
      this.cookies = this.cookies.filter((x) => !x.startsWith(n + "="));
      this.cookies.push(c);
    }
  }

  async fetch(url: string, retries = 3): Promise<string> {
    for (let attempt = 0; attempt < retries; attempt++) {
      try {
        let u = url;
        for (let r = 0; r < 10; r++) {
          const res = await fetch(u, {
            redirect: "manual",
            headers: { Cookie: this.cookies.join("; "), "User-Agent": "Mozilla/5.0" },
          });
          const sc = res.headers.getSetCookie?.() ?? [];
          if (sc.length > 0) this.merge(sc);
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
        if (attempt < retries - 1) await new Promise((r) => setTimeout(r, 200 * (attempt + 1)));
        else throw err;
      }
    }
    throw new Error("Unreachable");
  }

  async authenticate() {
    await this.fetch(AUTH_URL);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────
function computeWeightedAvg(freq: Record<string, number>): number | null {
  const entries = Object.entries(freq).filter(([l]) => l !== "N/A" && l !== "n/a");
  if (entries.length === 0) return null;
  let total = 0, sum = 0;
  for (let i = 0; i < entries.length; i++) { total += entries[i][1]; sum += entries[i][1] * (i + 1); }
  return total === 0 ? null : Math.round((sum / total) * 100) / 100;
}

function countRespondents(freq: Record<string, number>): number {
  return Object.entries(freq).filter(([l]) => l !== "N/A" && l !== "n/a").reduce((s, [, c]) => s + c, 0);
}

// ── Discovery: extract metadata + report links from search page ─────
interface ReportLink {
  instanceKey: string;
  url: string;
  courseCode: string;
  courseName: string;
  instructor: string;
  responded: number;
  enrolled: number;
  termLabel: string;
}

function parseSearchPage(html: string, courseCode: string): ReportLink[] {
  const $ = load(html);
  const links: ReportLink[] = [];
  $("a.sr-view-report").each((_, el) => {
    const $el = $(el);
    const id0 = $el.attr("data-id0"), id1 = $el.attr("data-id1"),
      id2 = $el.attr("data-id2"), id3 = $el.attr("data-id3");
    if (!id0 || !id1 || !id2 || !id3) return;

    const $row = $el.closest(".row");
    const instanceKey = $row.find(".sr-dataitem-info-code").text().trim();
    if (!instanceKey) return;

    const courseName = $row.find("h2").text().trim();
    const instructor = $row.find(".sr-dataitem-info-instr").text().trim();

    let responded = 0, enrolled = 0;
    const respText = $row.find(".sr-avg span").text().trim();
    const respMatch = respText.match(/(\d+)\s+of\s+(\d+)/);
    if (respMatch) { responded = parseInt(respMatch[1]); enrolled = parseInt(respMatch[2]); }

    const termLabel = $row.find(".sr-dataitem-info .small").first().text().trim().split("\n")[0].trim();

    links.push({
      instanceKey, courseCode, courseName, instructor, responded, enrolled, termLabel,
      url: `${BASE}Reports/StudentReport.aspx?id=${id0},${id1},${id2},${id3}`,
    });
  });
  return links;
}

// ── Report parsing ──────────────────────────────────────────────────
interface EvalRow {
  courseCode: string;
  instanceKey: string;
  courseName: string;
  instructor: string;
  term: string;
  termLabel: string;
  overallQuality: number | null;
  instructorEffectiveness: number | null;
  intellectualChallenge: number | null;
  workload: number | null;
  feedbackUsefulness: number | null;
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

// ── Worker: each session processes its own chunk ────────────────────
async function workerDiscover(session: Session, codes: string[], progress: { done: number; total: number; links: number }): Promise<{ links: ReportLink[]; noEval: string[] }> {
  const links: ReportLink[] = [];
  const noEval: string[] = [];

  // Process 5 at a time per session
  const BATCH = 5;
  for (let i = 0; i < codes.length; i += BATCH) {
    const batch = codes.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (code) => {
        try {
          const html = await session.fetch(`${BASE}Report/Public/Results?Course=${encodeURIComponent(code)}`);
          return { code, links: parseSearchPage(html, code) };
        } catch {
          return { code, links: [] as ReportLink[] };
        }
      })
    );
    for (const r of results) {
      if (r.links.length > 0) { links.push(...r.links); progress.links += r.links.length; }
      else noEval.push(r.code);
      progress.done++;
    }
  }
  return { links, noEval };
}

async function workerScrape(session: Session, links: ReportLink[], progress: { done: number; ok: number; fail: number; total: number }): Promise<EvalRow[]> {
  const rows: EvalRow[] = [];
  const BATCH = 5;
  for (let i = 0; i < links.length; i += BATCH) {
    const batch = links.slice(i, i + BATCH);
    const results = await Promise.all(
      batch.map(async (link) => {
        try {
          const html = await session.fetch(link.url);
          return parseReport(html, link);
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) { rows.push(r); progress.ok++; }
      else progress.fail++;
      progress.done++;
    }
  }
  return rows;
}

// ── Main ────────────────────────────────────────────────────────────
async function main() {
  const db = initDb();
  const t0 = Date.now();
  const elapsed = () => ((Date.now() - t0) / 1000).toFixed(0) + "s";

  // Recreate evaluations
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

  // Create and authenticate multiple sessions
  console.log(`\nCreating ${NUM_SESSIONS} parallel sessions...`);
  const sessions: Session[] = [];
  for (let i = 0; i < NUM_SESSIONS; i++) {
    const s = new Session();
    await s.authenticate();
    sessions.push(s);
  }
  console.log(`All sessions ready. [${elapsed()}]\n`);

  // Phase 1: Discover — split courses across sessions
  console.log(`=== Phase 1: Discovering reports for ${codes.length} courses (${NUM_SESSIONS} sessions × 5 concurrent) ===\n`);

  const chunkSize = Math.ceil(codes.length / NUM_SESSIONS);
  const discoverProgress = { done: 0, total: codes.length, links: 0 };

  // Log progress periodically
  const logInterval = setInterval(() => {
    console.log(`  ${discoverProgress.done}/${discoverProgress.total} searched — ${discoverProgress.links} reports [${elapsed()}]`);
  }, 5000);

  const discoverResults = await Promise.all(
    sessions.map((session, i) => {
      const chunk = codes.slice(i * chunkSize, (i + 1) * chunkSize);
      return workerDiscover(session, chunk, discoverProgress);
    })
  );

  clearInterval(logInterval);

  const allLinks = discoverResults.flatMap((r) => r.links);
  const noEvalCodes = discoverResults.flatMap((r) => r.noEval);

  console.log(`\n✓ Phase 1: ${allLinks.length} reports from ${codes.length - noEvalCodes.length} courses [${elapsed()}]\n`);

  // Phase 2: Scrape — split links across sessions
  console.log(`=== Phase 2: Scraping ${allLinks.length} reports (${NUM_SESSIONS} sessions × 5 concurrent) ===\n`);

  const linkChunkSize = Math.ceil(allLinks.length / NUM_SESSIONS);
  const scrapeProgress = { done: 0, ok: 0, fail: 0, total: allLinks.length };

  const logInterval2 = setInterval(() => {
    console.log(`  ${scrapeProgress.done}/${scrapeProgress.total} (${scrapeProgress.ok} ok, ${scrapeProgress.fail} fail) [${elapsed()}]`);
  }, 5000);

  const scrapeResults = await Promise.all(
    sessions.map((session, i) => {
      const chunk = allLinks.slice(i * linkChunkSize, (i + 1) * linkChunkSize);
      return workerScrape(session, chunk, scrapeProgress);
    })
  );

  clearInterval(logInterval2);

  const allRows = scrapeResults.flat();
  console.log(`\n✓ Phase 2: ${scrapeProgress.ok} scraped, ${scrapeProgress.fail} failed [${elapsed()}]\n`);

  // Insert all rows
  console.log(`Inserting ${allRows.length} rows...`);
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
  db.transaction(() => { for (const r of allRows) insert.run(r); })();

  // Phase 3: Aggregate
  console.log(`Aggregating into courses...`);
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
      FROM evaluations WHERE overall_quality IS NOT NULL
      GROUP BY course_code
    ) agg WHERE courses.offering_name = agg.course_code
  `);

  const withEvals = (db.prepare("SELECT COUNT(DISTINCT offering_name) as c FROM courses WHERE overall_quality IS NOT NULL").get() as { c: number }).c;
  const totalResp = (db.prepare("SELECT SUM(num_respondents) as c FROM evaluations WHERE overall_quality IS NOT NULL").get() as { c: number }).c;

  console.log(`\n✓ Done in ${elapsed()}!`);
  console.log(`  ${allRows.length} evaluation records stored`);
  console.log(`  ${withEvals} courses updated with ratings`);
  console.log(`  ${totalResp} total student responses`);
  console.log(`  ${noEvalCodes.length} courses with no evaluation data`);

  console.log(`\n=== Sample ===`);
  const sample = db.prepare(
    "SELECT instance_key, instructor, num_respondents, num_enrolled, overall_quality, workload FROM evaluations WHERE overall_quality IS NOT NULL ORDER BY num_respondents DESC LIMIT 8"
  ).all();
  console.table(sample);
}

main().catch(console.error);
