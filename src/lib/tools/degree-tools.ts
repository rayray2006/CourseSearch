import { tool } from "ai";
import { z } from "zod";
import { supabase } from "../supabase";
import { getSessionId, getActiveTerm } from "./schedule-tools";
import { getDb } from "../db";

function getCourseLevel(code: string): number {
  const parts = code.split(".");
  return parseInt(parts[parts.length - 1]) || 0;
}

async function getScheduledCourses(sessionId: string) {
  const { data: scheduleRows } = await supabase
    .from("schedules")
    .select("offering_name, term")
    .eq("session_id", sessionId);

  if (!scheduleRows || scheduleRows.length === 0) return [];

  const codes = [...new Set(scheduleRows.map((r) => r.offering_name))];
  const { data: courseData } = await supabase
    .from("courses")
    .select("offering_name, title, credits, areas, is_writing_intensive, term")
    .in("offering_name", codes);

  const db = getDb();
  const posRows = db
    .prepare(`SELECT offering_name, pos_tags FROM courses WHERE offering_name IN (${codes.map(() => "?").join(",")}) AND pos_tags != '' GROUP BY offering_name`)
    .all(...codes) as { offering_name: string; pos_tags: string }[];
  const posMap = new Map(posRows.map((r) => [r.offering_name, r.pos_tags]));

  const seen = new Set<string>();
  return (courseData || []).filter((c) => {
    if (seen.has(c.offering_name)) return false;
    seen.add(c.offering_name);
    return true;
  }).map((c) => ({
    ...c,
    credits: parseFloat(c.credits) || 0,
    pos_tags: posMap.get(c.offering_name) || "",
  }));
}

export const checkDegreeProgress = tool({
  description:
    "Check the user's progress toward their degree requirements. Shows which requirements are complete, in progress, or incomplete. Use when the user asks 'how am I doing?', 'what do I still need?', 'am I on track?', etc.",
  inputSchema: z.object({
    programName: z.string().optional().describe("Specific program to check. If omitted, checks all selected programs."),
  }),
  execute: async ({ programName }) => {
    const db = getDb();

    let programs: string[];
    if (programName) {
      programs = [programName];
    } else {
      const rows = db.prepare("SELECT program_name FROM program_schemas WHERE visible = 1").all() as { program_name: string }[];
      programs = rows.map((r) => r.program_name);
    }

    const results: Record<string, unknown>[] = [];

    for (const prog of programs) {
      // Call the actual progress API internally — it has all the matching logic
      try {
        const url = `http://localhost:${process.env.PORT || 3000}/api/programs/progress?name=${encodeURIComponent(prog)}`;
        const res = await fetch(url, {
          headers: { Cookie: `schedule_session=${getSessionId()}` },
        });
        if (!res.ok) continue;
        const data = await res.json();

        // Extract summary from the full progress response
        function summarizeSections(sections: any[]): { name: string; status: string; progress: string; missing?: string }[] {
          const summaries: ReturnType<typeof summarizeSections> = [];
          for (const s of sections) {
            if (s.type === "reference_only" || s.type === "info_only") continue;

            let progress = "";
            let missing = "";
            if (s.credits_required) {
              progress = `${s.fulfilled || 0}/${s.credits_required}cr`;
              if (s.status !== "complete") missing = `Need ${s.credits_required - (s.fulfilled || 0)} more credits`;
            } else if (s.total) {
              progress = `${s.fulfilled || 0}/${s.total}`;
            }

            if (s.areas_covered && s.required_areas) {
              progress += ` (${s.areas_covered.length}/${s.required_areas} areas)`;
            }

            if (s.status !== "complete" && s.courses) {
              const unmatched = s.courses.filter((c: any) => {
                const mc = s.matched_courses || [];
                return !mc.some((m: any) => m.code === c.code || c.alternatives?.includes(m.code));
              });
              if (unmatched.length > 0) {
                missing = `Missing: ${unmatched.slice(0, 3).map((c: any) => c.code).join(", ")}`;
              }
            }

            summaries.push({ name: s.name, status: s.status || "incomplete", progress, missing });

            if (s.subsections) {
              for (const sub of s.subsections) {
                if (sub.type === "reference_only" || sub.type === "info_only") continue;
                let subProg = sub.credits_required ? `${sub.fulfilled || 0}/${sub.credits_required}cr` : `${sub.fulfilled || 0}/${sub.total || "?"}`;
                summaries.push({ name: `  ${sub.name}`, status: sub.status || "incomplete", progress: subProg });
              }
            }
          }
          return summaries;
        }

        const sectionSummaries = summarizeSections(data.sections || []);
        const complete = sectionSummaries.filter((s) => s.status === "complete").length;
        const incomplete = sectionSummaries.filter((s) => s.status !== "complete");

        results.push({
          program: prog,
          scheduledCourses: data.scheduledCount,
          totalCredits: data.totalScheduledCredits,
          sectionsComplete: complete,
          sectionsTotal: sectionSummaries.length,
          overallStatus: data.overallStatus,
          sections: sectionSummaries,
          remaining: incomplete.map((s) => `${s.name}: ${s.missing || s.progress}`),
        });
      } catch (e) {
        results.push({ program: prog, error: "Could not check progress" });
      }
    }

    return { programs: results };
  },
});

