import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";

export const searchCourses = tool({
  description: `Search JHU Fall 2026 courses. Use this to find courses matching criteria like title keywords, department, school, level, schedule, credits, instructor, etc. Returns up to 20 results. For broad queries, encourage the user to narrow down.`,
  inputSchema: z.object({
    titleKeyword: z
      .string()
      .optional()
      .describe("Keyword to search in course title (case-insensitive)"),
    department: z
      .string()
      .optional()
      .describe("Department name or partial match, e.g. 'Computer Science'"),
    school: z
      .string()
      .optional()
      .describe(
        "School name or partial match, e.g. 'Whiting' or 'Krieger' or 'Bloomberg'"
      ),
    level: z
      .string()
      .optional()
      .describe(
        "Course level: 'Lower Level Undergraduate', 'Upper Level Undergraduate', 'Graduate', etc."
      ),
    credits: z
      .string()
      .optional()
      .describe("Credit amount, e.g. '3.00' or '4.00'"),
    instructor: z
      .string()
      .optional()
      .describe("Instructor name (partial match)"),
    daysOfWeek: z
      .string()
      .optional()
      .describe(
        "Day pattern that starts the meetings field, e.g. 'MWF', 'TTh', 'MW', 'M', 'F'. This matches the EXACT day prefix — 'M' means ONLY Monday, 'MWF' means Mon/Wed/Fri. Available patterns: M, T, W, Th, F, Sa, S, MW, MF, MWF, TTh, TWThF, MTWThF, etc."
      ),
    timeOfDay: z
      .string()
      .optional()
      .describe("'Morning', 'Afternoon', 'Evening', or 'Other'"),
    isOpen: z
      .boolean()
      .optional()
      .describe("If true, only return courses with Status = 'Open'"),
    writingIntensive: z
      .boolean()
      .optional()
      .describe("If true, only return writing intensive courses"),
    instructionMethod: z
      .string()
      .optional()
      .describe("'In-person', 'Online', or 'Hybrid'"),
    areas: z
      .string()
      .optional()
      .describe("Distribution area keyword, e.g. 'Quantitative', 'Humanities'"),
    courseNumber: z
      .string()
      .optional()
      .describe("Course number or partial, e.g. 'EN.601' or '601.226'"),
  }),
  execute: async (input) => {
    const db = getDb();
    const conditions: string[] = [];
    const params: Record<string, string> = {};

    if (input.titleKeyword) {
      conditions.push("title LIKE @titleKeyword");
      params.titleKeyword = `%${input.titleKeyword}%`;
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
      conditions.push("level LIKE @level");
      params.level = `%${input.level}%`;
    }
    if (input.credits) {
      conditions.push("credits = @credits");
      params.credits = input.credits;
    }
    if (input.instructor) {
      conditions.push("instructors_full_name LIKE @instructor");
      params.instructor = `%${input.instructor}%`;
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
    if (input.isOpen) {
      conditions.push("status = 'Open'");
    }
    if (input.writingIntensive) {
      conditions.push("is_writing_intensive = 'Yes'");
    }
    if (input.instructionMethod) {
      conditions.push("instruction_method LIKE @instructionMethod");
      params.instructionMethod = `%${input.instructionMethod}%`;
    }
    if (input.areas) {
      conditions.push("areas LIKE @areas");
      params.areas = `%${input.areas}%`;
    }
    if (input.courseNumber) {
      conditions.push("offering_name LIKE @courseNumber");
      params.courseNumber = `%${input.courseNumber}%`;
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const sql = `
      SELECT * FROM courses
      ${where}
      ORDER BY offering_name, section_name
      LIMIT 20
    `;

    const rows = db.prepare(sql).all(params);
    return {
      count: rows.length,
      courses: rows,
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
