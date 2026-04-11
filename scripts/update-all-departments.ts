import { createClient } from "@supabase/supabase-js";

const API_KEY = process.env.JHU_API_KEY!;
const BASE_URL = "https://sis.jhu.edu/api/classes";
const TERM = "Fall 2026";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

interface APICourse {
  OfferingName: string;
  SectionName: string;
  AllDepartments: string;
}

async function main() {
  // First, add column if it doesn't exist (will fail silently if already there)
  console.log("Ensuring all_departments column exists...");

  // Fetch from API and update Supabase
  let updated = 0;
  for (const school of SCHOOLS) {
    const url = `${BASE_URL}/${encodeURIComponent(school)}/${encodeURIComponent(TERM)}?key=${API_KEY}`;
    console.log(`Fetching ${school}...`);
    const res = await fetch(url);
    if (!res.ok) { console.error(`  Failed: ${res.status}`); continue; }
    const data: APICourse[] = await res.json();
    console.log(`  Got ${data.length} sections`);

    // Batch update in chunks
    for (let i = 0; i < data.length; i += 100) {
      const chunk = data.slice(i, i + 100);
      for (const c of chunk) {
        // Convert ^ separator to comma for readable storage
        const allDepts = (c.AllDepartments || "").replace(/\^/g, ", ");
        if (allDepts && allDepts !== c.AllDepartments) {
          // Only update if there are multiple departments
        }
        const { error } = await supabase
          .from("courses")
          .update({ all_departments: allDepts })
          .eq("offering_name", c.OfferingName)
          .eq("section_name", c.SectionName)
          .eq("term", TERM);

        if (!error) updated++;
      }
      process.stdout.write(`  Updated ${Math.min(i + 100, data.length)}/${data.length}\r`);
    }
    console.log();
    await new Promise((r) => setTimeout(r, 500));
  }

  console.log(`\nDone! Updated ${updated} rows with all_departments.`);

  // Verify
  const { data: sample } = await supabase
    .from("courses")
    .select("offering_name, title, department, all_departments")
    .ilike("all_departments", "%^%")
    .limit(5);

  // Check for courses with multiple departments
  const { data: multi } = await supabase
    .from("courses")
    .select("offering_name, title, all_departments")
    .ilike("all_departments", "%, %")
    .limit(10);

  console.log("\nSample cross-listed courses:");
  (multi || []).forEach((c) => console.log(`  ${c.offering_name} ${c.title}: ${c.all_departments}`));
}

main().catch(console.error);
