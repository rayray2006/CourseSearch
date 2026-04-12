// @ts-nocheck
import { load, type CheerioAPI } from "cheerio";
import { initDb } from "../src/lib/db";

const CATALOGUE_BASE = "https://e-catalogue.jhu.edu/archive/2024-25";
const PROGRAMS_INDEX = `${CATALOGUE_BASE}/programs/`;

interface ProgramInfo {
  url: string;
  title: string;
  school: string;
}

interface ReqItem {
  code: string | null;
  title: string;
  credits: string;
  isAlt: boolean;
  isPlaceholder: boolean;
  posTag: string | null;
}

interface ReqGroup {
  name: string;
  level: number;      // 2 for h2, 3 for h3, 4 for sub-sections
  notes: string[];
  items: ReqItem[];
  children: ReqGroup[];
}

async function fetchProgramIndex(): Promise<ProgramInfo[]> {
  console.log("Fetching program index...");
  const res = await fetch(PROGRAMS_INDEX);
  const html = await res.text();
  const $ = load(html);
  const programs: ProgramInfo[] = [];

  $("li").each((_, li) => {
    const $li = $(li);
    const link = $li.find("a").first();
    const href = link.attr("href");
    const title = $li.find("span.title").text().trim() || link.text().trim();

    if (!href || !title) return;
    if (!href.startsWith("/")) return;

    let school = "";
    if (href.includes("/engineering/")) school = "Whiting School of Engineering";
    else if (href.includes("/arts-sciences/")) school = "Krieger School of Arts and Sciences";

    if (school) {
      programs.push({ url: href, title, school });
    }
  });

  return programs;
}

function parseCoursesFromTable($: CheerioAPI, table: Element): ReqItem[] {
  const items: ReqItem[] = [];

  $(table).find("tr").each((_, tr) => {
    const $tr = $(tr);
    const isOr = $tr.hasClass("orclass");

    // Skip area headers inside tables (they're handled by the h2/h3 parsing)
    if ($tr.hasClass("areaheader")) return;

    // Course with code
    const codeLink = $tr.find("a.bubblelink.code").first();
    if (codeLink.length > 0) {
      const code = codeLink.attr("title") || codeLink.text().trim();
      const titleTd = $tr.find("td").not(".codecol").not(".hourscol").first();
      const courseTitle = titleTd.text().trim().replace(/^or\s+/i, "");
      const credits = $tr.find("td.hourscol").text().trim();
      items.push({ code, title: courseTitle, credits, isAlt: isOr, isPlaceholder: false, posTag: null });
      return;
    }

    // Comment row (inside table)
    const comment = $tr.find("span.courselistcomment").text().trim();
    if (!comment) return;
    if (comment === "Total Credits" || /^\d+$/.test(comment)) return;

    // Parse into placeholder requirement
    const posMatch = comment.match(/POS\s*Tag[,:]?\s+(\S+)/i);
    if (posMatch) {
      const tag = posMatch[1].replace(/[,;:]$/, "");
      items.push({ code: null, title: comment, credits: $tr.find("td.hourscol").text().trim(), isAlt: false, isPlaceholder: true, posTag: tag });
      return;
    }

    const electMatch = comment.match(/elective\s+courses?\s+to\s+reach\s+(\d+)\s+credits/i);
    if (electMatch) {
      items.push({ code: null, title: "Free Electives", credits: electMatch[1], isAlt: false, isPlaceholder: true, posTag: null });
      return;
    }

    // Generic requirement note (writing intensive, distribution, etc.)
    if (/courses?\s|credits?\s|POS\s/i.test(comment) || comment.length > 15) {
      const cr = $tr.find("td.hourscol").text().trim();
      items.push({ code: null, title: comment, credits: cr, isAlt: false, isPlaceholder: true, posTag: null });
    }
  });

  return items;
}

