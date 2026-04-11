import { getDb } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json(null);

  const db = getDb();

  const course = db
    .prepare(
      `SELECT description, prerequisites, corequisites, restrictions,
              overall_quality, instructor_effectiveness, intellectual_challenge,
              workload, feedback_usefulness, num_evaluations, num_respondents
       FROM courses
       WHERE offering_name = ?
       LIMIT 1`
    )
    .get(code) as Record<string, string | number | null> | undefined;

  return NextResponse.json(course || null);
}
