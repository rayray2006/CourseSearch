import { createClient } from "@supabase/supabase-js";
import fs from "fs";
import path from "path";

const supabase = createClient(
  "https://mkpgtplmlzpljxkbjtpr.supabase.co",
  process.env.SUPABASE_SERVICE_KEY!
);

async function main() {
  console.log("Creating tables via Supabase SQL API...\n");

  const schema = fs.readFileSync(
    path.join(process.cwd(), "supabase", "schema.sql"),
    "utf-8"
  );

  // Use the Supabase SQL API (available on all Supabase plans)
  const res = await fetch("https://mkpgtplmlzpljxkbjtpr.supabase.co/sql", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.SUPABASE_SERVICE_KEY}`,
      "apikey": process.env.SUPABASE_SERVICE_KEY!,
    },
    body: JSON.stringify({ query: schema }),
  });

  if (res.ok) {
    console.log("Schema created successfully!");
  } else {
    const text = await res.text();
    console.log(`HTTP ${res.status}: ${text}`);
    console.log("\nIf this failed, please run supabase/schema.sql manually:");
    console.log("1. Go to https://supabase.com/dashboard/project/mkpgtplmlzpljxkbjtpr/sql/new");
    console.log("2. Paste the contents of supabase/schema.sql");
    console.log("3. Click 'Run'");
  }
}

main().catch(console.error);
