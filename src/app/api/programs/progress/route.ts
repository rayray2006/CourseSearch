import { supabase } from "@/lib/supabase";
import { getDb } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";
import { cookies } from "next/headers";

interface ScheduledCourse {
  offering_name: string;
  term: string;
  title: string;
  credits: number;
  areas: string;
  pos_tags: string;
  is_writing_intensive: string;
}

interface CourseRef { code: string; alternatives?: string[] }

interface Section {
  name: string;
  description?: string;
  type: "all" | "choose_one" | "choose_n" | "credit_min" | "reference_only" | "info_only";
  n?: number;
  credits_required?: number;
  exclusive?: boolean;
  courses?: CourseRef[];
  pos_tags?: string[];
  area_tags?: string[];
  course_prefixes?: string[];  // e.g., ["EN.601"] — match any course starting with this
  min_course_level?: number;   // e.g., 300 — only match courses where the last 3 digits >= this
  match_all?: boolean;          // true = match ALL scheduled courses (for total credit reqs)
  min_subsections_complete?: number; // e.g., 4 — require N subsections to be complete
  required_areas?: number;     // e.g., 4 — need courses in N distinct POS tag areas
  area_labels?: string[];      // the POS tags that count as distinct areas
  // Added by evaluator
  areas_covered?: string[];    // which POS tag areas have matching courses
  placeholders?: string[];
  subsections?: Section[];
  is_chooseable_group?: boolean;
  // Progress fields added by evaluation
  status?: "complete" | "in_progress" | "incomplete";
  fulfilled?: number;
  total?: number;
  matched_courses?: { code: string; title: string; term: string; credits: number; matched_by: string }[];
}

function getCourseLevel(code: string): number {
  // EN.601.433 → 433, AS.110.302 → 302
  const parts = code.split(".");
  return parseInt(parts[parts.length - 1]) || 0;
}

