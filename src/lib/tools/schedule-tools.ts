import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";

// Session ID is passed via a global that the API route sets before each request
let _sessionId = "default";
export function setSessionId(id: string) { _sessionId = id; }
export function getSessionId() { return _sessionId; }

export const addCourseToSchedule = tool({
  description:
    "Add a course to the user's schedule. Use the exact offering_name and section_name from search results.",
  inputSchema: z.object({
    offering_name: z.string().describe("Course offering name, e.g. 'EN.601.226'"),
    section_name: z.string().describe("Section number, e.g. '01'"),
  }),
  execute: async ({ offering_name, section_name }) => {
    // Verify course exists
    const { data: course } = await supabase
      .from("courses")
      .select("offering_name, title")
      .eq("offering_name", offering_name)
      .eq("section_name", section_name)
      .limit(1)
      .single();

    if (!course) {
      return { success: false, message: `Course ${offering_name} section ${section_name} not found.` };
    }

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
    const { error, count } = await supabase
      .from("schedules")
      .delete()
      .eq("session_id", _sessionId)
      .eq("offering_name", offering_name)
      .eq("section_name", section_name);

    if (error) return { success: false, message: error.message };
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

    if (!scheduleRows || scheduleRows.length === 0) {
      return { courses: [], message: "Your schedule is empty." };
    }

    // Fetch full course details for each scheduled course
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