function parseProgramPage(html: string): ReqGroup[] {
  const $ = load(html);
  const groups: ReqGroup[] = [];

  // Find the requirements tab content - try various container IDs
  let container = $("[id*='requirementstextcontainer']").first();
  if (container.length === 0) container = $("#textcontainer");
  if (container.length === 0) container = $(".page_content").first();
  if (container.length === 0) return [];

  // Walk through the container's children in order
  let currentH2: ReqGroup | null = null;
  let currentH3: ReqGroup | null = null;

  container.children().each((_, el) => {
    const $el = $(el);
    const tagName = (el as any).tagName?.toLowerCase();

    if (tagName === "h2") {
      // Flush current h3 into h2
      if (currentH3 && currentH2) {
        if (currentH3.items.length > 0 || currentH3.notes.length > 0) {
          currentH2.children.push(currentH3);
        }
        currentH3 = null;
      }
      // Flush current h2
      if (currentH2 && (currentH2.items.length > 0 || currentH2.children.length > 0 || currentH2.notes.length > 0)) {
        groups.push(currentH2);
      }
      const text = $el.text().trim();
      if (text) currentH2 = { name: text, level: 2, notes: [], items: [], children: [] };
    } else if (tagName === "h3") {
      // Flush current h3 into h2
      if (currentH3 && currentH2) {
        if (currentH3.items.length > 0 || currentH3.notes.length > 0) {
          currentH2.children.push(currentH3);
        }
      }
      const text = $el.text().trim();
      if (text) currentH3 = { name: text, level: 3, notes: [], items: [], children: [] };
    } else if (tagName === "table" && $el.hasClass("sc_courselist")) {
      const items = parseCoursesFromTable($, el as any);
      const target = currentH3 || currentH2;
      if (target) target.items.push(...items);
    } else if (tagName === "p" || tagName === "div" || tagName === "ul") {
      const text = $el.text().trim();
      const target = currentH3 || currentH2;
      if (!target || !text || text.length < 10) return;

      // Skip boilerplate
      if (/^(Print|©|Grades of [A-Z]|Students must meet the University|The information below describes|For more information|See your|Note:$)/i.test(text)) return;

      // Don't capture inline course refs as items — they're just mentions in text
      // Only capture paragraph text as notes for context
      if (/Writing Intensive|Humanities|Social Science|Distribution|courses?\s+at\s|credits?\s+(are|may|must|required|from)|comprised of|elective/i.test(text)) {
        target.notes.push(text);
        // Create placeholder for quantified requirements like "Two Writing Intensive (W) courses"
        const quantMatch = text.match(/^(Two|Three|Four|Five|Six|One|Seven|Eight)\s+(.+?)\s+courses?/i);
        if (quantMatch) {
          target.items.push({ code: null, title: text, credits: "", isAlt: false, isPlaceholder: true, posTag: null });
        }
      } else if (/^(The \d+ required|A grade of|A successful|Regardless of degree)/i.test(text)) {
        // Section description — keep as note
        target.notes.push(text);
      }
    }
  });

  // Flush remaining
  if (currentH3 && currentH2) {
    if (currentH3.items.length > 0 || currentH3.notes.length > 0) {
      currentH2.children.push(currentH3);
    }
  }
  if (currentH2 && (currentH2.items.length > 0 || currentH2.children.length > 0 || currentH2.notes.length > 0)) {
    groups.push(currentH2);
  }

  return groups;
}

// Flatten groups into database rows for storage
function flattenGroups(groups: ReqGroup[], programName: string, programUrl: string, school: string): {
  programName: string; programUrl: string; school: string;
  sectionH2: string; sectionH3: string; level: number;
  offeringName: string | null; courseTitle: string; credits: string;
  requirementType: string; isAlternative: number; isPlaceholder: number;
  posTag: string; notes: string;
}[] {
  const rows: ReturnType<typeof flattenGroups> = [];

  for (const h2 of groups) {
    // H2-level notes
    for (const note of h2.notes) {
      rows.push({
        programName, programUrl, school,
        sectionH2: h2.name, sectionH3: "", level: 2,
        offeringName: null, courseTitle: "", credits: "",
        requirementType: "note", isAlternative: 0, isPlaceholder: 1,
        posTag: "", notes: note,
      });
    }
    // H2-level items (no h3 parent)
    for (const item of h2.items) {
      rows.push({
        programName, programUrl, school,
        sectionH2: h2.name, sectionH3: "", level: 2,
        offeringName: item.code, courseTitle: item.title, credits: item.credits,
        requirementType: item.isPlaceholder ? "placeholder" : (item.isAlt ? "alternative" : "required"),
        isAlternative: item.isAlt ? 1 : 0, isPlaceholder: item.isPlaceholder ? 1 : 0,
        posTag: item.posTag || "", notes: "",
      });
    }
    // H3 children
    for (const h3 of h2.children) {
      for (const note of h3.notes) {
        rows.push({
          programName, programUrl, school,
          sectionH2: h2.name, sectionH3: h3.name, level: 3,
          offeringName: null, courseTitle: "", credits: "",
          requirementType: "note", isAlternative: 0, isPlaceholder: 1,
          posTag: "", notes: note,
        });
      }
      for (const item of h3.items) {
        rows.push({
          programName, programUrl, school,
          sectionH2: h2.name, sectionH3: h3.name, level: 3,
          offeringName: item.code, courseTitle: item.title, credits: item.credits,
          requirementType: item.isPlaceholder ? "placeholder" : (item.isAlt ? "alternative" : "required"),
          isAlternative: item.isAlt ? 1 : 0, isPlaceholder: item.isPlaceholder ? 1 : 0,
          posTag: item.posTag || "", notes: "",
        });
      }
    }
  }

  return rows;
}

