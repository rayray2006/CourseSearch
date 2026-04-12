// @ts-nocheck
/**
 * Process program requirements through Gemini to produce clean, semantic JSON schemas.
 * Extracts text from e-catalogue HTML, sends to LLM, stores result.
 */
import { load } from "cheerio";
import { google } from "@ai-sdk/google";
import { generateObject } from "ai";
import { z } from "zod";
import Database from "better-sqlite3";
import path from "path";

const CATALOGUE_BASE = "https://e-catalogue.jhu.edu/archive/2024-25";
const db = new Database(path.join(process.cwd(), "courses.db"));

// Schema for the LLM output
const CourseRefSchema = z.object({
  code: z.string().describe("Course code like EN.601.226"),
  alternatives: z.array(z.string()).optional().describe("Alternative course codes (or-options)"),
});

const RequirementSectionSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    name: z.string().describe("Section name like 'Mathematics', 'Core CS', 'Upper-Level CS'"),
    description: z.string().optional().describe("Brief description of this requirement section"),
    type: z.enum(["all", "choose_one", "choose_n", "credit_min", "reference_only", "info_only"])
      .describe("all=every course required, choose_one=pick 1, choose_n=pick N, credit_min=reach N credits, reference_only=not a requirement just a list, info_only=description with no courses"),
    n: z.number().optional().describe("For choose_n: how many to pick"),
    credits_required: z.number().optional().describe("For credit_min: minimum credits needed"),
    exclusive: z.boolean().optional().describe("True if courses here can't also count toward sibling sections"),
    courses: z.array(CourseRefSchema).optional().describe("Specific required courses"),
    pos_tags: z.array(z.string()).optional().describe("POS tags like CSCI-APPL — any course with these tags counts"),
    area_tags: z.array(z.string()).optional().describe("Distribution area letters like H, S, N, E, W — courses with these areas count"),
    placeholders: z.array(z.string()).optional().describe("Non-course requirements like 'Free Electives to reach 120 credits'"),
    subsections: z.array(RequirementSectionSchema).optional().describe("Nested sub-requirements"),
    is_chooseable_group: z.boolean().optional().describe("True if student picks ONE subsection to complete (e.g., focus areas, tracks)"),
  })
);

const ProgramSchemaOutput = z.object({
  total_credits: z.number().optional().describe("Total credits required for the degree"),
  sections: z.array(RequirementSectionSchema).describe("Top-level requirement sections"),
});

function extractText(html: string): string {
  const $ = load(html);
  let container = $("[id*='requirementstextcontainer']").first();
  if (container.length === 0) container = $("#textcontainer");
  if (container.length === 0) return "";

  const output: string[] = [];

  container.children().each((_, el) => {
    const $el = $(el);
    const tag = el.tagName?.toLowerCase();

    if (tag === "h2" || tag === "h3") {
      const text = $el.text().trim();
      if (text) output.push(`\n${tag === "h2" ? "##" : "###"} ${text}`);
    } else if (tag === "table" && $el.hasClass("sc_courselist")) {
      $el.find("tr").each((_, tr) => {
        const $tr = $(tr);
        const isOr = $tr.hasClass("orclass");
        const codeLink = $tr.find("a.bubblelink.code").first();
        const comment = $tr.find("span.courselistcomment").text().trim();
        const credits = $tr.find("td.hourscol").text().trim();

        if (codeLink.length > 0) {
          const code = codeLink.attr("title") || codeLink.text().trim();
          const prefix = isOr ? "  or " : "  ";
          output.push(`${prefix}${code}${credits ? ` (${credits}cr)` : ""}`);
        } else if (comment && !["Code", "Title", "Credits", "Total Credits"].includes(comment)) {
          output.push(`  NOTE: ${comment}${credits ? ` (${credits}cr)` : ""}`);
        }
      });
    } else if (tag === "p") {
      const text = $el.text().trim().replace(/\s+/g, " ");
      if (text && text.length > 20 && !text.startsWith("Print") && !text.startsWith("©")) {
        output.push(`  > ${text.slice(0, 400)}`);
      }
    }
  });

  return output.join("\n");
}

const SYSTEM_PROMPT = `You are an expert at parsing university degree requirements. Given raw text extracted from a JHU e-catalogue program page, produce a clean structured JSON describing what a student needs to complete this degree.

CRITICAL RULES:
1. TYPES: Use "all" when EVERY listed course is required. Use "choose_one" when student picks ONE from a list. Use "choose_n" when student picks N courses. Use "credit_min" when student needs to reach N credits from a pool. Use "reference_only" for lists that are just informational (like "Group 1: Non-Departmental Courses" which lists courses that CAN count but aren't requirements). Use "info_only" for sections with just descriptive text.

2. ALTERNATIVES: When courses have "or" options, put them as alternatives: {code: "EN.500.112", alternatives: ["EN.500.113", "EN.500.114"]}. The student takes ONE from the group.

3. EXCLUSIVE SECTIONS: When a parent section says "12 credits" split across sub-requirements (like 6 from classification areas + 6 from any area), mark sub-sections as exclusive:true. A course satisfying one sub-section CANNOT also satisfy another.

4. POS TAGS: Requirements like "courses with POS Tag CSCI-APPL" should use pos_tags: ["CSCI-APPL"]. Don't list specific courses for POS tag requirements — just the tags.

5. DISTRIBUTION: "Six Humanities (H) or Social Sciences (S) courses (18cr)" → type: "credit_min", credits_required: 18, area_tags: ["H", "S"]

6. WRITING INTENSIVE: "Two Writing Intensive (W) courses" → type: "choose_n", n: 2, area_tags: ["W"]

7. FOCUS AREAS / TRACKS: When there are multiple focus areas and the student picks ONE, use is_chooseable_group: true with subsections for each focus area.

8. ELECTIVES: "Free Electives to reach 120 credits" → type: "credit_min", credits_required: 120, placeholders: ["Free electives to reach total degree credits"]

9. PARENT LABELS: Section headings like "COMPUTER SCIENCE" that just describe sub-sections (Core, Foundations, Upper-Level, etc.) should be type: "info_only" with a description. The actual requirements are in the sub-sections.

10. Don't include grade requirements, academic policies, or honor system info — just what courses/credits are needed.`;

