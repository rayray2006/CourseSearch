/**
 * Sync local SQLite data to Supabase.
 * Pushes courses (all terms), catalogue, and available_terms.
 * Assumes Supabase tables already exist (run migrate-schema.ts first).
 */
import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import path from "path";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_KEY || !SUPABASE_URL) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dbPath = path.join(process.cwd(), "courses.db");
const db = new Database(dbPath);

async function syncCourses() {
  console.log("Syncing courses...");
  const rows = db.prepare("SELECT * FROM courses").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} courses to sync`);

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
      offering_name: r.offering_name,
      section_name: r.section_name,
      title: r.title,
      credits: r.credits,
      department: r.department,
      school_name: r.school_name,
      level: r.level,
      status: r.status,
      dow: r.dow,
      time_of_day: r.time_of_day,
      meetings: r.meetings,
      location: r.location,
      building: r.building,
      instruction_method: r.instruction_method,
      instructors: r.instructors,
      instructors_full_name: r.instructors_full_name,
      max_seats: r.max_seats,
      open_seats: r.open_seats,
      waitlisted: r.waitlisted,
      is_writing_intensive: r.is_writing_intensive,
      areas: r.areas,
      repeatable: r.repeatable,
      term: r.term,
      term_start_date: r.term_start_date,
      description: r.description || "",
      prerequisites: r.prerequisites || "",
      corequisites: r.corequisites || "",
      restrictions: r.restrictions || "",
      overall_quality: r.overall_quality,
      instructor_effectiveness: r.instructor_effectiveness,
      intellectual_challenge: r.intellectual_challenge,
      workload: r.workload,
      feedback_usefulness: r.feedback_usefulness,
      num_evaluations: r.num_evaluations || 0,
      num_respondents: r.num_respondents || 0,
    }));

    const { error } = await supabase.from("courses").upsert(chunk, {
      onConflict: "offering_name,section_name,term",
    });
    if (error) {
      console.error(`  Error at chunk ${i}:`, error.message);
    } else {
      console.log(`  ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function syncCatalogue() {
  console.log("\nSyncing catalogue...");
  const tableExists = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='catalogue'").get();
  if (!tableExists) {
    console.log("  No catalogue table, skipping.");
    return;
  }

  const rows = db.prepare("SELECT * FROM catalogue").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} catalogue entries to sync`);

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
      offering_name: r.offering_name,
      title: r.title,
      credits: r.credits,
      department: r.department,
      description: r.description || "",
      prerequisites: r.prerequisites || "",
      corequisites: r.corequisites || "",
      restrictions: r.restrictions || "",
    }));

    const { error } = await supabase.from("catalogue").upsert(chunk, {
      onConflict: "offering_name",
    });
    if (error) {
      console.error(`  Error at chunk ${i}:`, error.message);
    } else {
      console.log(`  ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function syncAvailableTerms() {
  console.log("\nSyncing available_terms...");
  const rows = db.prepare("SELECT * FROM available_terms ORDER BY sort_order").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} terms`);

  for (const r of rows) {
    const { error } = await supabase.from("available_terms").upsert({
      term: r.term,
      sort_order: r.sort_order,
      has_sis_data: r.has_sis_data === 1 || r.has_sis_data === true,
      course_count: r.course_count,
      is_current: r.is_current === 1 || r.is_current === true,
    }, { onConflict: "term" });
    if (error) console.error(`  Error for ${r.term}:`, error.message);
  }
  console.log("  Done");
}

async function main() {
  const what = process.argv[2]; // "courses", "catalogue", "terms", or blank for all

  if (!what || what === "courses") await syncCourses();
  if (!what || what === "catalogue") await syncCatalogue();
  if (!what || what === "terms") await syncAvailableTerms();

  console.log("\nSync complete!");
}

main().catch(console.error);
