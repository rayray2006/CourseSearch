import { supabase } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  if (!name) return NextResponse.json([]);

  const instructors = name.split(";").map((s) => s.trim()).filter(Boolean);
  const results: { name: string; rating: Record<string, unknown> | null }[] = [];

  for (const instructor of instructors) {
    const words = instructor.split(/[\s,]+/).filter((w) => w.length > 1);
    if (words.length === 0) { results.push({ name: instructor, rating: null }); continue; }

    let query = supabase
      .from("professors")
      .select("first_name, last_name, department, avg_rating, avg_difficulty, num_ratings, would_take_again_pct")
      .gt("num_ratings", 0)
      .order("num_ratings", { ascending: false })
      .limit(1);

    for (const word of words) {
      query = query.or(`first_name.ilike.%${word}%,last_name.ilike.%${word}%`);
    }

    const { data } = await query;
    results.push({ name: instructor, rating: data?.[0] || null });
  }

  return NextResponse.json(results);
}
