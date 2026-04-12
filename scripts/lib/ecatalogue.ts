import { load } from "cheerio";

const BASE = "https://e-catalogue.jhu.edu/course-descriptions/";

export interface CourseDetail {
  courseNumber: string; // e.g. "EN.601.226"
  title: string;
  credits: string;
  department: string;
  description: string;
  prerequisites: string;
  corequisites: string;
  restrictions: string;
}

export async function getDepartmentPaths(): Promise<string[]> {
  const res = await fetch(BASE);
  const html = await res.text();
  const $ = load(html);
  const paths: string[] = [];
  $('a[href^="/course-descriptions/"]').each((_, el) => {
    const href = $(el).attr("href");
    if (href && href !== "/course-descriptions/" && href.endsWith("/")) {
      paths.push(href);
    }
  });
  return [...new Set(paths)];
}

export function parseDepartmentPage(html: string, deptLabel?: string): CourseDetail[] {
  const $ = load(html);
  const courses: CourseDetail[] = [];

  $(".courseblock").each((_, block) => {
    const $block = $(block);

    const codeRaw = $block.find(".detail-code").text().trim();
    const courseNumber = codeRaw.replace(/\.$/, "");

    const titleRaw = $block.find(".detail-title").text().trim();
    const title = titleRaw.replace(/\.$/, "");

    const creditsRaw = $block.find(".detail-hours_html").text().trim();
    const credits = creditsRaw.replace(/\.$/, "");

    let description = "";
    let prerequisites = "";
    let corequisites = "";
    let restrictions = "";

    $block.find(".courseblockextra").each((_, p) => {
      const text = $(p).text().trim();

      if (text.startsWith("Prerequisite(s):")) {
        prerequisites = text.replace("Prerequisite(s):", "").trim();
      } else if (text.startsWith("Co-requisite(s):")) {
        corequisites = text.replace("Co-requisite(s):", "").trim();
      } else if (text.startsWith("Restriction(s):")) {
        restrictions = text.replace("Restriction(s):", "").trim();
      } else if (
        !text.startsWith("Distribution Area:") &&
        !text.startsWith("AS Foundational") &&
        !text.startsWith("Writing Intensive") &&
        !text.startsWith("Area:") &&
        text.length > 20
      ) {
        if (!description) {
          description = text;
        }
      }
    });

    if (courseNumber) {
      // Infer department from the page label or first part of course number
      const dept = deptLabel || "";
      courses.push({
        courseNumber,
        title,
        credits,
        department: dept,
        description,
        prerequisites,
        corequisites,
        restrictions,
      });
    }
  });

  return courses;
}