async function main() {
  const db = initDb();

  // Recreate program_tags with better schema
  db.exec("DROP TABLE IF EXISTS program_tags");
  db.exec(`
    CREATE TABLE program_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_name TEXT NOT NULL,
      program_url TEXT,
      school TEXT,
      section_h2 TEXT DEFAULT '',
      section_h3 TEXT DEFAULT '',
      level INTEGER DEFAULT 2,
      offering_name TEXT,
      course_title TEXT DEFAULT '',
      credits TEXT DEFAULT '',
      requirement_type TEXT DEFAULT 'required',
      is_alternative INTEGER DEFAULT 0,
      is_placeholder INTEGER DEFAULT 0,
      pos_tag TEXT DEFAULT '',
      notes TEXT DEFAULT ''
    );
    CREATE INDEX idx_progtags_program ON program_tags(program_name);
    CREATE INDEX idx_progtags_offering ON program_tags(offering_name);
    CREATE INDEX idx_progtags_school ON program_tags(school);
    CREATE INDEX idx_progtags_section ON program_tags(section_h2, section_h3);
  `);

  const insert = db.prepare(`
    INSERT INTO program_tags (
      program_name, program_url, school, section_h2, section_h3, level,
      offering_name, course_title, credits, requirement_type,
      is_alternative, is_placeholder, pos_tag, notes
    ) VALUES (
      @programName, @programUrl, @school, @sectionH2, @sectionH3, @level,
      @offeringName, @courseTitle, @credits, @requirementType,
      @isAlternative, @isPlaceholder, @posTag, @notes
    )
  `);

  const programs = await fetchProgramIndex();
  console.log(`Found ${programs.length} programs from Krieger + Whiting\n`);

  let totalRows = 0;
  let programsWithData = 0;

  for (let i = 0; i < programs.length; i++) {
    const program = programs[i];
    const url = program.url.startsWith("http") ? program.url : `https://e-catalogue.jhu.edu${program.url}`;

    try {
      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  [${i + 1}/${programs.length}] ${program.title}: HTTP ${res.status}`);
        continue;
      }
      const html = await res.text();
      const groups = parseProgramPage(html);
      const rows = flattenGroups(groups, program.title, program.url, program.school);

      if (rows.length > 0) {
        programsWithData++;
        db.transaction(() => { for (const r of rows) insert.run(r); })();
        totalRows += rows.length;
        const courseCount = rows.filter((r) => r.offeringName).length;
        console.log(`  [${i + 1}/${programs.length}] ${program.title}: ${rows.length} rows (${courseCount} courses, ${groups.length} sections)`);
      } else {
        console.log(`  [${i + 1}/${programs.length}] ${program.title}: (no structured requirements)`);
      }
    } catch (err) {
      console.log(`  [${i + 1}/${programs.length}] ${program.title}: error — ${err}`);
    }

    await new Promise((r) => setTimeout(r, 300));
  }

  const count = db.prepare("SELECT COUNT(*) as c FROM program_tags").get() as { c: number };
  const courseCount = db.prepare("SELECT COUNT(*) as c FROM program_tags WHERE offering_name IS NOT NULL").get() as { c: number };
  const programCount = db.prepare("SELECT COUNT(DISTINCT program_name) as c FROM program_tags").get() as { c: number };

  console.log(`\nDone!`);
  console.log(`  Programs: ${programCount.c} with data out of ${programs.length}`);
  console.log(`  Total rows: ${count.c}`);
  console.log(`  Course entries: ${courseCount.c}`);

  // Sample
  console.log("\n=== BME BS sections ===");
  const sample = db.prepare(`
    SELECT DISTINCT section_h2, section_h3, COUNT(*) as cnt,
           COUNT(offering_name) as courses
    FROM program_tags
    WHERE program_name = 'Biomedical Engineering, Bachelor of Science'
    GROUP BY section_h2, section_h3
    ORDER BY id
  `).all() as { section_h2: string; section_h3: string; cnt: number; courses: number }[];
  for (const s of sample) {
    const h3 = s.section_h3 ? ` > ${s.section_h3}` : "";
    console.log(`  ${s.section_h2}${h3}: ${s.courses} courses, ${s.cnt} total`);
  }
}

main().catch(console.error);