function evaluateSection(section: Section, scheduled: ScheduledCourse[], usedCodes: Set<string>): void {
  if (section.type === "reference_only") {
    section.status = "complete";
    return;
  }
  if (section.type === "info_only") {
    // Still evaluate subsections for progress tracking
    if (section.subsections) {
      for (const sub of section.subsections) evaluateSection(sub, scheduled, usedCodes);
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      section.status = subComplete === section.subsections.length ? "complete" : subComplete > 0 ? "in_progress" : "incomplete";
      section.fulfilled = subComplete;
      section.total = section.subsections.length;
    } else {
      section.status = "complete";
    }
    return;
  }

  // Handle "N of M subsections must be complete" (e.g., 4 of 5 sub-areas)
  if ((section.type === "choose_n" || section.type === "all") && section.subsections && section.subsections.length > 0 && !section.courses?.length) {
    for (const sub of section.subsections) evaluateSection(sub, scheduled, usedCodes);
    const subComplete = section.subsections.filter((s) => s.status === "complete").length;
    const needed = section.type === "choose_n" ? (section.n || 1) : section.subsections.length;
    section.fulfilled = subComplete;
    section.total = needed;
    section.status = subComplete >= needed ? "complete" : subComplete > 0 ? "in_progress" : "incomplete";
    return;
  }

  // Handle chooseable groups (pick ONE subsection)
  if (section.is_chooseable_group && section.subsections) {
    // Evaluate each subsection independently (each is a possible track)
    let bestSub: Section | null = null;
    let bestCredits = 0;
    for (const sub of section.subsections) {
      const subUsed = new Set(usedCodes);
      evaluateSection(sub, scheduled, subUsed);
      // Sum credits from matched courses across all sub-subsections
      let subCredits = (sub.matched_courses || []).reduce((s, m) => s + m.credits, 0);
      if (sub.subsections) {
        for (const ss of sub.subsections) {
          subCredits += (ss.matched_courses || []).reduce((s, m) => s + m.credits, 0);
        }
      }
      if (subCredits > bestCredits) { bestCredits = subCredits; bestSub = sub; }
    }
    // Mark the best subsection and aggregate
    const needed = section.credits_required || 0;
    section.status = bestSub?.status === "complete" || bestCredits >= needed
      ? "complete" : bestCredits > 0 ? "in_progress" : "incomplete";
    section.matched_courses = bestSub?.matched_courses || [];
    section.fulfilled = Math.min(bestCredits, needed);
    section.total = needed || 1;
    return;
  }

  // Collect all matching courses
  const matches: ScheduledCourse[] = [];
  const matchReasons = new Map<string, string>(); // code → reason

  // Always filter out codes used by exclusive sections — but non-exclusive sections don't ADD to usedCodes
  const addsToUsed = section.exclusive;

  // Match by specific course codes
  if (section.courses) {
    for (const ref of section.courses) {
      const allCodes = [ref.code, ...(ref.alternatives || [])];
      for (const code of allCodes) {
        const course = scheduled.find((s) => s.offering_name === code && !usedCodes.has(s.offering_name));
        if (course) {
          matches.push(course);
          matchReasons.set(course.offering_name, `Required: ${ref.code}`);
          if (section.exclusive) usedCodes.add(course.offering_name);
          break;
        }
      }
    }
  }

  // Match by POS tags — also respects min_course_level
  const posMinLevel = section.min_course_level || 0;
  if (section.pos_tags) {
    for (const tag of section.pos_tags) {
      const tagMatches = scheduled.filter(
        (s) => s.pos_tags.split(",").includes(tag)
          && !usedCodes.has(s.offering_name)
          && !matches.some((m) => m.offering_name === s.offering_name)
          && (posMinLevel === 0 || getCourseLevel(s.offering_name) >= posMinLevel)
      );
      for (const course of tagMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `POS: ${tag}`);
        if (section.exclusive) usedCodes.add(course.offering_name);
      }
    }
  }

  // Match by course code prefixes (e.g., "EN.601" matches any EN.601.xxx)
  // Non-exclusive sections (total counters like CS Electives) bypass usedCodes
  if (section.course_prefixes) {
    const minLevel = section.min_course_level || 0;
    const checkUsed = addsToUsed; // only exclusive sections filter by usedCodes
    for (const prefix of section.course_prefixes) {
      const prefixMatches = scheduled.filter(
        (s) => s.offering_name.startsWith(prefix)
          && (!checkUsed || !usedCodes.has(s.offering_name))
          && !matches.some((m) => m.offering_name === s.offering_name)
          && (minLevel === 0 || getCourseLevel(s.offering_name) >= minLevel)
      );
      for (const course of prefixMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `Prefix: ${prefix}${minLevel ? ` (${minLevel}+)` : ""}`);
        if (section.exclusive) usedCodes.add(course.offering_name);
      }
    }
  }

  // Match ALL scheduled courses (for total credit requirements like free electives)
  // Bypasses usedCodes — total credit sections count everything regardless of exclusivity
  // Still respects min_course_level if set
  if (section.match_all) {
    const allMinLevel = section.min_course_level || 0;
    for (const course of scheduled) {
      if (!matches.some((m) => m.offering_name === course.offering_name)) {
        if (allMinLevel > 0 && getCourseLevel(course.offering_name) < allMinLevel) continue;
        matches.push(course);
        matchReasons.set(course.offering_name, "All courses");
      }
    }
  }

  // Match by area tags (H, S, N, E, W) — also handles combined tags like HE, QN, EN
  // Also applies min_course_level if set (e.g., Distribution 300+ level requirement)
  if (section.area_tags && !section.match_all) {
    const areaMinLevel = section.min_course_level || 0;
    for (const area of section.area_tags) {
      const areaMatches = scheduled.filter((s) => {
        if (usedCodes.has(s.offering_name) || matches.some((m) => m.offering_name === s.offering_name)) return false;
        if (areaMinLevel > 0 && getCourseLevel(s.offering_name) < areaMinLevel) return false;
        if (area === "W") return s.is_writing_intensive === "Yes";
        const parts = s.areas.split(",").map((a) => a.trim());
        return parts.some((p) => p === area || (p.length <= 3 && p.includes(area)));
      });
      for (const course of areaMatches) {
        matches.push(course);
        matchReasons.set(course.offering_name, `Area: ${area}`);
      }
    }
  }

  // Cap matched courses for choose_n — only count up to n
  const cappedMatches = (section.type === "choose_n" || section.type === "choose_one")
    ? matches.slice(0, section.n || 1)
    : matches;

  section.matched_courses = cappedMatches.map((m) => ({
    code: m.offering_name,
    title: m.title,
    term: m.term,
    credits: m.credits,
    matched_by: matchReasons.get(m.offering_name) || "",
  }));

  // Determine status based on type
  const matchedCredits = matches.reduce((sum, m) => sum + m.credits, 0);
  const courseGroupCount = section.courses?.length || 0;
  const matchedCourseCount = section.courses
    ? section.courses.filter((ref) => {
        const allCodes = [ref.code, ...(ref.alternatives || [])];
        return matches.some((m) => allCodes.includes(m.offering_name));
      }).length
    : 0;

  switch (section.type) {
    case "all":
      section.total = courseGroupCount;
      section.fulfilled = matchedCourseCount;
      section.status = matchedCourseCount >= courseGroupCount ? "complete" : matchedCourseCount > 0 ? "in_progress" : "incomplete";
      break;

    case "choose_one":
      section.total = 1;
      section.fulfilled = matches.length > 0 ? 1 : 0;
      section.status = matches.length > 0 ? "complete" : "incomplete";
      break;

    case "choose_n":
      section.total = section.n || 1;
      section.fulfilled = Math.min(matches.length, section.total);
      section.status = matches.length >= (section.n || 1) ? "complete" : matches.length > 0 ? "in_progress" : "incomplete";
      break;

    case "credit_min": {
      const needed = section.credits_required || 0;
      section.total = needed;
      section.fulfilled = Math.min(matchedCredits, needed || matchedCredits);
      if (needed > 0) {
        section.status = matchedCredits >= needed ? "complete" : matchedCredits > 0 ? "in_progress" : "incomplete";
      } else {
        // No specific credit target — just report what's matched
        section.status = matches.length > 0 ? "in_progress" : "incomplete";
      }
      break;
    }
  }

  // Compute area coverage if required_areas is set
  if (section.required_areas && section.area_labels) {
    const coveredAreas: string[] = [];
    for (const area of section.area_labels) {
      const hasCourse = matches.some((m) => m.pos_tags.split(",").includes(area));
      if (hasCourse) coveredAreas.push(area);
    }
    section.areas_covered = coveredAreas;
    // Downgrade status if not enough areas covered
    if (coveredAreas.length < section.required_areas && section.status === "complete") {
      section.status = "in_progress";
    }
  }

  // Recurse into subsections (non-chooseable)
  if (section.subsections && !section.is_chooseable_group) {
    for (const sub of section.subsections) {
      evaluateSection(sub, scheduled, usedCodes);
    }

    // Bubble up: add children's matched credits to parent's totals
    let childCredits = 0;
    let childFulfilled = 0;
    let childTotal = 0;
    for (const sub of section.subsections) {
      const subMatched = sub.matched_courses || [];
      childCredits += subMatched.reduce((s, m) => s + m.credits, 0);
      childFulfilled += sub.fulfilled || 0;
      childTotal += sub.total || 0;
      // Also recurse — sum sub-subsection credits
      if (sub.subsections) {
        for (const ss of sub.subsections) {
          childCredits += (ss.matched_courses || []).reduce((s, m) => s + m.credits, 0);
        }
      }
    }

    // For credit_min parents: sum own + children's credits toward the target
    if (section.type === "credit_min" && section.credits_required) {
      const ownCredits = (section.matched_courses || []).reduce((s, m) => s + m.credits, 0);
      const totalCredits = ownCredits + childCredits;
      section.fulfilled = Math.min(totalCredits, section.credits_required);
      section.total = section.credits_required;
      section.status = totalCredits >= section.credits_required ? "complete" : totalCredits > 0 ? "in_progress" : "incomplete";
    } else if (!section.courses?.length && section.subsections.length > 0) {
      // Parent with only children — aggregate their status
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      const subAny = section.subsections.filter((s) => s.status !== "incomplete").length;
      section.fulfilled = (section.fulfilled || 0) + childFulfilled;
      section.total = (section.total || 0) + childTotal;
      if (subComplete === section.subsections.length && (section.status === "incomplete" || !section.status)) {
        section.status = "complete";
      } else if (subAny > 0 && section.status === "incomplete") {
        section.status = "in_progress";
      }
    }

    // min_subsections_complete: override status if not enough sub-areas covered
    // This MUST run after credit calculation so it can downgrade "complete" to "in_progress"
    if (section.min_subsections_complete) {
      const subComplete = section.subsections.filter((s) => s.status === "complete").length;
      const needed = section.min_subsections_complete;
      if (subComplete < needed && section.status === "complete") {
        section.status = "in_progress";
      }
    }
  }
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });

  // Other selected programs — used for cross-program double-count limits (pipe-separated)
  const otherPrograms = req.nextUrl.searchParams.get("others")?.split("|").filter(Boolean) || [];
  const maxShared = 2; // max courses that can count toward both undergrad + grad

  const db = getDb();

  // Check if we have a schema for this program
  const schemaRow = db
    .prepare("SELECT schema, program_url FROM program_schemas WHERE program_name = ?")
    .get(name) as { schema: string; program_url: string } | undefined;

  if (!schemaRow) {
    const baseUrl = req.nextUrl.origin;
    const res = await fetch(`${baseUrl}/api/programs?name=${encodeURIComponent(name)}`);
    return NextResponse.json(await res.json());
  }

  const schema = JSON.parse(schemaRow.schema) as { total_credits?: number; sections: Section[] };

  // Determine if this is a graduate program
  const isGrad = /Master|PhD|Doctoral|MSE|MS\b/i.test(name);
  const otherIsGrad = otherPrograms.some((p) => /Master|PhD|Doctoral|MSE|MS\b/i.test(p));

  // Get session
  const cookieStore = await cookies();
  const sessionId = cookieStore.get("schedule_session")?.value || "default";

  // Fetch ALL scheduled courses across all terms
  const { data: scheduleRows } = await supabase
    .from("schedules")
    .select("offering_name, term")
    .eq("session_id", sessionId);

  const scheduled: ScheduledCourse[] = [];
  if (scheduleRows && scheduleRows.length > 0) {
    const codes = [...new Set(scheduleRows.map((r) => r.offering_name))];
    const { data: courseData } = await supabase
      .from("courses")
      .select("offering_name, title, credits, areas, is_writing_intensive, term")
      .in("offering_name", codes);

    // Get POS tags from SQLite
    const posRows = db
      .prepare(`SELECT offering_name, pos_tags FROM courses WHERE offering_name IN (${codes.map(() => "?").join(",")}) AND pos_tags != '' GROUP BY offering_name`)
      .all(...codes) as { offering_name: string; pos_tags: string }[];
    const posMap = new Map(posRows.map((r) => [r.offering_name, r.pos_tags]));

    if (courseData) {
      const seen = new Set<string>();
      for (const c of courseData) {
        if (seen.has(c.offering_name)) continue;
        seen.add(c.offering_name);
        scheduled.push({
          offering_name: c.offering_name,
          term: c.term,
          title: c.title,
          credits: parseFloat(c.credits) || 0,
          areas: c.areas || "",
          pos_tags: posMap.get(c.offering_name) || "",
          is_writing_intensive: c.is_writing_intensive || "No",
        });
      }
    }
  }

  // Cross-program exclusivity: if mixing undergrad + grad, limit shared courses
  // Evaluate OTHER programs first to find which courses they claim
  let crossProgramExcluded = new Set<string>();
  let sharedCourses: string[] = [];

  if (otherPrograms.length > 0 && (isGrad !== otherIsGrad)) {
    // One is grad, one is undergrad — compute claimed courses from other programs
    const otherClaimed = new Set<string>();
    for (const otherName of otherPrograms) {
      const otherRow = db.prepare("SELECT schema FROM program_schemas WHERE program_name = ?").get(otherName) as { schema: string } | undefined;
      if (!otherRow) continue;
      const otherSchema = JSON.parse(otherRow.schema) as { sections: Section[] };
      const otherUsed = new Set<string>();
      for (const s of otherSchema.sections) evaluateSection(s, scheduled, otherUsed);
      // Collect all matched course codes from the other program
      function collectMatched(sections: Section[]): string[] {
        const codes: string[] = [];
        for (const s of sections) {
          if (s.matched_courses) codes.push(...s.matched_courses.map((m) => m.code));
          if (s.subsections) codes.push(...collectMatched(s.subsections));
        }
        return codes;
      }
      for (const code of collectMatched(otherSchema.sections)) otherClaimed.add(code);
    }

    // Find overlap with THIS program's potential courses
    const thisCodes = new Set(scheduled.map((s) => s.offering_name));
    const overlap = [...otherClaimed].filter((c) => thisCodes.has(c));

    if (overlap.length > maxShared) {
      // Prioritize sharing courses that are most valuable for THIS program
      // Score each overlapping course by how many of this program's sections it satisfies
      const scored = overlap.map((code) => {
        const course = scheduled.find((s) => s.offering_name === code);
        let score = 0;
        if (!course) return { code, score: 0 };
        // Higher score for courses matching POS tags or prefixes in this program's sections
        for (const sec of schema.sections) {
          if (sec.pos_tags?.some((tag) => course.pos_tags.split(",").includes(tag))) score += 3;
          if (sec.course_prefixes?.some((p) => code.startsWith(p))) score += 2;
          if (sec.courses?.some((c) => c.code === code || c.alternatives?.includes(code))) score += 5;
        }
        // Higher credits = more valuable to share
        score += course.credits;
        return { code, score };
      }).sort((a, b) => b.score - a.score);

      sharedCourses = scored.slice(0, maxShared).map((s) => s.code);
      const excluded = scored.slice(maxShared).map((s) => s.code);
      crossProgramExcluded = new Set(excluded);
    } else {
      sharedCourses = overlap;
    }
  }

  // Filter scheduled courses for cross-program exclusivity
  const effectiveScheduled = crossProgramExcluded.size > 0
    ? scheduled.filter((s) => !crossProgramExcluded.has(s.offering_name))
    : scheduled;

  // Evaluate each section
  const usedCodes = new Set<string>();
  for (const section of schema.sections) {
    evaluateSection(section, effectiveScheduled, usedCodes);
  }

  // Overall status
  const realSections = schema.sections.filter((s) => s.type !== "reference_only" && s.type !== "info_only");
  const allComplete = realSections.every((s) => s.status === "complete");
  const anyProgress = realSections.some((s) => s.status === "complete" || s.status === "in_progress");

  return NextResponse.json({
    program_name: name,
    url: schemaRow.program_url ? `https://e-catalogue.jhu.edu${schemaRow.program_url}` : null,
    total_credits: schema.total_credits,
    sections: schema.sections,
    crossProgram: crossProgramExcluded.size > 0 ? {
      sharedCourses,
      excludedCourses: [...crossProgramExcluded],
      maxShared,
      otherPrograms,
    } : undefined,
    scheduledCount: scheduled.length,
    totalScheduledCredits: scheduled.reduce((s, c) => s + c.credits, 0),
    overallStatus: allComplete ? "complete" : anyProgress ? "in_progress" : "incomplete",
    hasSchema: true,
  });
}
