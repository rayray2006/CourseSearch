import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";

const COURSE_COLUMNS = "offering_name, section_name, title, credits, department, school_name, level, status, meetings, location, building, instruction_method, instructors_full_name, max_seats, open_seats, waitlisted, is_writing_intensive, areas, time_of_day, description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents";

export const searchCourses = tool({
  description: `Search JHU Fall 2026 courses. Use this to find courses matching criteria like title keywords, department, school, level, schedule, credits, instructor, etc. Returns up to 20 results. For broad queries, encourage the user to narrow down.`,
  inputSchema: z.object({
    // ── Text search ──
    titleKeyword: z.string().optional().describe(
      "Keywords to search in course title (case-insensitive, substring match). Each word matched independently. Use actual substrings, not abbreviations."
    ),
    descriptionKeyword: z.string().optional().describe("Keywords to search in course description (case-insensitive, substring)."),
    courseNumber: z.string().optional().describe("Course number or partial, e.g. 'EN.601' or '601.226' or 'EN.601.226'."),

    // ── Department / school / level ──
    department: z.string().optional().describe("Department name or partial match, e.g. 'Computer Science'."),
    school: z.string().optional().describe("School name or partial match, e.g. 'Whiting' or 'Krieger'."),
    level: z.enum(["Lower Level Undergraduate", "Upper Level Undergraduate", "Graduate", "Graduate Independent Academic Work", "Independent Academic Work", "Doctoral"]).optional()
      .describe("Course level — use the exact value."),

    // ── Instructor ──
    instructor: z.string().optional().describe("Instructor name or partial match (searches full name field)."),

    // ── Schedule ──
    daysOfWeek: z.string().optional().describe("Day pattern prefix, e.g. 'MWF', 'TTh', 'MW', 'M', 'F'. Matches the EXACT day prefix of the meetings field."),
    timeOfDay: z.enum(["Morning", "Afternoon", "Evening", "Other"]).optional().describe("Time of day bucket."),

    // ── Logistics ──
    credits: z.string().optional().describe("Credit amount, e.g. '3.00'. Matches exact or ranges containing this value."),
    minCredits: z.number().optional().describe("Minimum credits (inclusive). Use for 'at least N credits'."),
    maxCredits: z.number().optional().describe("Maximum credits (inclusive). Use for 'at most N credits'."),
    status: z.enum(["Open", "Closed", "Waitlist Only", "Canceled", "Approval Required", "Reserved Open"]).optional()
      .describe("Course status — use exact value."),
    instructionMethod: z.enum(["in-person", "online", "blended"]).optional().describe("Instruction method."),
    writingIntensive: z.boolean().optional().describe("If true, only return writing intensive courses."),
    areas: z.string().optional().describe("Distribution area keyword, e.g. 'Science and Data', 'Ethics', 'Writing and Communication'."),
    building: z.string().optional().describe("Building name or partial match, e.g. 'Hodson', 'Krieger', 'Shaffer'."),

    // ── Seats ──
    hasOpenSeats: z.boolean().optional().describe("If true, only courses with open seats > 0. If false, only full courses."),

    // ── Prerequisites ──
    hasPrerequisites: z.boolean().optional().describe("If true, only courses with prerequisites. If false, only without."),
    prerequisiteKeyword: z.string().optional().describe("Find courses that require a specific prerequisite. Accepts a course code (EN.601.226) or name (data structures)."),

    // ── Evaluation filters ──
    hasEvaluations: z.boolean().optional().describe("If true, only return courses with evaluation data."),
    minOverallQuality: z.number().optional().describe("Minimum overall quality rating (1-5)."),
    maxOverallQuality: z.number().optional().describe("Maximum overall quality rating (1-5). Use to find poorly-rated courses."),
    minInstructorEffectiveness: z.number().optional().describe("Minimum instructor effectiveness rating (1-5)."),
    minIntellectualChallenge: z.number().optional().describe("Minimum intellectual challenge rating (1-5). Use to find challenging courses."),
    maxIntellectualChallenge: z.number().optional().describe("Maximum intellectual challenge rating (1-5). Use to find less challenging courses."),
    minWorkload: z.number().optional().describe("Minimum workload rating (1-5, 1=much lighter, 5=much heavier). Use to find heavy-workload courses."),
    maxWorkload: z.number().optional().describe("Maximum workload rating (1-5). Use to find lighter courses."),
    minRespondents: z.number().optional().describe("Minimum total respondents across all semesters. Use for statistically significant evals (e.g. 50, 100)."),

    // ── Sorting ──
    sortBy: z.enum([
      "overall_quality", "workload", "num_respondents", "num_evaluations",
      "instructor_effectiveness", "intellectual_challenge", "feedback_usefulness",
      "credits", "open_seats", "title",
    ]).optional().describe("Sort results by this field."),
    sortOrder: z.enum(["asc", "desc"]).optional().describe("Sort direction. 'desc' for highest/most first."),

    // ── Pagination ──
    limit: z.number().optional().describe("Max results to return (default 20, max 50). Use higher limits when user wants comprehensive lists."),
    offset: z.number().optional().describe("Skip this many results. Use with limit for pagination (e.g. 'show me more' → offset: 20)."),
  }),
  execute: async (input) => {
    let query = supabase.from("courses").select(COURSE_COLUMNS);

    // Sort
    if (input.sortBy) {
      query = query.order(input.sortBy, { ascending: input.sortOrder === "asc", nullsFirst: false });
    } else {
      query = query.order("offering_name").order("section_name");
    }

    // Pagination
    const limit = Math.min(input.limit || 20, 50);
    const offset = input.offset || 0;
    query = query.range(offset, offset + limit - 1);

    // ── Text search ──
    if (input.titleKeyword) {
      for (const word of input.titleKeyword.split(/\s+/).filter(Boolean)) {
        query = query.ilike("title", `%${word}%`);
      }
    }
    if (input.descriptionKeyword) {
      for (const word of input.descriptionKeyword.split(/\s+/).filter(Boolean)) {
        query = query.ilike("description", `%${word}%`);
      }
    }
    if (input.courseNumber) query = query.ilike("offering_name", `%${input.courseNumber}%`);

    // ── Department / school / level ──
    if (input.department) query = query.ilike("department", `%${input.department}%`);
    if (input.school) query = query.ilike("school_name", `%${input.school}%`);
    if (input.level) query = query.eq("level", input.level);

    // ── Instructor ──
    if (input.instructor) {
      for (const word of input.instructor.split(/\s+/).filter(Boolean)) {
        query = query.ilike("instructors_full_name", `%${word}%`);
      }
    }

    // ── Schedule ──
    if (input.daysOfWeek) query = query.ilike("meetings", `${input.daysOfWeek} %`);
    if (input.timeOfDay) query = query.eq("time_of_day", input.timeOfDay);

    // ── Logistics ──
    if (input.credits) query = query.or(`credits.eq.${input.credits},credits.ilike.%${input.credits}%`);
    if (input.status) query = query.eq("status", input.status);
    if (input.writingIntensive) query = query.eq("is_writing_intensive", "Yes");
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }
    if (input.areas) query = query.ilike("areas", `%${input.areas}%`);
    if (input.building) query = query.ilike("building", `%${input.building}%`);

    // ── Seats ──
    if (input.hasOpenSeats === true) query = query.gt("open_seats", "0");
    else if (input.hasOpenSeats === false) query = query.eq("open_seats", "0");

    // ── Prerequisites ──
    if (input.hasPrerequisites === true) query = query.neq("prerequisites", "");
    else if (input.hasPrerequisites === false) query = query.or("prerequisites.eq.,prerequisites.is.null");

    // ── Evaluation filters ──
    if (input.hasEvaluations === true) query = query.not("overall_quality", "is", null);
    else if (input.hasEvaluations === false) query = query.is("overall_quality", null);
    if (input.minOverallQuality) query = query.gte("overall_quality", input.minOverallQuality);
    if (input.maxOverallQuality) query = query.lte("overall_quality", input.maxOverallQuality);
    if (input.minInstructorEffectiveness) query = query.gte("instructor_effectiveness", input.minInstructorEffectiveness);
    if (input.minIntellectualChallenge) query = query.gte("intellectual_challenge", input.minIntellectualChallenge);
    if (input.maxIntellectualChallenge) query = query.lte("intellectual_challenge", input.maxIntellectualChallenge);
    if (input.minWorkload) query = query.gte("workload", input.minWorkload);
    if (input.maxWorkload) query = query.lte("workload", input.maxWorkload);
    if (input.minRespondents) query = query.gte("num_respondents", input.minRespondents);

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

    const { data: rawRows, error } = await query;
    if (error) return { count: 0, courses: [], error: error.message };

    // Post-filter: credit ranges (can't do in Supabase since credits is TEXT with ranges like "1.00 - 3.00")
    let rows = rawRows || [];
    if (input.minCredits || input.maxCredits) {
      rows = rows.filter((r) => {
        const c = r.credits || "";
        const rangeMatch = c.match(/([\d.]+)\s*-\s*([\d.]+)/);
        const lo = rangeMatch ? parseFloat(rangeMatch[1]) : parseFloat(c);
        const hi = rangeMatch ? parseFloat(rangeMatch[2]) : lo;
        if (isNaN(lo)) return false;
        if (input.minCredits && hi < input.minCredits) return false;
        if (input.maxCredits && lo > input.maxCredits) return false;
        return true;
      });
    }

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
      // Resolve prereq codes to names
      let prereqs = row.prerequisites || "";
      if (prereqs && titleMap.size > 0) {
        const codes = [...new Set(prereqs.match(codePattern) || [])] as string[];
        for (const code of codes) {
          const name = titleMap.get(code);
          if (name) {
            prereqs = prereqs.replace(
              new RegExp(code.replace(/\./g, "\\."), "g"),
              `${code} (${name})`
            );
          }
        }
      }

      // Return trimmed result to keep tool output small for the model
      return {
        offering_name: row.offering_name,
        section_name: row.section_name,
        title: row.title,
        credits: row.credits,
        department: row.department,
        level: row.level,
        status: row.status,
        meetings: row.meetings,
        building: row.building,
        instructors_full_name: row.instructors_full_name,
        instruction_method: row.instruction_method,
        is_writing_intensive: row.is_writing_intensive,
        areas: row.areas || undefined,
        open_seats: row.open_seats,
        // Truncate long text fields
        description: row.description ? row.description.slice(0, 200) + (row.description.length > 200 ? "..." : "") : undefined,
        prerequisites: prereqs || undefined,
        // Eval data
        overall_quality: row.overall_quality,
        instructor_effectiveness: row.instructor_effectiveness,
        intellectual_challenge: row.intellectual_challenge,
        workload: row.workload,
        num_evaluations: row.num_evaluations,
        num_respondents: row.num_respondents,
      };
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