async function processProgram(programName: string, url: string, school: string): Promise<boolean> {
  try {
    const fullUrl = url.startsWith("http") ? url : `https://e-catalogue.jhu.edu${url}`;
    const res = await fetch(fullUrl);
    if (!res.ok) return false;

    const html = await res.text();
    const text = extractText(html);
    if (text.length < 100) return false;

    const { object: schema } = await generateObject({
      model: google("gemini-2.5-flash"),
      schema: ProgramSchemaOutput,
      system: SYSTEM_PROMPT,
      prompt: `Parse the following degree requirements for "${programName}":\n\n${text}`,
      maxRetries: 5,
    });

    // Enrich with course titles
    const titleMap = new Map<string, string>();
    function collectCodes(sections: any[]): string[] {
      const codes: string[] = [];
      for (const s of sections) {
        if (s.courses) for (const c of s.courses) { codes.push(c.code); if (c.alternatives) codes.push(...c.alternatives); }
        if (s.subsections) codes.push(...collectCodes(s.subsections));
      }
      return codes;
    }
    const allCodes = [...new Set(collectCodes(schema.sections))];
    if (allCodes.length > 0) {
      const rows = db.prepare(`SELECT DISTINCT offering_name, title FROM courses WHERE offering_name IN (${allCodes.map(() => "?").join(",")}) GROUP BY offering_name`).all(...allCodes) as any[];
      for (const r of rows) titleMap.set(r.offering_name, r.title);
      // Also catalogue
      const missing = allCodes.filter((c) => !titleMap.has(c));
      if (missing.length > 0) {
        const catRows = db.prepare(`SELECT offering_name, title FROM catalogue WHERE offering_name IN (${missing.map(() => "?").join(",")}) GROUP BY offering_name`).all(...missing) as any[];
        for (const r of catRows) titleMap.set(r.offering_name, r.title);
      }
    }
    function enrichTitles(sections: any[]) {
      for (const s of sections) {
        if (s.courses) for (const c of s.courses) {
          c.title = titleMap.get(c.code) || "";
          if (c.alternatives) c.alt_titles = c.alternatives.map((a: string) => titleMap.get(a) || "");
        }
        if (s.subsections) enrichTitles(s.subsections);
      }
    }
    enrichTitles(schema.sections);

    db.prepare(
      `INSERT OR REPLACE INTO program_schemas (program_name, program_url, school, schema, raw_text)
       VALUES (?, ?, ?, ?, ?)`
    ).run(programName, url, school, JSON.stringify(schema), text);

    return true;
  } catch (err: any) {
    console.error(`  Error: ${err.message?.slice(0, 100)}`);
    return false;
  }
}

async function main() {
  const specificProgram = process.argv[2];

  if (specificProgram) {
    // Process a single program
    const row = db.prepare("SELECT DISTINCT program_name, program_url, school FROM program_tags WHERE program_name LIKE ?").get(`%${specificProgram}%`) as any;
    if (!row) {
      console.error(`Program not found: ${specificProgram}`);
      process.exit(1);
    }
    console.log(`Processing: ${row.program_name}`);
    const ok = await processProgram(row.program_name, row.program_url, row.school);
    if (ok) {
      const stored = db.prepare("SELECT schema FROM program_schemas WHERE program_name = ?").get(row.program_name) as any;
      console.log(JSON.stringify(JSON.parse(stored.schema), null, 2));
    }
    return;
  }

  // Process all programs — use pre-extracted text files if available
  const fs = await import("fs");
  const programs = db.prepare(
    `SELECT DISTINCT program_name, program_url, school FROM program_tags
     WHERE program_url IS NOT NULL AND program_url != ''
     ORDER BY school, program_name`
  ).all() as { program_name: string; program_url: string; school: string }[];

  // Skip already-processed
  const existing = new Set(
    (db.prepare("SELECT program_name FROM program_schemas").all() as { program_name: string }[]).map((r) => r.program_name)
  );

  const toProcess = programs.filter((p) => !existing.has(p.program_name));
  console.log(`${toProcess.length} programs to process (${existing.size} already done)\n`);

  let success = 0;
  let fail = 0;

  for (let i = 0; i < toProcess.length; i++) {
    const p = toProcess[i];
    process.stdout.write(`  [${i + 1}/${toProcess.length}] ${p.program_name}... `);
    const ok = await processProgram(p.program_name, p.program_url, p.school);
    if (ok) {
      success++;
      console.log("✓");
    } else {
      fail++;
      console.log("✗");
    }
    // Rate limit
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! ${success} succeeded, ${fail} failed`);
  console.log(`Total schemas: ${(db.prepare("SELECT COUNT(*) as c FROM program_schemas").get() as any).c}`);
}

main().catch(console.error);
