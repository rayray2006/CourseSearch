import { initDb } from "../src/lib/db";

const GRAPHQL_URL = "https://www.ratemyprofessors.com/graphql";
const AUTH = "Basic dGVzdDp0ZXN0";

// JHU school IDs on RMP
const SCHOOL_IDS = [
  "U2Nob29sLTQ2NA==",   // Johns Hopkins University (main)
  "U2Nob29sLTU1NTQ=",   // Johns Hopkins Engineering Programs
];

interface RMPTeacher {
  firstName: string;
  lastName: string;
  department: string;
  avgRating: number;
  avgDifficulty: number;
  numRatings: number;
  wouldTakeAgainPercent: number;
  id: string;
}

async function fetchPage(
  schoolId: string,
  cursor?: string
): Promise<{
  teachers: RMPTeacher[];
  hasNext: boolean;
  endCursor: string | null;
  totalCount: number;
}> {
  const afterClause = cursor ? `, after: "${cursor}"` : "";

  const query = `query {
    newSearch {
      teachers(query: { text: "", schoolID: "${schoolId}" }, first: 20${afterClause}) {
        resultCount
        edges {
          cursor
          node {
            id
            firstName
            lastName
            department
            avgRating
            avgDifficulty
            numRatings
            wouldTakeAgainPercent
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }`;

  const res = await fetch(GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: AUTH,
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    throw new Error(`RMP API error: ${res.status}`);
  }

  const data = await res.json();
  const teachers = data.data.newSearch.teachers;

  return {
    teachers: teachers.edges.map((e: { node: RMPTeacher }) => e.node),
    hasNext: teachers.pageInfo.hasNextPage,
    endCursor: teachers.pageInfo.endCursor,
    totalCount: teachers.resultCount,
  };
}

async function fetchAllProfessors(schoolId: string, label: string): Promise<RMPTeacher[]> {
  const all: RMPTeacher[] = [];
  let cursor: string | undefined;
  let page = 0;

  const first = await fetchPage(schoolId);
  console.log(`  ${label}: ${first.totalCount} professors total`);
  all.push(...first.teachers);
  cursor = first.endCursor ?? undefined;
  page++;

  while (first.totalCount > 0 && cursor && first.hasNext) {
    const result = await fetchPage(schoolId, cursor);
    all.push(...result.teachers);
    cursor = result.endCursor ?? undefined;
    page++;
    process.stdout.write(`  Page ${page} (${all.length} fetched)...\r`);

    if (!result.hasNext) break;
    // Small delay to be polite
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(`  Fetched ${all.length} professors from ${label}`);
  return all;
}

async function main() {
  const db = initDb();

  const insert = db.prepare(`
    INSERT OR REPLACE INTO professors (
      first_name, last_name, department, avg_rating, avg_difficulty,
      num_ratings, would_take_again_pct, rmp_id
    ) VALUES (
      @first_name, @last_name, @department, @avg_rating, @avg_difficulty,
      @num_ratings, @would_take_again_pct, @rmp_id
    )
  `);

  const labels = ["JHU Main", "JHU Engineering"];
  let total = 0;

  for (let i = 0; i < SCHOOL_IDS.length; i++) {
    console.log(`Fetching from ${labels[i]}...`);
    const professors = await fetchAllProfessors(SCHOOL_IDS[i], labels[i]);

    const insertMany = db.transaction((profs: RMPTeacher[]) => {
      for (const p of profs) {
        if (p.numRatings === 0) continue; // Skip unrated professors
        insert.run({
          first_name: p.firstName,
          last_name: p.lastName,
          department: p.department || "",
          avg_rating: p.avgRating,
          avg_difficulty: p.avgDifficulty,
          num_ratings: p.numRatings,
          would_take_again_pct: p.wouldTakeAgainPercent === -1 ? null : p.wouldTakeAgainPercent,
          rmp_id: p.id,
        });
      }
    });

    insertMany(professors);
    total += professors.length;
  }

  const count = db.prepare("SELECT COUNT(*) as count FROM professors").get() as { count: number };
  const rated = db.prepare("SELECT COUNT(*) as count FROM professors WHERE num_ratings > 0").get() as { count: number };

  console.log(`\nDone! Fetched ${total} professors, stored ${count.count} with ratings (${rated.count} rated).`);
}

main().catch(console.error);
