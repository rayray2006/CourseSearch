import { tool } from "ai";
import { z } from "zod";
import { getDb } from "../db";
import {
  addToSchedule,
  removeFromSchedule,
  getSchedule,
  clearSchedule,
} from "../schedule-store";

export const addCourseToSchedule = tool({
  description:
    "Add a course to the user's schedule. Use the exact offering_name (e.g. 'EN.601.226') and section_name (e.g. '01') from a previous search result. The tool will look up the full course details and add it.",
  inputSchema: z.object({
    offering_name: z
      .string()
      .describe("Course offering name, e.g. 'EN.601.226'"),
    section_name: z.string().describe("Section number, e.g. '01'"),
  }),
  execute: async ({ offering_name, section_name }) => {
    const db = getDb();
    const row = db
      .prepare(
        "SELECT * FROM courses WHERE offering_name = @offering_name AND section_name = @section_name"
      )
      .get({ offering_name, section_name }) as Record<string, string> | undefined;

    if (!row) {
      return {
        success: false,
        message: `Course ${offering_name} section ${section_name} not found.`,
      };
    }

    return addToSchedule({
      offering_name: row.offering_name,
      section_name: row.section_name,
      title: row.title,
      credits: row.credits,
      department: row.department,
      school_name: row.school_name,
      level: row.level,
      meetings: row.meetings,
      location: row.location,
      building: row.building,
      instructors_full_name: row.instructors_full_name,
      instruction_method: row.instruction_method,
      status: row.status,
    });
  },
});

export const removeCourseFromSchedule = tool({
  description:
    "Remove a course from the user's schedule by offering_name and section_name.",
  inputSchema: z.object({
    offering_name: z
      .string()
      .describe("Course offering name, e.g. 'EN.601.226'"),
    section_name: z.string().describe("Section number, e.g. '01'"),
  }),
  execute: async ({ offering_name, section_name }) => {
    return removeFromSchedule(offering_name, section_name);
  },
});

export const viewSchedule = tool({
  description:
    "View all courses currently in the user's schedule. Use this when the user asks to see their schedule or what they've added.",
  inputSchema: z.object({}),
  execute: async () => {
    const courses = getSchedule();
    if (courses.length === 0) {
      return { courses: [], message: "Your schedule is empty." };
    }
    const totalCredits = courses.reduce((sum, c) => {
      const parsed = parseFloat(c.credits);
      return sum + (isNaN(parsed) ? 0 : parsed);
    }, 0);
    return { courses, totalCredits, count: courses.length };
  },
});

export const clearMySchedule = tool({
  description: "Clear all courses from the user's schedule. Ask for confirmation before using this.",
  inputSchema: z.object({}),
  execute: async () => {
    return clearSchedule();
  },
});
