import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

async function main() {
  const { data, error } = await supabase.from("courses").select("id").limit(1);
  if (error) {
    console.log("Table does not exist yet:", error.message);
    console.log("Run supabase/schema.sql in the Supabase SQL Editor first.");
  } else {
    console.log("Tables exist. Sample:", data);
  }
}

main().catch(console.error);
