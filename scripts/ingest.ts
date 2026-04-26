import { initDb } from "../src/lib/db";

const API_KEY = process.env.JHU_API_KEY;
const BASE_URL = "https://sis.jhu.edu/api/classes";

const ALL_TERMS = [
  "Fall 2024",
  "Spring 2025",
  "Summer 2025",
  "Fall 2025",
  "Spring 2026",
  "Summer 2026",
  "Fall 2026",
  "Spring 2027",
];

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

interface Course {
  OfferingName: string;
  SectionName: string;
  Title: string;
  Credits: string;
  Department: string;
  SchoolName: string;
  Level: string;
  Status: string;
  DOW: string;
  TimeOfDay: string;
  Meetings: string;
  Location: string;
  Building: string;
  InstructionMethod: string;
  Instructors: string;
  InstructorsFullName: string;
  MaxSeats: string;
  OpenSeats: string;
  Waitlisted: string;
  IsWritingIntensive: string;
  Areas: string;
  Repeatable: string;
  Term: string;
  TermStartDate: string;
}

async function fetchSchoolCourses(school: string, term: string): Promise<Course[]> {
  const url = `${BASE_URL}/${encodeURIComponent(school)}/${encodeURIComponent(term)}?key=${API_KEY}`;

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Failed for ${school}: ${res.status}`);
    return [];
  }

  const data = await res.json();
  return data;
}

async function main() {
  if (!API_KEY) {
    console.error("Set JHU_API_KEY in .env.local");
    process.exit(1);
  }

  const db = initDb();

  // Accept optional CLI arg to ingest a single term
  const argTerm = process.argv[2];
  const terms = argTerm ? [argTerm] : ALL_TERMS;

  console.log(`Ingesting ${terms.length} term(s): ${terms.join(", ")}\n`);

  const insert = db.prepare(`
    INSERT OR REPLACE INTO courses (
      offering_name, section_name, title, credits, department, school_name,
      level, status, dow, time_of_day, meetings, location, building,
      instruction_method, instructors, instructors_full_name, max_seats,
      open_seats, waitlisted, is_writing_intensive, areas, repeatable,
      term, term_start_date
    ) VALUES (
      @offering_name, @section_name, @title, @credits, @department, @school_name,
      @level, @status, @dow, @time_of_day, @meetings, @location, @building,
      @instruction_method, @instructors, @instructors_full_name, @max_seats,
      @open_seats, @waitlisted, @is_writing_intensive, @areas, @repeatable,
      @term, @term_start_date
    )
  `);

  const insertMany = db.transaction((courses: Course[]) => {
    for (const c of courses) {
      insert.run({
        offering_name: c.OfferingName,
        section_name: c.SectionName,
        title: c.Title,
        credits: c.Credits,
        department: c.Department,
        school_name: c.SchoolName,
        level: c.Level,
        status: c.Status,
        dow: c.DOW,
        time_of_day: c.TimeOfDay,
        meetings: c.Meetings,
        location: c.Location,
        building: c.Building,
        instruction_method: c.InstructionMethod,
        instructors: c.Instructors,
        instructors_full_name: c.InstructorsFullName,
        max_seats: c.MaxSeats,
        open_seats: c.OpenSeats,
        waitlisted: c.Waitlisted,
        is_writing_intensive: c.IsWritingIntensive,
        areas: c.Areas,
        repeatable: c.Repeatable,
        term: c.Term,
        term_start_date: c.TermStartDate,
      });
    }
  });

  const updateTerm = db.prepare(`
    INSERT OR REPLACE INTO available_terms (term, sort_order, has_sis_data, course_count, is_current)
    VALUES (@term, @sort_order, @has_sis_data, @course_count, @is_current)
  `);

  let grandTotal = 0;

  for (const term of terms) {
    console.log(`\n=== ${term} ===`);
    let termTotal = 0;

    for (const school of SCHOOLS) {
      console.log(`  Fetching: ${school}...`);
      const courses = await fetchSchoolCourses(school, term);
      if (courses.length > 0) {
        insertMany(courses);
        termTotal += courses.length;
        console.log(`    Got ${courses.length} sections`);
      } else {
        console.log(`    0 sections`);
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    // Update available_terms
    const sortOrder = ALL_TERMS.indexOf(term) + 1 || terms.indexOf(term) + 100;
    updateTerm.run({
      term,
      sort_order: sortOrder,
      has_sis_data: termTotal > 0 ? 1 : 0,
      course_count: termTotal,
      is_current: term === "Fall 2026" ? 1 : 0,
    });

    grandTotal += termTotal;
    console.log(`  Total for ${term}: ${termTotal} sections`);
  }

  // Re-aggregate eval ratings from the evaluations table back into freshly
  // inserted course rows. INSERT OR REPLACE above clears these columns; if
  // every term is rescraped at once, the cross-term recovery below has nothing
  // to copy from. The evaluations table is the source of truth.
  console.log("\nRe-aggregating evaluations into courses...");
  const aggResult = db.prepare(`
    UPDATE courses
    SET overall_quality = agg.avg_oq,
        instructor_effectiveness = agg.avg_ie,
        intellectual_challenge = agg.avg_ic,
        workload = agg.avg_wl,
        feedback_usefulness = agg.avg_fu,
        num_evaluations = agg.cnt,
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
    ) agg
    WHERE courses.offering_name = agg.course_code
      AND courses.term IN (${terms.map(() => "?").join(",")})
  `).run(...terms);
  console.log(`  Aggregated evals into ${aggResult.changes} courses.`);

  // Cross-term fallback: for offerings without evaluations table data, copy
  // averages from other terms that still have ratings.
  console.log("Applying cross-term evaluation fallback...");
  const applyEvals = db.prepare(`
    UPDATE courses
    SET
      overall_quality = (SELECT ROUND(AVG(c2.overall_quality), 2) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.overall_quality IS NOT NULL),
      instructor_effectiveness = (SELECT ROUND(AVG(c2.instructor_effectiveness), 2) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.instructor_effectiveness IS NOT NULL),
      intellectual_challenge = (SELECT ROUND(AVG(c2.intellectual_challenge), 2) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.intellectual_challenge IS NOT NULL),
      workload = (SELECT ROUND(AVG(c2.workload), 2) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.workload IS NOT NULL),
      feedback_usefulness = (SELECT ROUND(AVG(c2.feedback_usefulness), 2) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.feedback_usefulness IS NOT NULL),
      num_evaluations = (SELECT SUM(c2.num_evaluations) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.num_evaluations IS NOT NULL),
      num_respondents = (SELECT SUM(c2.num_respondents) FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.num_respondents IS NOT NULL)
    WHERE term IN (${terms.map(() => "?").join(",")})
      AND overall_quality IS NULL
      AND EXISTS (SELECT 1 FROM courses c2 WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term AND c2.overall_quality IS NOT NULL)
  `);
  const evalResult = applyEvals.run(...terms);
  console.log(`  Applied evals to ${evalResult.changes} courses.`);

  // Apply historical prerequisites, descriptions, corequisites, restrictions
  console.log("Applying historical prerequisites & descriptions...");
  const applyPrereqs = db.prepare(`
    UPDATE courses
    SET
      prerequisites = COALESCE(NULLIF(courses.prerequisites, ''), (
        SELECT c2.prerequisites FROM courses c2
        WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term
          AND c2.prerequisites IS NOT NULL AND c2.prerequisites != ''
        ORDER BY c2.term DESC LIMIT 1
      )),
      description = COALESCE(NULLIF(courses.description, ''), (
        SELECT c2.description FROM courses c2
        WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term
          AND c2.description IS NOT NULL AND c2.description != ''
        ORDER BY c2.term DESC LIMIT 1
      )),
      corequisites = COALESCE(NULLIF(courses.corequisites, ''), (
        SELECT c2.corequisites FROM courses c2
        WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term
          AND c2.corequisites IS NOT NULL AND c2.corequisites != ''
        ORDER BY c2.term DESC LIMIT 1
      )),
      restrictions = COALESCE(NULLIF(courses.restrictions, ''), (
        SELECT c2.restrictions FROM courses c2
        WHERE c2.offering_name = courses.offering_name AND c2.term != courses.term
          AND c2.restrictions IS NOT NULL AND c2.restrictions != ''
        ORDER BY c2.term DESC LIMIT 1
      ))
    WHERE term IN (${terms.map(() => "?").join(",")})
      AND (prerequisites IS NULL OR prerequisites = '')
  `);
  const prereqResult = applyPrereqs.run(...terms);
  console.log(`  Applied prereqs/descriptions to ${prereqResult.changes} courses.`);

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Done! Inserted ${grandTotal} total course sections across ${terms.length} terms.`);

  const count = db.prepare("SELECT COUNT(*) as count FROM courses").get() as {
    count: number;
  };
  console.log(`Database has ${count.count} total rows.`);

  const termCounts = db
    .prepare("SELECT term, COUNT(*) as count FROM courses GROUP BY term ORDER BY term")
    .all() as { term: string; count: number }[];
  console.log("\nPer-term breakdown:");
  for (const t of termCounts) {
    console.log(`  ${t.term}: ${t.count}`);
  }
}

main().catch(console.error);
