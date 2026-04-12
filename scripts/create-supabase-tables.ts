/**
 * Create missing tables in Supabase via the REST API.
 * For tables that can't be created via upsert.
 */
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function main() {
  // Test which tables exist
  const tables = ["program_schemas", "program_tags"];

  for (const table of tables) {
    const { error } = await supabase.from(table).select("*").limit(1);
    if (error?.message.includes("not found")) {
      console.log(`${table}: NEEDS CREATION`);
    } else {
      console.log(`${table}: exists`);
    }
  }

  console.log(`
=== Run this SQL in the Supabase SQL Editor ===
https://supabase.com/dashboard/project/mkpgtplmlzpljxkbjtpr/sql/new

-- Program schemas (LLM-processed requirement structures)
CREATE TABLE IF NOT EXISTS program_schemas (
  program_name TEXT PRIMARY KEY,
  program_url TEXT,
  school TEXT,
  schema JSONB NOT NULL DEFAULT '{}',
  raw_text TEXT,
  visible INTEGER DEFAULT 0,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Program tags (scraped from e-catalogue)
CREATE TABLE IF NOT EXISTS program_tags (
  id SERIAL PRIMARY KEY,
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

CREATE INDEX IF NOT EXISTS idx_progtags_program ON program_tags(program_name);
CREATE INDEX IF NOT EXISTS idx_progtags_offering ON program_tags(offering_name);

-- Add pos_tags column to courses if missing
ALTER TABLE courses ADD COLUMN IF NOT EXISTS pos_tags TEXT DEFAULT '';

-- Add pos_tags column to catalogue if missing
ALTER TABLE catalogue ADD COLUMN IF NOT EXISTS pos_tags TEXT DEFAULT '';
  `);
}

main().catch(console.error);
