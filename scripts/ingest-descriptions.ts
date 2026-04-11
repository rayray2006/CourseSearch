import { load } from "cheerio";
import { getDb, initDb } from "../src/lib/db";

const BASE = "https://e-catalogue.jhu.edu/course-descriptions/";

async function getDepartmentPaths(): Promise<string[]> {
  const res = await fetch(BASE);
  const html = await res.text();
  const $ = load(html);
  const paths: string[] = [];
  $('a[href^="/course-descriptions/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href && href !== "/course-descriptions/" && href.endsWith("/")) {
      paths.push(href);
    }
  });
  return [...new Set(paths)];
}

interface CourseDetail {
  courseNumber: string; // e.g. "EN.601.226"
  title: string;
  credits: string;
  description: string;
  prerequisites: string;
  corequisites: string;
  restrictions: string;
}

function parseDepartmentPage(html: string): CourseDetail[] {
  const $ = load(html);
  const courses: CourseDetail[] = [];

  $(".courseblock").each((_, block) => {
    const $block = $(block);

    // Course number: "EN.601.226."
    const codeRaw = $block.find(".detail-code").text().trim();
    const courseNumber = codeRaw.replace(/\.$/, ""); // remove trailing dot

    // Title: "Data Structures."
    const titleRaw = $block.find(".detail-title").text().trim();
    const title = titleRaw.replace(/\.$/, "");

    // Credits
    const creditsRaw = $block.find(".detail-hours_html").text().trim();
    const credits = creditsRaw.replace(/\.$/, "");

    // Parse the extra paragraphs
    let description = "";
    let prerequisites = "";
    let corequisites = "";
    let restrictions = "";

    $block.find(".courseblockextra").each((_, p) => {
      const text = $(p).text().trim();

      if (text.startsWith("Prerequisite(s):")) {
        prerequisites = text.replace("Prerequisite(s):", "").trim();
      } else if (text.startsWith("Co-requisite(s):")) {
        corequisites = text.replace("Co-requisite(s):", "").trim();
      } else if (text.startsWith("Restriction(s):")) {
        restrictions = text.replace("Restriction(s):", "").trim();
      } else if (
        !text.startsWith("Distribution Area:") &&
        !text.startsWith("AS Foundational") &&
        !text.startsWith("Writing Intensive") &&
        !text.startsWith("Area:") &&
        text.length > 20 // skip short metadata lines
      ) {
        // This is likely the description
        if (!description) {
          description = text;
        }
      }
    });

    if (courseNumber) {
      courses.push({
        courseNumber,
        title,
        credits,
        description,
        prerequisites,
        corequisites,
        restrictions,
      });
    }
  });

  return courses;
}

async function main() {
  const db = initDb();

  // Add new columns if they don't exist
  const columns = db
    .prepare("PRAGMA table_info(courses)")
    .all() as { name: string }[];
  const colNames = columns.map((c) => c.name);

  if (!colNames.includes("description")) {
    db.exec("ALTER TABLE courses ADD COLUMN description TEXT DEFAULT ''");
  }
  if (!colNames.includes("prerequisites")) {
    db.exec("ALTER TABLE courses ADD COLUMN prerequisites TEXT DEFAULT ''");
  }
  if (!colNames.includes("corequisites")) {
    db.exec("ALTER TABLE courses ADD COLUMN corequisites TEXT DEFAULT ''");
  }
  if (!colNames.includes("restrictions")) {
    db.exec("ALTER TABLE courses ADD COLUMN restrictions TEXT DEFAULT ''");
  }

  console.log("Fetching department list...");
  const paths = await getDepartmentPaths();
  console.log(`Found ${paths.length} department pages to scrape.\n`);

  const update = db.prepare(`
    UPDATE courses
    SET description = @description,
        prerequisites = @prerequisites,
        corequisites = @corequisites,
        restrictions = @restrictions
    WHERE offering_name = @courseNumber
  `);

  let totalUpdated = 0;
  let totalParsed = 0;

  for (let i = 0; i < paths.length; i++) {
    const path = paths[i];
    const url = `https://e-catalogue.jhu.edu${path}`;
    const label = path.replace("/course-descriptions/", "").replace("/", "");

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  [${i + 1}/${paths.length}] ${label}: HTTP ${res.status} — skipping`);
        continue;
      }

      const html = await res.text();
      const courses = parseDepartmentPage(html);
      totalParsed += courses.length;

      let updated = 0;
      for (const course of courses) {
        const result = update.run({
          courseNumber: course.courseNumber,
          description: course.description,
          prerequisites: course.prerequisites,
          corequisites: course.corequisites,
          restrictions: course.restrictions,
        });
        if (result.changes > 0) updated += result.changes;
      }

      totalUpdated += updated;
      if (courses.length > 0) {
        console.log(
          `  [${i + 1}/${paths.length}] ${label}: ${courses.length} courses parsed, ${updated} rows updated`
        );
      }
    } catch (err) {
      console.log(`  [${i + 1}/${paths.length}] ${label}: error — ${err}`);
    }

    // Be polite
    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\nDone! Parsed ${totalParsed} course descriptions, updated ${totalUpdated} rows in DB.`);

  // Check how many courses now have descriptions
  const withDesc = db
    .prepare("SELECT COUNT(*) as count FROM courses WHERE description != ''")
    .get() as { count: number };
  const withPrereq = db
    .prepare("SELECT COUNT(*) as count FROM courses WHERE prerequisites != ''")
    .get() as { count: number };
  const total = db
    .prepare("SELECT COUNT(*) as count FROM courses")
    .get() as { count: number };

  console.log(`\nCoverage: ${withDesc.count}/${total.count} have descriptions, ${withPrereq.count}/${total.count} have prerequisites.`);
}

main().catch(console.error);
