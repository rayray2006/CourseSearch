import { initDb } from "../src/lib/db";
import { getDepartmentPaths, parseDepartmentPage } from "./lib/ecatalogue";

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
      const courses = parseDepartmentPage(html, label);
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

    await new Promise((r) => setTimeout(r, 300));
  }

  console.log(`\nDone! Parsed ${totalParsed} course descriptions, updated ${totalUpdated} rows in DB.`);

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
