import { supabase } from "@/lib/supabase";
import { getCoursePosTags } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  if (!code) return NextResponse.json(null);

  const section = req.nextUrl.searchParams.get("section");
  const full = req.nextUrl.searchParams.get("full");
  const term = req.nextUrl.searchParams.get("term") || "Fall 2026";

  // Full course data (for schedule preview)
  if (full && section) {
    const { data } = await supabase
      .from("courses")
      .select("offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status")
      .eq("offering_name", code)
      .eq("section_name", section)
      .eq("term", term)
      .limit(1)
      .single();
    return NextResponse.json(data || null);
  }

  // Get PosTags
  const posTags = await getCoursePosTags(code);

  // Try courses table first (term-scoped)
  const { data } = await supabase
    .from("courses")
    .select("description, prerequisites, corequisites, restrictions, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_evaluations, num_respondents, areas")
    .eq("offering_name", code)
    .eq("term", term)
    .limit(1)
    .single();

  if (data) return NextResponse.json({ ...data, pos_tags: posTags });

  // Fallback to catalogue for future terms
  const { data: catData } = await supabase
    .from("catalogue")
    .select("description, prerequisites, corequisites, restrictions")
    .eq("offering_name", code)
    .limit(1)
    .single();

  if (catData) {
    return NextResponse.json({
      ...catData,
      overall_quality: null,
      instructor_effectiveness: null,
      intellectual_challenge: null,
      workload: null,
      feedback_usefulness: null,
      num_evaluations: 0,
      num_respondents: 0,
      source: "catalogue",
      pos_tags: posTags,
    });
  }

  return NextResponse.json(null);
}
