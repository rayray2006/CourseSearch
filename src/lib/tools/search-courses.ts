import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";

const COURSE_COLUMNS = "offering_name, section_name, title, credits, department, school_name, level, status, meetings, location, building, instruction_method, instructors_full_name, max_seats, open_seats, waitlisted, is_writing_intensive, areas, time_of_day, description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents";

export const searchCourses = tool({
  description: `Search JHU Fall 2026 courses. Use this to find courses matching criteria like title keywords, department, school, level, schedule, credits, instructor, etc. Returns up to 20 results. For broad queries, encourage the user to narrow down.`,
  inputSchema: z.object({
    titleKeyword: z
      .string()
      .optional()
      .describe(
        "Keywords to search in course title (case-insensitive). Multiple words are matched independently — each word must appear somewhere in the title but not necessarily adjacent. E.g. 'sensor robotics' matches 'Algorithms for Sensor-Based Robotics'. Use short distinctive keywords rather than full phrases."
      ),
    department: z.string().optional().describe("Department name or partial match, e.g. 'Computer Science'."),
    school: z.string().optional().describe("School name or partial match, e.g. 'Whiting' or 'Krieger'"),
    level: z
      .enum(["Lower Level Undergraduate", "Upper Level Undergraduate", "Graduate", "Graduate Independent Academic Work", "Independent Academic Work", "Doctoral", "Post-Doctoral", "PostDoctoral"])
      .optional()
      .describe("Course level — use the exact value"),
    credits: z.string().optional().describe("Credit amount, e.g. '3.00'. Matches both exact credits and range credits."),
    instructor: z.string().optional().describe("Instructor last name or partial match"),
    daysOfWeek: z.string().optional().describe("Day pattern that starts the meetings field, e.g. 'MWF', 'TTh', 'MW', 'M', 'F'. Matches the EXACT day prefix."),
    timeOfDay: z.enum(["Morning", "Afternoon", "Evening", "Other"]).optional().describe("Time of day filter"),
    status: z.enum(["Open", "Closed", "Waitlist Only", "Canceled", "Approval Required", "Reserved Open"]).optional().describe("Course status — use exact value."),
    writingIntensive: z.boolean().optional().describe("If true, only return writing intensive courses"),
    instructionMethod: z.enum(["in-person", "online", "blended"]).optional().describe("Instruction method"),
    areas: z.string().optional().describe("Distribution area keyword"),
    courseNumber: z.string().optional().describe("Course number or partial, e.g. 'EN.601' or '601.226'"),
    minOverallQuality: z.number().optional().describe("Minimum overall quality rating (1-5)."),
    maxWorkload: z.number().optional().describe("Maximum workload rating (1-5)."),
    hasEvaluations: z.boolean().optional().describe("If true, only return courses with evaluation data."),
    descriptionKeyword: z.string().optional().describe("Keywords to search in course description."),
    hasPrerequisites: z.boolean().optional().describe("If true, only courses with prerequisites. If false, only without."),
    prerequisiteKeyword: z.string().optional().describe("Find courses that require a specific prerequisite. Accepts a course code or name."),
  }),
  execute: async (input) => {
    let query = supabase.from("courses").select(COURSE_COLUMNS).order("offering_name").order("section_name").limit(20);

    if (input.titleKeyword) {
      const words = input.titleKeyword.split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        query = query.ilike("title", `%${word}%`);
      }
    }
    if (input.department) query = query.ilike("department", `%${input.department}%`);
    if (input.school) query = query.ilike("school_name", `%${input.school}%`);
    if (input.level) query = query.eq("level", input.level);
    if (input.credits) {
      // For simplicity, match exact or use ilike for ranges containing the value
      query = query.or(`credits.eq.${input.credits},credits.ilike.%${input.credits}%`);
    }
    if (input.instructor) {
      const words = input.instructor.split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        query = query.ilike("instructors_full_name", `%${word}%`);
      }
    }
    if (input.daysOfWeek) query = query.ilike("meetings", `${input.daysOfWeek} %`);
    if (input.timeOfDay) query = query.eq("time_of_day", input.timeOfDay);
    if (input.status) query = query.eq("status", input.status);
    if (input.writingIntensive) query = query.eq("is_writing_intensive", "Yes");
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }
    if (input.areas) query = query.ilike("areas", `%${input.areas}%`);
    if (input.courseNumber) query = query.ilike("offering_name", `%${input.courseNumber}%`);
    if (input.descriptionKeyword) {
      const words = input.descriptionKeyword.split(/\s+/).filter((w) => w.length > 0);
      for (const word of words) {
        query = query.ilike("description", `%${word}%`);
      }
    }
    if (input.hasPrerequisites === true) query = query.neq("prerequisites", "");
    else if (input.hasPrerequisites === false) query = query.or("prerequisites.eq.,prerequisites.is.null");
    if (input.minOverallQuality) query = query.gte("overall_quality", input.minOverallQuality);
    if (input.maxWorkload) query = query.lte("workload", input.maxWorkload);
    if (input.hasEvaluations === true) query = query.not("overall_quality", "is", null);
    else if (input.hasEvaluations === false) query = query.is("overall_quality", null);

    if (input.prerequisiteKeyword) {
      const keyword = input.prerequisiteKeyword.trim();
      const looksLikeCode = /^[A-Z]{2}\.\d{3}\.\d{3}$/.test(keyword);

      if (looksLikeCode) {
        query = query.ilike("prerequisites", `%${keyword}%`);
      } else {
        // Resolve name to course codes
        const titleWords = keyword.split(/\s+/).filter((w) => w.length > 0);
        let lookupQuery = supabase.from("courses").select("offering_name");
        for (const word of titleWords) {
          lookupQuery = lookupQuery.ilike("title", `%${word}%`);
        }
        const { data: matchingCourses } = await lookupQuery.limit(20);
        const codes = [...new Set((matchingCourses || []).map((r) => r.offering_name))];

        if (codes.length > 0) {
          const orFilter = codes.map((code) => `prerequisites.ilike.%${code}%`).join(",");
          query = query.or(orFilter);
        } else {
          for (const word of titleWords) {
            query = query.ilike("prerequisites", `%${word}%`);
          }
        }
      }
    }

    const { data: rows, error } = await query;
    if (error) return { count: 0, courses: [], error: error.message };

    // Resolve course codes in prerequisites to include course names
    const codePattern = /[A-Z]{2}\.\d{3}\.\d{3}/g;
    const allCodes = new Set<string>();
    for (const row of rows || []) {
      if (row.prerequisites) {
        const matches = row.prerequisites.match(codePattern);
        if (matches) matches.forEach((c: string) => allCodes.add(c));
      }
    }

    let titleMap = new Map<string, string>();
    if (allCodes.size > 0) {
      const { data: titleRows } = await supabase
        .from("courses")
        .select("offering_name, title")
        .in("offering_name", [...allCodes]);
      if (titleRows) {
        titleMap = new Map(titleRows.map((r) => [r.offering_name, r.title]));
      }
    }

    const resolvedRows = (rows || []).map((row) => {
      if (row.prerequisites && titleMap.size > 0) {
        const codes = [...new Set(row.prerequisites.match(codePattern) || [])] as string[];
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
      return row;
    });

    return { count: resolvedRows.length, courses: resolvedRows };
  },
});

