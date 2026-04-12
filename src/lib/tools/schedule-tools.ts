import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";

// Session ID is passed via a global that the API route sets before each request
let _sessionId = "default";
export function setSessionId(id: string) { _sessionId = id; }
export function getSessionId() { return _sessionId; }

// --- Time parsing helpers ---
// Dynamically parse day strings instead of hardcoded map
// "MWF" -> ["M","W","F"], "TTh" -> ["T","Th"], "MTWThF" -> ["M","T","W","Th","F"]
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
  description: "Add a course to the user's schedule.",
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
      .limit(1)
      .single();

    if (!course) return { success: false, message: `Course ${offering_name} section ${section_name} not found.` };

    const { error } = await supabase.from("schedules").upsert(
      { session_id: _sessionId, offering_name, section_name },
      { onConflict: "session_id,offering_name,section_name" }
    );

    if (error) return { success: false, message: error.message };
    return { success: true, message: `Added ${offering_name} (${course.title}) section ${section_name} to your schedule.` };
  },
});

export const removeCourseFromSchedule = tool({
  description: "Remove a course from the user's schedule.",
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
      .eq("section_name", section_name);

    if (count === 0) return { success: false, message: `${offering_name} section ${section_name} is not in your schedule.` };
    return { success: true, message: `Removed ${offering_name} section ${section_name} from your schedule.` };
  },
});

export const viewSchedule = tool({
  description: "View all courses currently in the user's schedule.",
  inputSchema: z.object({}),
  execute: async () => {
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId);

    if (!scheduleRows || scheduleRows.length === 0) return { courses: [], message: "Your schedule is empty." };

    const orFilter = scheduleRows
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");

    const { data: courses } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, instructors_full_name")
      .or(orFilter);

    const totalCredits = (courses || []).reduce((sum, c) => {
      const n = parseFloat(c.credits);
      return sum + (isNaN(n) ? 0 : n);
    }, 0);

    return { courses: courses || [], totalCredits, count: (courses || []).length };
  },
});

export const clearMySchedule = tool({
  description: "Clear all courses from the user's schedule. Ask for confirmation first.",
  inputSchema: z.object({}),
  execute: async () => {
    await supabase.from("schedules").delete().eq("session_id", _sessionId);
    return { success: true, message: "Schedule cleared." };
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
    limit: z.number().optional().describe("Max results (default 20, max 50)"),
    ignoreCourses: z
      .array(z.string())
      .optional()
      .describe(
        "Course offering_names to IGNORE from the schedule when checking conflicts. Use for hypothetical questions like 'what if I dropped EN.601.433' — pass ['EN.601.433'] to exclude it from conflict checking without actually removing it."
      ),
    extraMeetings: z
      .array(z.string())
      .optional()
      .describe(
        "Extra meeting times to treat as busy (in addition to the schedule). Format: 'TTh 1:30PM - 2:45PM'. Use for hypothetical questions like 'what fits if I also have a meeting TTh 3-4'."
      ),
  }),
  execute: async (input) => {
    // 1. Get user's current schedule
    const { data: scheduleRows } = await supabase
      .from("schedules")
      .select("offering_name, section_name")
      .eq("session_id", _sessionId);

    if (!scheduleRows || scheduleRows.length === 0) {
      return { error: "Your schedule is empty. Add courses first, then search for non-conflicting ones." };
    }

    // Get meeting times for scheduled courses
    const orFilter = scheduleRows
      .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
      .join(",");
    const { data: scheduledCourses } = await supabase
      .from("courses")
      .select("offering_name, meetings")
      .or(orFilter);

    const ignoreCodes = new Set(input.ignoreCourses || []);
    const scheduledMeetings = (scheduledCourses || [])
      .filter((c) => !ignoreCodes.has(c.offering_name))
      .map((c) => c.meetings)
      .filter(Boolean) as string[];

    // Add any extra hypothetical busy times
    if (input.extraMeetings) {
      scheduledMeetings.push(...input.extraMeetings);
    }

    const scheduledCodes = new Set(
      scheduleRows
        .filter((r) => !ignoreCodes.has(r.offering_name))
        .map((r) => r.offering_name)
    );

    // 2. Search for candidate courses
    let query = supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, department, level, status, meetings, instructors_full_name, instruction_method, overall_quality, workload, is_writing_intensive, areas")
      .neq("status", "Canceled")
      .neq("meetings", "")
      .order("offering_name")
      .order("section_name")
      .limit(200); // fetch more to filter client-side

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
    if (input.instructionMethod) {
      const m = input.instructionMethod.toLowerCase();
      if (m === "in-person") query = query.or("instruction_method.ilike.%in-person%,instruction_method.ilike.lecture");
      else if (m === "online") query = query.or("instruction_method.ilike.%on-line%,instruction_method.ilike.%online%");
      else if (m === "blended") query = query.ilike("instruction_method", "%blended%");
    }

    const { data: candidates } = await query;
    if (!candidates || candidates.length === 0) return { count: 0, courses: [] };

    // 3. Filter out conflicts and already-scheduled courses
    const maxResults = Math.min(input.limit || 20, 50);
    const nonConflicting = candidates.filter((course) => {
      if (scheduledCodes.has(course.offering_name)) return false;
      if (!course.meetings) return false;
      return !scheduledMeetings.some((sm) => hasConflict(sm, course.meetings));
    }).slice(0, maxResults);

    return {
      count: nonConflicting.length,
      scheduledCount: scheduleRows.length,
      courses: nonConflicting,
    };
  },
});
