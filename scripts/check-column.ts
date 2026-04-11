import { createClient } from "@supabase/supabase-js";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_KEY!);

async function main() {
  const { error } = await sb.from("courses").update({ all_departments: "test" }).eq("id", 1);
  if (error) {
    console.log("Column missing:", error.message);
    console.log("\nRun this in Supabase SQL Editor:");
    console.log("ALTER TABLE courses ADD COLUMN all_departments TEXT DEFAULT '';");
  } else {
    console.log("Column exists! Reverting test...");
    await sb.from("courses").update({ all_departments: "" }).eq("id", 1);
  }
}
main().catch(console.error);
