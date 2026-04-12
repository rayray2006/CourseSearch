import { NextRequest, NextResponse } from "next/server";
import { getDb } from "@/lib/db";

interface ReqItem {
  code: string | null;
  title: string;
  credits: string;
  isAlt: boolean;
  isPlaceholder: boolean;
  posTag: string | null;
  notes: string;
}

interface ReqGroup {
  name: string;
  level: number;
  notes: string[];
  items: ReqItem[];
  children: ReqGroup[];
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const q = req.nextUrl.searchParams.get("q");
  const db = getDb();

  if (name) {
    // Get rows ordered by id, deduplicate by tracking seen (section + code/title) combos
    const rawRows = db
      .prepare(
        `SELECT section_h2, section_h3, level, offering_name, course_title, credits,
                requirement_type, is_alternative, is_placeholder, pos_tag, notes
         FROM program_tags WHERE program_name = ? ORDER BY id`
      )
      .all(name) as {
      section_h2: string;
      section_h3: string;
      level: number;
      offering_name: string | null;
      course_title: string;
      credits: string;
      requirement_type: string;
      is_alternative: number;
      is_placeholder: number;
      pos_tag: string;
      notes: string;
    }[];

    // Deduplicate: the page often has the same content in multiple tabs.
    // Detect this by finding the midpoint where rows start repeating, then take only the first half.
    let rows = rawRows;
    if (rawRows.length > 4) {
      const half = Math.floor(rawRows.length / 2);
      // Check if the second half is a near-duplicate of the first half
      let matchCount = 0;
      const checkLen = Math.min(half, 10);
      for (let i = 0; i < checkLen; i++) {
        const a = rawRows[i], b = rawRows[half + i];
        if (b && a.section_h2 === b.section_h2 && a.section_h3 === b.section_h3
          && (a.offering_name || "") === (b.offering_name || "") && a.course_title === b.course_title) {
          matchCount++;
        }
      }
      if (matchCount >= checkLen * 0.7) {
        rows = rawRows.slice(0, half);
      }
    }

    // Build hierarchical groups from h2 > h3 structure
    const h2Groups = new Map<string, ReqGroup>();
    const h2Order: string[] = [];

    for (const r of rows) {
      // Ensure h2 group exists
      if (!h2Groups.has(r.section_h2)) {
        h2Order.push(r.section_h2);
        h2Groups.set(r.section_h2, { name: r.section_h2, level: 2, notes: [], items: [], children: [] });
      }
      const h2 = h2Groups.get(r.section_h2)!;

      // Determine target (h3 child or h2 directly)
      let target: ReqGroup;
      if (r.section_h3) {
        let h3 = h2.children.find((c) => c.name === r.section_h3);
        if (!h3) {
          h3 = { name: r.section_h3, level: 3, notes: [], items: [], children: [] };
          h2.children.push(h3);
        }
        target = h3;
      } else {
        target = h2;
      }

      // Add note or item
      if (r.requirement_type === "note" && r.notes) {
        target.notes.push(r.notes);
      } else if (r.offering_name || r.is_placeholder) {
        // Skip courses with no title — these are inline references from paragraph text, not actual requirements
        if (r.offering_name && !r.course_title && !r.is_placeholder) continue;
        target.items.push({
          code: r.offering_name,
          title: r.course_title || r.notes,
          credits: r.credits,
          isAlt: r.is_alternative === 1,
          isPlaceholder: r.is_placeholder === 1,
          posTag: r.pos_tag || null,
          notes: r.notes,
        });
      }
    }

    // Post-process: split items into sub-groups when placeholder headers appear
    // e.g., "At least one from the following:" followed by courses → becomes a child group
    function structureItems(g: ReqGroup) {
      if (g.items.length === 0) { g.children.forEach(structureItems); return; }

      const newItems: ReqItem[] = [];
      const newChildren: ReqGroup[] = [];
      let currentSubGroup: ReqGroup | null = null;

      for (let i = 0; i < g.items.length; i++) {
        const item = g.items[i];

        // Check if this placeholder acts as a sub-section header
        const isSubHeader = item.isPlaceholder && !item.code && !item.posTag
          && /(?:following|comprised|below|listed below|from the following)[:.]?\s*$/i.test(item.title)
          && i + 1 < g.items.length;

        // Also treat labeled placeholders as sub-headers when followed by more items
        const isLabelHeader = item.isPlaceholder && !item.code && !item.posTag
          && /^(Lower-Level|Upper-Level|Mastery|Additional|Complete|At least|A maximum|Classification|Other\s+\w+\s+Upper)/i.test(item.title)
          && i + 1 < g.items.length;

        if (isSubHeader || isLabelHeader) {
          // Flush current sub-group
          if (currentSubGroup && (currentSubGroup.items.length > 0)) {
            newChildren.push(currentSubGroup);
          }
          currentSubGroup = { name: item.title, level: 4, notes: [], items: [], children: [] };
          if (item.credits) currentSubGroup.notes.push(`${item.credits} credits`);
        } else if (currentSubGroup) {
          currentSubGroup.items.push(item);
        } else {
          newItems.push(item);
        }
      }

      // Flush last sub-group
      if (currentSubGroup && currentSubGroup.items.length > 0) {
        newChildren.push(currentSubGroup);
      }

      g.items = newItems;
      // Prepend structured children before existing h3 children
      g.children = [...newChildren, ...g.children];

      // Recurse into children
      g.children.forEach(structureItems);
    }

    // Clean up sections
    for (const h2 of h2Groups.values()) {
      // Remove CAREER EXPLORATION and truly empty sections
      h2.children = h2.children.filter((h3) => {
        if (/CAREER EXPLORATION/i.test(h3.name)) return false;
        if (h3.items.length === 0 && h3.notes.length === 0 && h3.children.length === 0) return false;
        return true;
      });

      // FIRST: Nest focus area / track / concentration h3s under their parent h3
      {
        const nested: ReqGroup[] = [];
        let parentGroup: ReqGroup | null = null;
        for (const h3 of h2.children) {
          const isParentHeader = /^(FOCUS|TRACK|CONCENTRATION|OPTION|SPECIALIZATION|EMPHASIS|AREA OF)/i.test(h3.name);
          const isIndependent = /^(FREE ELECTIVE|ELECTIVE|CAREER|TOTAL|GENERAL)/i.test(h3.name);
          if (isIndependent && parentGroup) {
            nested.push(parentGroup); parentGroup = null; nested.push(h3);
          } else if (isParentHeader) {
            if (parentGroup) nested.push(parentGroup);
            const cleanName = h3.name.replace(/\*+$/, "").trim();
            const realItems = h3.items.filter((item) => item.code && item.title && item.title.length > 0);
            parentGroup = { ...h3, name: cleanName, items: realItems, children: [] };
          } else if (parentGroup) {
            parentGroup.children.push(h3);
          } else {
            nested.push(h3);
          }
        }
        if (parentGroup) nested.push(parentGroup);
        h2.children = nested;
      }

      // THEN: Merge description-only sections, remove reference-only groups
      const cleaned: ReqGroup[] = [];
      for (const h3 of h2.children) {
        // Skip reference groups (Group 1/2, Additional Course Groups, NON-CS)
        if (/^Group\s+\d|^Additional Course|^NON-CS/i.test(h3.name)) continue;
        const isDescOnly = h3.items.length === 0 && h3.children.length === 0 && h3.notes.length > 0;
        if (isDescOnly) {
          h2.notes.push(`**${h3.name}:** ${h3.notes.join(" ")}`);
        } else {
          cleaned.push(h3);
        }
      }
      h2.children = cleaned;
    }

    // Collapse single-child groups: if a group has 1 child and 0 items, merge child up
    function collapseSingleChildren(g: ReqGroup) {
      g.children.forEach(collapseSingleChildren);
      if (g.items.length === 0 && g.children.length === 1) {
        const child = g.children[0];
        g.name = g.name + " — " + child.name;
        g.notes = [...g.notes, ...child.notes];
        g.items = child.items;
        g.children = child.children;
      }
    }

    const groups = h2Order.map((k) => h2Groups.get(k)!).filter(
      (g) => g.items.length > 0 || g.children.length > 0 || g.notes.length > 0
    );
    groups.forEach(structureItems);
    groups.forEach(collapseSingleChildren);

    // Add "choose one" note to focus area / track parent groups
    function addChoiceNotes(g: ReqGroup) {
      if (/^(FOCUS|TRACK|CONCENTRATION|SPECIALIZATION)/i.test(g.name) && g.children.length > 1) {
        if (!g.notes.some((n) => /choose|select|complete one/i.test(n))) {
          g.notes.unshift(`Choose one of the following ${g.children.length} ${g.name.toLowerCase().includes("focus") ? "focus areas" : g.name.toLowerCase().includes("track") ? "tracks" : "options"}:`);
        }
      }
      g.children.forEach(addChoiceNotes);
    }
    groups.forEach(addChoiceNotes);

    const urlRow = db
      .prepare("SELECT program_url FROM program_tags WHERE program_name = ? LIMIT 1")
      .get(name) as { program_url: string } | undefined;

    return NextResponse.json({
      program_name: name,
      groups,
      url: urlRow?.program_url
        ? (urlRow.program_url.startsWith("http") ? urlRow.program_url : `https://e-catalogue.jhu.edu${urlRow.program_url}`)
        : null,
    });
  }

  if (q) {
    return NextResponse.json(
      db.prepare(`SELECT DISTINCT program_name, school FROM program_tags WHERE program_name LIKE ? ORDER BY program_name`).all(`%${q}%`)
    );
  }

  return NextResponse.json(
    db.prepare(`SELECT program_name, school, COUNT(*) as req_count, COUNT(DISTINCT offering_name) as course_count
       FROM program_tags GROUP BY program_name ORDER BY school, program_name`).all()
  );
}
