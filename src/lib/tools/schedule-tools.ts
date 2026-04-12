import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";

// Session ID is passed via a global that the API route sets before each request
let _sessionId = "default";
export function setSessionId(id: string) { _sessionId = id; }
export function getSessionId() { return _sessionId; }

// Active term for this request
let _activeTerm = "Fall 2026";
export function setActiveTerm(term: string) { _activeTerm = term; }
export function getActiveTerm() { return _activeTerm; }

// --- Time parsing helpers ---
function expandDays(dayStr: string): string[] {
  const days: string[] = [];
  let i = 0;
  while (i < dayStr.length) {
    if (dayStr[i] === "T" && dayStr[i + 1] === "h") {
      days.push("Th");
      i += 2;
    } else if (dayStr[i] === "S" && dayStr[i + 1] === "a") {
      days.push("Sa");
      i += 2;
    } else if (dayStr[i] === "S" && dayStr[i + 1] !== "a") {
      days.push("S");
      i += 1;
    } else {
      days.push(dayStr[i]);
      i += 1;
    }
  }
  return days;
}

function parseMeetingTime(meetings: string): { days: string[]; startMin: number; endMin: number }[] {
  if (!meetings) return [];
  return meetings.split(",").map((part) => {
    const match = part.trim().match(/^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)$/);
    if (!match) return null;
    const [, dayStr, sh, sm, sap, eh, em, eap] = match;
    let startH = parseInt(sh);
    if (sap === "PM" && startH !== 12) startH += 12;
    if (sap === "AM" && startH === 12) startH = 0;
    let endH = parseInt(eh);
    if (eap === "PM" && endH !== 12) endH += 12;
    if (eap === "AM" && endH === 12) endH = 0;
    return { days: expandDays(dayStr), startMin: startH * 60 + parseInt(sm), endMin: endH * 60 + parseInt(em) };
  }).filter((b): b is NonNullable<typeof b> => b !== null);
}

function hasConflict(meetingsA: string, meetingsB: string): boolean {
  const blocksA = parseMeetingTime(meetingsA);
  const blocksB = parseMeetingTime(meetingsB);
  for (const a of blocksA) {
    for (const b of blocksB) {
      if (a.days.some((d) => b.days.includes(d)) && a.startMin < b.endMin && a.endMin > b.startMin) {
        return true;
      }
    }
  }
  return false;
}

export const addCourseToSchedule = tool({
  description: "Add a course to the user's schedule for the current semester.",
  inputSchema: z.object({
    offering_name: z.string().describe("Course offering name, e.g. 'EN.601.226'"),
    section_name: z.string().describe("Section number, e.g. '01'"),
  }),
  execute: async ({ offering_name, section_name }) => {
    const { data: course } = await supabase
      .from("courses")
      .select("offering_name, title")
      .eq("offering_name", offering_name)
      .eq("section_name", section_name)
      .eq("term", _activeTerm)
      .limit(1)
      .single();

    if (!course) return { success: false, message: `Course ${offering_name} section ${section_name} not found in ${_activeTerm}.` };

    const { error } = await supabase.from("schedules").upsert(
      { session_id: _sessionId, offering_name, section_name, term: _activeTerm },
      { onConflict: "session_id,offering_name,section_name,term" }
    );

    if (error) return { success: false, message: error.message };
    return { success: true, message: `Added ${offering_name} (${course.title}) section ${section_name} to your ${_activeTerm} schedule.` };
  },
});

export const removeCourseFromSchedule = tool({
  description: "Remove a course from the user's schedule for the current semester.",
  inputSchema: z.object({
    offering_name: z.string().describe("Course offering name"),
    section_name: z.string().describe("Section number"),
  }),
  execute: async ({ offering_name, section_name }) => {
    const { count } = await supabase
      .from("schedules")
      .delete()
      .eq("session_id", _sessionId)
      .eq("offering_name", offering_name)
      .eq("section_name", section_name)
      .eq("term", _activeTerm);

    if (count === 0) return { success: false, message: `${offering_name} section ${section_name} is not in your ${_activeTerm} schedule.` };
    return { success: true, message: `Removed ${offering_name} section ${section_name} from your ${_activeTerm} schedule.` };
  },
});

export const viewSchedule = tool({
  description: "View all courses currently in the user's schedule for the current semester.",
  inputSchema: z.object({}),
  execute: async () => {
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId)
      .eq("term", _activeTerm);

    if (!scheduleRows || scheduleRows.length === 0) return { courses: [], message: `Your ${_activeTerm} schedule is empty.` };

    const orFilter = scheduleRows
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");

    const { data: courses } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, instructors_full_name")
      .eq("term", _activeTerm)
      .or(orFilter);

    const totalCredits = (courses || []).reduce((sum, c) => {
      const n = parseFloat(c.credits);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);

    return { courses: courses || [], totalCredits, count: (courses || []).length, term: _activeTerm };
  },
});

export const clearMySchedule = tool({
  description: "Clear all courses from the user's schedule for the current semester. Ask for confirmation first.",
  inputSchema: z.object({}),
  execute: async () => {
    await supabase.from("schedules").delete().eq("session_id", _sessionId).eq("term", _activeTerm);
    return { success: true, message: `${_activeTerm} schedule cleared.` };
  },
});

