/**
 * Fetch Program of Study tags (PosTags) from the JHU Typesense search index.
 * Tags like CSCI-APPL, ROBO-CMCS, COGS-COMPCG indicate which program area a course counts toward.
 */
import { initDb } from "../src/lib/db";

async function getTypesenseConfig() {
  const res = await fetch("https://api.sis.jhu.edu/api/coursesearch/configuration");
  const json = await res.json();
  const config = json.data || json;
  return {
    host: config.typesenseHostNodes?.[0] || "tn0vi78cyja5u3rgp-1.a1.typesense.net",
    apiKey: config.typesenseApiKey,
    collection: config.typesenseSchemaName || "sections",
  };
}

interface TypesenseHit {
  document: {
    OfferingName: string;
    SectionName: string;
    PosTags?: string[];
  };
}

async function main() {
  const db = initDb();

  // Add pos_tags column if not exists
  const columns = db.prepare("PRAGMA table_info(courses)").all() as { name: string }[];
  if (!columns.some((c) => c.name === "pos_tags")) {
    db.exec("ALTER TABLE courses ADD COLUMN pos_tags TEXT DEFAULT ''");
    console.log("Added pos_tags column to courses table");
  }

  console.log("Fetching Typesense configuration...");
  const config = await getTypesenseConfig();
  console.log(`Host: ${config.host}`);

  // Paginate through ALL sections with PosTags using wildcard search
  const perPage = 250;
  let page = 1;
  let totalProcessed = 0;
  const tagsByCode = new Map<string, Set<string>>();
  const allTags = new Map<string, number>();

  console.log("\nFetching all sections with PosTags...\n");

  while (true) {
    const params = new URLSearchParams({
      q: "*",
      per_page: String(perPage),
      page: String(page),
      include_fields: "OfferingName,SectionName,PosTags",
      filter_by: "PosTags:![]", // only sections that have PosTags
    });

    const url = `https://${config.host}/collections/${config.collection}/documents/search?${params}`;
    const res = await fetch(url, {
      headers: { "X-TYPESENSE-API-KEY": config.apiKey },
    });

    if (!res.ok) {
      console.log(`Error on page ${page}: ${res.status}`);
      break;
    }

    const result = await res.json() as { hits: TypesenseHit[]; found: number };

    if (page === 1) console.log(`Total sections with PosTags: ${result.found}\n`);

    for (const hit of result.hits) {
      const code = hit.document.OfferingName;
      const tags = hit.document.PosTags || [];

      if (tags.length > 0) {
        if (!tagsByCode.has(code)) tagsByCode.set(code, new Set());
        for (const tag of tags) {
          tagsByCode.get(code)!.add(tag);
          allTags.set(tag, (allTags.get(tag) || 0) + 1);
        }
      }
    }

    totalProcessed += result.hits.length;
    if (totalProcessed % 2000 === 0 || result.hits.length < perPage) {
      console.log(`  ${totalProcessed}/${result.found} processed — ${tagsByCode.size} unique courses with tags`);
    }

    if (result.hits.length < perPage) break;
    page++;

    // Small delay
    if (page % 10 === 0) await new Promise((r) => setTimeout(r, 100));
  }

  // Update database
  console.log(`\nUpdating ${tagsByCode.size} courses in database...`);
  const update = db.prepare("UPDATE courses SET pos_tags = @posTags WHERE offering_name = @code");
  let updated = 0;

  db.transaction(() => {
    for (const [code, tags] of tagsByCode) {
      const posTags = [...tags].sort().join(",");
      const result = update.run({ code, posTags });
      updated += result.changes;
    }
  })();

  // Also add to catalogue table
  const catColumns = db.prepare("PRAGMA table_info(catalogue)").all() as { name: string }[];
  if (!catColumns.some((c) => c.name === "pos_tags")) {
    db.exec("ALTER TABLE catalogue ADD COLUMN pos_tags TEXT DEFAULT ''");
  }
  const updateCat = db.prepare("UPDATE catalogue SET pos_tags = @posTags WHERE offering_name = @code");
  db.transaction(() => {
    for (const [code, tags] of tagsByCode) {
      updateCat.run({ code, posTags: [...tags].sort().join(",") });
    }
  })();

  console.log(`\n${"=".repeat(50)}`);
  console.log(`Done!`);
  console.log(`  Sections processed: ${totalProcessed}`);
  console.log(`  Unique courses with tags: ${tagsByCode.size}`);
  console.log(`  Course rows updated: ${updated}`);
  console.log(`  Unique tag types: ${allTags.size}`);

  // Show top tags
  const sortedTags = [...allTags.entries()].sort((a, b) => b[1] - a[1]);
  console.log(`\nTop 30 tags:`);
  for (const [tag, count] of sortedTags.slice(0, 30)) {
    console.log(`  ${tag}: ${count}`);
  }

  // Verify
  const withTags = db.prepare("SELECT COUNT(DISTINCT offering_name) as c FROM courses WHERE pos_tags != ''").get() as { c: number };
  console.log(`\nCourses with pos_tags in DB: ${withTags.c}`);

  // CS sample
  console.log("\n=== Sample CS courses ===");
  const sample = db.prepare(
    "SELECT DISTINCT offering_name, title, pos_tags FROM courses WHERE offering_name LIKE 'EN.601%' AND pos_tags != '' AND term = 'Fall 2026' ORDER BY offering_name LIMIT 20"
  ).all();
  console.table(sample);
}

main().catch(console.error);
