import { getDb } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json(null);

  const db = getDb();
  const words = name.split(/[\s,]+/).filter((w) => w.length > 1);
  if (words.length === 0) return NextResponse.json(null);

  const conditions = words.map(
    (_, i) => `(first_name LIKE @w${i} OR last_name LIKE @w${i})`
  );
  const params: Record<string, string> = {};
  words.forEach((w, i) => {
    params[`w${i}`] = `%${w}%`;
  });

  const row = db
    .prepare(
      `SELECT first_name, last_name, department, avg_rating, avg_difficulty,
              num_ratings, would_take_again_pct
       FROM professors
       WHERE ${conditions.join(" AND ")} AND num_ratings > 0
       ORDER BY num_ratings DESC
       LIMIT 1`
    )
    .get(params);

  return NextResponse.json(row || null);
}
