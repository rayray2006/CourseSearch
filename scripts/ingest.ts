import { initDb } from "../src/lib/db";

const API_KEY = process.env.JHU_API_KEY;
const BASE_URL = "https://sis.jhu.edu/api/classes";
const TERM = "Fall 2026";

const SCHOOLS = [
  "Bloomberg School of Public Health",
  "Carey Business School",
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Nitze School of Advanced International Studies",
  "School of Education",
  "School of Medicine",
  "School of Nursing",
  "The Peabody Institute",
  "Whiting School of Engineering",
  "Whiting School of Engineering for Professionals",
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

async function fetchSchoolCourses(school: string): Promise<Course[]> {
  const url = `${BASE_URL}/${encodeURIComponent(school)}/${encodeURIComponent(TERM)}?key=${API_KEY}`;
  console.log(`Fetching: ${school}...`);

  const res = await fetch(url);
  if (!res.ok) {
    console.error(`  Failed for ${school}: ${res.status}`);
    return [];
  }

  const data = await res.json();
  console.log(`  Got ${data.length} sections from ${school}`);
  return data;
}

async function main() {
  if (!API_KEY) {
    console.error("Set JHU_API_KEY in .env.local");
    process.exit(1);
  }

  const db = initDb();

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

  let total = 0;
  for (const school of SCHOOLS) {
    const courses = await fetchSchoolCourses(school);
    if (courses.length > 0) {
      insertMany(courses);
      total += courses.length;
    }
    // small delay to be polite to the API
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! Inserted ${total} total course sections.`);

  const count = db.prepare("SELECT COUNT(*) as count FROM courses").get() as {
    count: number;
  };
  console.log(`Database has ${count.count} rows.`);
}

main().catch(console.error);
