import { initDb } from "../src/lib/db";
import { getDepartmentPaths, parseDepartmentPage } from "./lib/ecatalogue";

async function main() {
  const db = initDb();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO catalogue (
      offering_name, title, credits, department,
      description, prerequisites, corequisites, restrictions
    ) VALUES (
      @courseNumber, @title, @credits, @department,
      @description, @prerequisites, @corequisites, @restrictions
    )
  `);

  // Also update courses table descriptions (applies across all terms)
  const updateCourses = db.prepare(`
    UPDATE courses
    SET description = @description,
        prerequisites = @prerequisites,
        corequisites = @corequisites,
        restrictions = @restrictions
    WHERE offering_name = @courseNumber
  `);

  console.log("Fetching department list...");
  const paths = await getDepartmentPaths();
  console.log(`Found ${paths.length} department pages to scrape.\n`);

  let totalParsed = 0;
  let totalInserted = 0;
  let totalUpdated = 0;

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

      let inserted = 0;
      let updated = 0;

      for (const course of courses) {
        // Insert into catalogue
        insert.run(course);
        inserted++;

        // Update courses table (across all terms)
        const result = updateCourses.run({
          courseNumber: course.courseNumber,
          description: course.description,
          prerequisites: course.prerequisites,
          corequisites: course.corequisites,
          restrictions: course.restrictions,
        });
        if (result.changes > 0) updated += result.changes;
      }

      totalInserted += inserted;
      totalUpdated += updated;

      if (courses.length > 0) {
        console.log(
          `  [${i + 1}/${paths.length}] ${label}: ${courses.length} courses → catalogue: ${inserted}, courses updated: ${updated}`
        );
      }
    } catch (err) {
      console.log(`  [${i + 1}/${paths.length}] ${label}: error — ${err}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  const catCount = db.prepare("SELECT COUNT(*) as count FROM catalogue").get() as { count: number };
  const withDesc = db.prepare("SELECT COUNT(*) as count FROM courses WHERE description != ''").get() as { count: number };
  const totalCourses = db.prepare("SELECT COUNT(*) as count FROM courses").get() as { count: number };

  console.log(`\nDone!`);
  console.log(`  Parsed: ${totalParsed} courses from e-catalogue`);
  console.log(`  Catalogue table: ${catCount.count} entries`);
  console.log(`  Course rows updated: ${totalUpdated}`);
  console.log(`  Courses with descriptions: ${withDesc.count}/${totalCourses.count}`);
}

main().catch(console.error);
