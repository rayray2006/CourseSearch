import { getDb } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

interface ProfResult {
  first_name: string;
  last_name: string;
  department: string;
  avg_rating: number;
  avg_difficulty: number;
  num_ratings: number;
  would_take_again_pct: number | null;
}

function lookupProfessor(db: ReturnType<typeof getDb>, name: string): ProfResult | null {
  // Split "Last, First M" into meaningful words, drop single initials
  const words = name.split(/[\s,]+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;

  const conditions = words.map(
    (_, i) => `(first_name LIKE @w${i} OR last_name LIKE @w${i})`
  );
  const params: Record<string, string> = {};
  words.forEach((w, i) => {
    params[`w${i}`] = `%${w}%`;
  });

  return (
    (db
      .prepare(
        `SELECT first_name, last_name, department, avg_rating, avg_difficulty,
                num_ratings, would_take_again_pct
         FROM professors
         WHERE ${conditions.join(" AND ")} AND num_ratings > 0
         ORDER BY num_ratings DESC
         LIMIT 1`
      )
      .get(params) as ProfResult | undefined) || null
  );
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json([]);

  const db = getDb();

  // Split multiple instructors on ";" and look up each independently
  const instructors = name.split(";").map((s) => s.trim()).filter(Boolean);
  const results: { name: string; rating: ProfResult | null }[] = [];

  for (const instructor of instructors) {
    results.push({
      name: instructor,
      rating: lookupProfessor(db, instructor),
    });
  }

  return NextResponse.json(results);
}
