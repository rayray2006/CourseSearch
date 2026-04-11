import { createClient } from "@supabase/supabase-js";
import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_KEY!;

if (!SUPABASE_KEY || !SUPABASE_URL) {
  console.error("Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local");
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const dbPath = path.join(process.cwd(), "courses.db");
const db = new Database(dbPath);

async function runSchema() {
  const schema = fs.readFileSync(
    path.join(process.cwd(), "supabase", "schema.sql"),
    "utf-8"
  );
  // Execute schema via Supabase SQL
  const { error } = await supabase.rpc("exec_sql", { sql: schema });
  if (error) {
    console.log("Schema via RPC failed (expected if function doesn't exist). Run schema.sql manually in Supabase SQL Editor.");
  }
}

async function migrateCourses() {
  console.log("Migrating courses...");
  const rows = db.prepare("SELECT * FROM courses").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} courses to migrate`);

  // Batch insert in chunks of 500
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
      console.log(`  Inserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function migrateProfessors() {
  console.log("Migrating professors...");
  const rows = db.prepare("SELECT * FROM professors").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} professors to migrate`);

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
      first_name: r.first_name,
      last_name: r.last_name,
      department: r.department,
      avg_rating: r.avg_rating,
      avg_difficulty: r.avg_difficulty,
      num_ratings: r.num_ratings,
      would_take_again_pct: r.would_take_again_pct,
      rmp_id: r.rmp_id,
    }));

    const { error } = await supabase.from("professors").upsert(chunk, {
      onConflict: "first_name,last_name,department",
    });
    if (error) {
      console.error(`  Error at chunk ${i}:`, error.message);
    } else {
      console.log(`  Inserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function migrateEvaluations() {
  console.log("Migrating evaluations...");
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='evaluations'")
    .get();
  if (!tableExists) {
    console.log("  No evaluations table, skipping.");
    return;
  }

  const rows = db.prepare("SELECT * FROM evaluations").all() as Record<string, unknown>[];
  console.log(`  ${rows.length} evaluations to migrate`);

  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500).map((r) => ({
      course_code: r.course_code,
      instance_key: r.instance_key,
      course_name: r.course_name || "",
      instructor: r.instructor || "",
      term: r.term || "",
      overall_quality: r.overall_quality,
      instructor_effectiveness: r.instructor_effectiveness,
      intellectual_challenge: r.intellectual_challenge,
      workload: r.workload,
      feedback_usefulness: r.feedback_usefulness,
      num_respondents: r.num_respondents || 0,
      num_enrolled: r.num_enrolled || 0,
    }));

    const { error } = await supabase.from("evaluations").upsert(chunk, {
      onConflict: "instance_key",
    });
    if (error) {
      console.error(`  Error at chunk ${i}:`, error.message);
    } else {
      console.log(`  Inserted ${Math.min(i + 500, rows.length)}/${rows.length}`);
    }
  }
}

async function main() {
  await runSchema();
  await migrateCourses();
  await migrateProfessors();
  await migrateEvaluations();
  console.log("\nDone! Data migrated to Supabase.");
}

main().catch(console.error);