export const findCoursesForRequirement = tool({
  description:
    "Find courses that would fulfill a specific unfilled requirement. Use when the user asks 'what courses would satisfy my distribution?', 'what can I take for CSCI-APPL?', 'what H/S courses are available?', etc.",
  inputSchema: z.object({
    requirementType: z.enum(["pos_tag", "area", "prefix", "specific"]).describe("Type of requirement to search for"),
    value: z.string().describe("The POS tag (CSCI-APPL), area letter (H), course prefix (EN.601), or specific course code"),
    minLevel: z.number().optional().describe("Minimum course level (e.g., 300 for 300+ level)"),
    term: z.string().optional().describe("Term to search in. Defaults to active term."),
  }),
  execute: async ({ requirementType, value, minLevel, term }) => {
    const searchTerm = term || getActiveTerm();
    const db = getDb();

    let results: { offering_name: string; title: string; credits: string; meetings: string; pos_tags: string }[] = [];

    if (requirementType === "pos_tag") {
      // Find courses with this POS tag
      const rows = db.prepare(`
        SELECT DISTINCT c.offering_name, c.title, c.credits, c.meetings, c.pos_tags
        FROM courses c
        WHERE c.term = ? AND c.pos_tags LIKE ? AND c.status != 'Canceled'
        ORDER BY c.offering_name LIMIT 20
      `).all(searchTerm, `%${value}%`) as typeof results;
      results = rows;
    } else if (requirementType === "area") {
      // Find courses with this area designation
      const rows = db.prepare(`
        SELECT DISTINCT c.offering_name, c.title, c.credits, c.meetings, c.pos_tags
        FROM courses c
        WHERE c.term = ? AND (c.areas LIKE ? OR c.areas LIKE ?) AND c.status != 'Canceled'
        ORDER BY c.offering_name LIMIT 20
      `).all(searchTerm, `%${value},%`, `%,${value}%`) as typeof results;
      // Also check standalone area letter
      const rows2 = db.prepare(`
        SELECT DISTINCT c.offering_name, c.title, c.credits, c.meetings, c.pos_tags
        FROM courses c
        WHERE c.term = ? AND c.areas LIKE ? AND c.status != 'Canceled'
        ORDER BY c.offering_name LIMIT 20
      `).all(searchTerm, `%${value}%`) as typeof results;
      const seen = new Set(results.map((r) => r.offering_name));
      for (const r of rows2) {
        if (!seen.has(r.offering_name)) results.push(r);
      }
    } else if (requirementType === "prefix") {
      const rows = db.prepare(`
        SELECT DISTINCT c.offering_name, c.title, c.credits, c.meetings, c.pos_tags
        FROM courses c
        WHERE c.term = ? AND c.offering_name LIKE ? AND c.status != 'Canceled'
        ORDER BY c.offering_name LIMIT 20
      `).all(searchTerm, `${value}%`) as typeof results;
      results = rows;
    }

    // Apply level filter
    if (minLevel) {
      results = results.filter((r) => getCourseLevel(r.offering_name) >= minLevel);
    }

    return {
      count: results.length,
      term: searchTerm,
      courses: results.slice(0, 15).map((r) => ({
        code: r.offering_name,
        title: r.title,
        credits: r.credits,
        meetings: r.meetings,
        pos_tags: r.pos_tags,
      })),
    };
  },
});

export const getAvailablePrograms = tool({
  description:
    "List available degree programs that have requirement schemas. Use when the user asks 'what programs are available?', 'what majors can I track?', etc.",
  inputSchema: z.object({}),
  execute: async () => {
    const db = getDb();
    const rows = db.prepare("SELECT program_name, school FROM program_schemas WHERE visible = 1 ORDER BY program_name").all() as { program_name: string; school: string }[];
    return { programs: rows };
  },
});
