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