export const getCourseStats = tool({
  description:
    "Get statistics about available Fall 2026 courses — total count, breakdowns by school, level, status, etc.",
  inputSchema: z.object({
    groupBy: z
      .enum(["school_name", "department", "level", "status", "time_of_day", "instruction_method", "is_writing_intensive"])
      .describe("Field to group statistics by"),
  }),
  execute: async ({ groupBy }) => {
    // Fetch all values for the groupBy column, paginating past the 1000 row limit
    let allData: Record<string, string>[] = [];
    let offset = 0;
    const pageSize = 1000;
    while (true) {
      const { data, error } = await supabase
        .from("courses")
        .select(groupBy)
        .range(offset, offset + pageSize - 1);
      if (error || !data || data.length === 0) break;
      allData = allData.concat(data as Record<string, string>[]);
      if (data.length < pageSize) break;
      offset += pageSize;
    }

    const data = allData;
    if (data.length === 0) return { total: 0, breakdown: [] };

    const counts = new Map<string, number>();
    for (const row of data) {
      const val = (row as Record<string, string>)[groupBy] || "(none)";
      counts.set(val, (counts.get(val) || 0) + 1);
    }

    const breakdown = [...counts.entries()]
      .map(([category, count]) => ({ category, count }))
      .sort((a, b) => b.count - a.count);

    return { total: data.length, breakdown };
  },
});