export const findNonConflictingCourses = tool({
  description:
    "Find courses that DON'T conflict with the user's current schedule. Use for 'what fits in my schedule', 'courses without conflicts', etc. Supports hypothetical scenarios via ignoreCourses and extraMeetings.",
  inputSchema: z.object({
    department: z.string().optional().describe("Filter by department, e.g. 'Computer Science'"),
    level: z
      .enum(["Lower Level Undergraduate", "Upper Level Undergraduate", "Graduate"])
      .optional()
      .describe("Course level filter"),
    titleKeyword: z.string().optional().describe("Keywords in course title"),
    descriptionKeyword: z.string().optional().describe("Keywords in course description"),
    writingIntensive: z.boolean().optional().describe("If true, only writing intensive courses"),
    areas: z.string().optional().describe("Distribution area keyword, e.g. 'Science and Data', 'Ethics'"),
    status: z.enum(["Open", "Closed", "Waitlist Only", "Approval Required"]).optional().describe("Course status"),
    instructionMethod: z.enum(["in-person", "online", "blended"]).optional().describe("Instruction method"),
    credits: z.string().optional().describe("Credit amount, e.g. '3.00'"),
    daysOfWeek: z.string().optional().describe("Day pattern, e.g. 'MWF', 'TTh'. Only courses on these exact days."),
    timeOfDay: z.enum(["Morning", "Afternoon", "Evening", "Other"]).optional().describe("Time of day bucket."),
    beforeTime: z.string().optional().describe("Only courses that END before this time, e.g. '12:00PM', '3:00PM'."),
    afterTime: z.string().optional().describe("Only courses that START at or after this time, e.g. '12:00PM', '5:00PM'."),
    limit: z.number().optional().describe("Max results (default 20, max 50)"),
    ignoreCourses: z
      .array(z.string())
      .optional()
      .describe(
        "Course offering_names to IGNORE from the schedule when checking conflicts. Use for hypothetical questions like 'what if I dropped EN.601.433'."
      ),
    extraMeetings: z
      .array(z.string())
      .optional()
      .describe(
        "Extra meeting times to treat as busy. Format: 'TTh 1:30PM - 2:45PM'."
      ),
  }),
  execute: async (input) => {
    // 1. Get user's current schedule for this term
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId)
      .eq("term", _activeTerm);

    if (!scheduleRows || scheduleRows.length === 0) {
      return { error: "Your schedule is empty. Add courses first, then search for non-conflicting ones." };
    }

    const orFilter = scheduleRows
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");
    const { data: scheduledCourses } = await supabase
      .from("courses")
      .select("offering_name, meetings")
      .eq("term", _activeTerm)
      .or(orFilter);

    const ignoreCodes = new Set(input.ignoreCourses || []);
    const scheduledMeetings = (scheduledCourses || [])
      .filter((c) => !ignoreCodes.has(c.offering_name))
      .map((c) => c.meetings)
      .filter(Boolean) as string[];

    if (input.extraMeetings) {
      scheduledMeetings.push(...input.extraMeetings);
    }

    const scheduledCodes = new Set(
      scheduleRows
        .filter((r) => !ignoreCodes.has(r.offering_name))
        .map((r) => r.offering_name)
    );

    // 2. Search for candidate courses in current term
    let query = supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, department, level, status, meetings, instructors_full_name, instruction_method, overall_quality, workload, is_writing_intensive, areas")
      .eq("term", _activeTerm)
      .neq("status", "Canceled")
      .neq("meetings", "")
      .order("offering_name")
      .order("section_name")
      .limit(200);

    if (input.department) query = query.or(`all_departments.ilike.%${input.department}%,department.ilike.%${input.department}%`);
    if (input.level) query = query.eq("level", input.level);
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
    if (input.writingIntensive) query = query.eq("is_writing_intensive", "Yes");
    if (input.areas) query = query.ilike("areas", `%${input.areas}%`);
    if (input.status) query = query.eq("status", input.status);
    if (input.credits) query = query.or(`credits.eq.${input.credits},credits.ilike.%${input.credits}%`);
    if (input.daysOfWeek) query = query.ilike("meetings", `${input.daysOfWeek} %`);
    if (input.timeOfDay) query = query.eq("time_of_day", input.timeOfDay);
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }

    const { data: candidates } = await query;
    if (!candidates || candidates.length === 0) return { count: 0, courses: [] };

    function parseTimeToMin(t: string): number | null {
      const m = t.match(/^(\d{1,2}):(\d{2})(AM|PM)$/);
      if (!m) return null;
      let h = parseInt(m[1]);
      if (m[3] === "PM" && h !== 12) h += 12;
      if (m[3] === "AM" && h === 12) h = 0;
      return h * 60 + parseInt(m[2]);
    }
    const beforeMin = input.beforeTime ? parseTimeToMin(input.beforeTime) : null;
    const afterMin = input.afterTime ? parseTimeToMin(input.afterTime) : null;

    // 3. Filter out conflicts
    const maxResults = Math.min(input.limit || 20, 50);
    const nonConflicting = candidates.filter((course) => {
      if (scheduledCodes.has(course.offering_name)) return false;
      if (!course.meetings) return false;
      if (scheduledMeetings.some((sm) => hasConflict(sm, course.meetings))) return false;

      if (beforeMin !== null || afterMin !== null) {
        const blocks = parseMeetingTime(course.meetings);
        if (blocks.length === 0) return false;
        for (const b of blocks) {
          if (beforeMin !== null && b.endMin > beforeMin) return false;
          if (afterMin !== null && b.startMin < afterMin) return false;
        }
      }

      return true;
    }).slice(0, maxResults);

    return {
      count: nonConflicting.length,
      scheduledCount: scheduleRows.length,
      courses: nonConflicting,
    };
  },
});
