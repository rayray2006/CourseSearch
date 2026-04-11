import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";

export const searchCourses = tool({
  description: `Search JHU Fall 2026 courses. Use this to find courses matching criteria like title keywords, department, school, level, schedule, credits, instructor, etc. Returns up to 20 results. For broad queries, encourage the user to narrow down.`,
  inputSchema: z.object({
    titleKeyword: z
      .string()
      .optional()
      .describe(
        "Keywords to search in course title (case-insensitive). Multiple words are matched independently — each word must appear somewhere in the title but not necessarily adjacent. E.g. 'sensor robotics' matches 'Algorithms for Sensor-Based Robotics'. Use short distinctive keywords rather than full phrases."
      ),
    department: z
      .string()
      .optional()
      .describe(
        "Department name or partial match, e.g. 'Computer Science'. Note: departments are prefixed with school code like 'EN Computer Science', 'PE Computer Science', 'PY Computer Music'. Be specific to avoid cross-department matches."
      ),
    school: z
      .string()
      .optional()
      .describe(
        "School name or partial match, e.g. 'Whiting' or 'Krieger' or 'Bloomberg'"
      ),
    level: z
      .enum([
        "Lower Level Undergraduate",
        "Upper Level Undergraduate",
        "Graduate",
        "Graduate Independent Academic Work",
        "Independent Academic Work",
        "Doctoral",
        "Post-Doctoral",
        "PostDoctoral",
      ])
      .optional()
      .describe("Course level — use the exact value"),
    credits: z
      .string()
      .optional()
      .describe(
        "Credit amount, e.g. '3.00'. Matches both exact credits and range credits that include this value (e.g. '3.00' matches '3.00' and '1.00 - 4.00')"
      ),
    instructor: z
      .string()
      .optional()
      .describe("Instructor last name or partial match"),
    daysOfWeek: z
      .string()
      .optional()
      .describe(
        "Day pattern that starts the meetings field, e.g. 'MWF', 'TTh', 'MW', 'M', 'F'. This matches the EXACT day prefix — 'M' means ONLY Monday, 'MWF' means Mon/Wed/Fri. Available patterns: M, T, W, Th, F, Sa, S, MW, MF, MWF, TTh, TWThF, MTWThF, etc."
      ),
    timeOfDay: z
      .enum(["Morning", "Afternoon", "Evening", "Other"])
      .optional()
      .describe("Time of day filter"),
    status: z
      .enum(["Open", "Closed", "Waitlist Only", "Canceled", "Approval Required", "Reserved Open"])
      .optional()
      .describe("Course status — use exact value. 'Open' means seats available, 'Reserved Open' is different from 'Open'."),
    writingIntensive: z
      .boolean()
      .optional()
      .describe("If true, only return writing intensive courses"),
    instructionMethod: z
      .enum(["in-person", "online", "blended"])
      .optional()
      .describe(
        "Instruction method: 'in-person', 'online' (includes On-line, Online - Asynchronous, Online - Synchronous), or 'blended' (hybrid)"
      ),
    areas: z
      .string()
      .optional()
      .describe(
        "Distribution area keyword, e.g. 'Science and Data', 'Ethics and Foundations', 'Writing and Communication', 'Citizens and Society', 'Culture and Aesthetics', 'Creative Expression', 'Democracy', 'Engagement with Society'"
      ),
    courseNumber: z
      .string()
      .optional()
      .describe("Course number or partial, e.g. 'EN.601' or '601.226'"),
    descriptionKeyword: z
      .string()
      .optional()
      .describe(
        "Keywords to search in the course description (case-insensitive). Each word matched independently. Use for topic-based searches like 'machine learning' or 'data analysis'."
      ),
    hasPrerequisites: z
      .boolean()
      .optional()
      .describe("If true, only return courses that have prerequisites listed. If false, only courses with no prerequisites."),
    prerequisiteKeyword: z
      .string()
      .optional()
      .describe(
        "Search within prerequisites text, e.g. a course number like 'EN.601.226' or keyword like 'calculus'. Finds courses that require a specific prerequisite."
      ),
  }),
  execute: async (input) => {
    const db = getDb();
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (input.titleKeyword) {
      // Split into individual words and match each independently
      // "sensor based robotics" → title LIKE '%sensor%' AND title LIKE '%based%' AND title LIKE '%robotics%'
      const words = input.titleKeyword.split(/\s+/).filter((w) => w.length > 0);
      words.forEach((word, i) => {
        const paramName = `titleWord${i}`;
        conditions.push(`title LIKE @${paramName}`);
        params[paramName] = `%${word}%`;
      });
    }
    if (input.department) {
      conditions.push("department LIKE @department");
      params.department = `%${input.department}%`;
    }
    if (input.school) {
      conditions.push("school_name LIKE @school");
      params.school = `%${input.school}%`;
    }
    if (input.level) {
      // Exact match to avoid "Graduate" matching "Graduate Independent Academic Work"
      conditions.push("level = @level");
      params.level = input.level;
    }
    if (input.credits) {
      // Match exact credits OR ranges that include this value
      // e.g. '3.00' matches credits='3.00' and credits='1.00 - 4.00'
      conditions.push(
        "(credits = @credits OR (credits LIKE '%-%' AND CAST(SUBSTR(credits, 1, INSTR(credits, ' -') - 1) AS REAL) <= CAST(@credits AS REAL) AND CAST(SUBSTR(credits, INSTR(credits, '- ') + 2) AS REAL) >= CAST(@credits AS REAL)))"
      );
      params.credits = input.credits;
    }
    if (input.instructor) {
      // Split to handle "first last" searches matching "Last, First" format
      const words = input.instructor.split(/\s+/).filter((w) => w.length > 0);
      words.forEach((word, i) => {
        const paramName = `instrWord${i}`;
        conditions.push(`instructors_full_name LIKE @${paramName}`);
        params[paramName] = `%${word}%`;
      });
    }
    if (input.daysOfWeek) {
      // Match the exact day prefix: "M 4:30PM..." not "MWF 10:00AM..."
      conditions.push("meetings LIKE @daysOfWeek");
      params.daysOfWeek = `${input.daysOfWeek} %`;
    }
    if (input.timeOfDay) {
      conditions.push("time_of_day = @timeOfDay");
      params.timeOfDay = input.timeOfDay;
    }
    if (input.status) {
      // Exact match to avoid "Open" matching "Reserved Open"
      conditions.push("status = @status");
      params.status = input.status;
    }
    if (input.writingIntensive) {
      conditions.push("is_writing_intensive = 'Yes'");
    }
    if (input.instructionMethod) {
      // Normalize the messy instruction_method field
      const method = input.instructionMethod.toLowerCase();
      if (method === "in-person") {
        conditions.push("(LOWER(instruction_method) LIKE '%in-person%' OR LOWER(instruction_method) = 'lecture')");
      } else if (method === "online") {
        conditions.push("(LOWER(instruction_method) LIKE '%on-line%' OR LOWER(instruction_method) LIKE '%online%')");
      } else if (method === "blended") {
        conditions.push("LOWER(instruction_method) LIKE '%blended%'");
      }
    }
    if (input.areas) {
      conditions.push("areas LIKE @areas");
      params.areas = `%${input.areas}%`;
    }
    if (input.courseNumber) {
      conditions.push("offering_name LIKE @courseNumber");
      params.courseNumber = `%${input.courseNumber}%`;
    }
    if (input.descriptionKeyword) {
      const words = input.descriptionKeyword.split(/\s+/).filter((w) => w.length > 0);
      words.forEach((word, i) => {
        const paramName = `descWord${i}`;
        conditions.push(`description LIKE @${paramName}`);
        params[paramName] = `%${word}%`;
      });
    }
    if (input.hasPrerequisites === true) {
      conditions.push("prerequisites != ''");
    } else if (input.hasPrerequisites === false) {
      conditions.push("(prerequisites = '' OR prerequisites IS NULL)");
    }
    if (input.prerequisiteKeyword) {
      const words = input.prerequisiteKeyword.split(/\s+/).filter((w) => w.length > 0);
      words.forEach((word, i) => {
        const paramName = `prereqWord${i}`;
        conditions.push(`prerequisites LIKE @${paramName}`);
        params[paramName] = `%${word}%`;
      });
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT offering_name, section_name, title, credits, department, school_name,
             level, status, meetings, location, building, instruction_method,
             instructors_full_name, max_seats, open_seats, waitlisted,
             is_writing_intensive, areas, time_of_day, description, prerequisites,
             corequisites, restrictions
      FROM courses
      ${where}
      ORDER BY offering_name, section_name
      LIMIT 20
    `;

    const rows = db.prepare(sql).all(params) as Record<string, string>[];

    // Resolve course codes in prerequisites to include course names
    const codePattern = /[A-Z]{2}\.\d{3}\.\d{3}/g;
    const resolvedRows = rows.map((row) => {
      if (row.prerequisites) {
        const codes = [...new Set(row.prerequisites.match(codePattern) || [])];
        if (codes.length > 0) {
          const placeholders = codes.map(() => "?").join(",");
          const titleRows = db
            .prepare(
              `SELECT DISTINCT offering_name, title FROM courses WHERE offering_name IN (${placeholders})`
            )
            .all(...codes) as { offering_name: string; title: string }[];
          const titleMap = new Map(
            titleRows.map((r) => [r.offering_name, r.title])
          );

          let resolved = row.prerequisites;
          for (const code of codes) {
            const name = titleMap.get(code);
            if (name) {
              resolved = resolved.replace(
                new RegExp(code.replace(/\./g, "\\."), "g"),
                `${code} (${name})`
              );
            }
          }
          return { ...row, prerequisites: resolved };
        }
      }
      return row;
    });

    return {
      count: resolvedRows.length,
      courses: resolvedRows,
    };
  },
});

export const getCourseStats = tool({
  description:
    "Get statistics about available Fall 2026 courses — total count, breakdowns by school, level, status, etc. Use this when the user asks general questions about what's available.",
  inputSchema: z.object({
    groupBy: z
      .enum([
        "school_name",
        "department",
        "level",
        "status",
        "time_of_day",
        "instruction_method",
        "is_writing_intensive",
      ])
      .describe("Field to group statistics by"),
  }),
  execute: async ({ groupBy }) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT ${groupBy} as category, COUNT(*) as count FROM courses GROUP BY ${groupBy} ORDER BY count DESC`
      )
      .all();

    const total = db
      .prepare("SELECT COUNT(*) as count FROM courses")
      .get() as { count: number };

    return { total: total.count, breakdown: rows };
  },
});
