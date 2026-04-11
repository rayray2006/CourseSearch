import { supabase } from "@/lib/supabase";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json(null);

  const { data } = await supabase
    .from("courses")
    .select("description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents")
    .eq("offering_name", code)
    .limit(1)
    .single();

  return NextResponse.json(data || null);
}
