import { supabase } from "@/lib/supabase";
import { NextResponse, NextRequest } from "next/server";
import { cookies } from "next/headers";

async function getSessionId() {
  const cookieStore = await cookies();
  let sessionId = cookieStore.get("schedule_session")?.value;
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  return sessionId;
}

export async function GET() {
  const sessionId = await getSessionId();

  // Get scheduled course keys
  const { data: scheduleRows } = await supabase
    .from("schedules")
    .select("offering_name, section_name")
    .eq("session_id", sessionId);

  if (!scheduleRows || scheduleRows.length === 0) {
    return NextResponse.json([]);
  }

  // Fetch full course details
  const orFilter = scheduleRows
    .map((r) => `and(offering_name.eq.${r.offering_name},section_name.eq.${r.section_name})`)
    .join(",");

  const { data: courses } = await supabase
    .from("courses")
    .select("offering_name, section_name, title, credits, meetings, location, building, instructors_full_name, instruction_method, department, status, school_name, level")
    .or(orFilter);

  return NextResponse.json(courses || []);
}

export async function POST(req: NextRequest) {
  const sessionId = await getSessionId();
  const { offering_name, section_name } = await req.json();

  const { error } = await supabase.from("schedules").upsert(
    { session_id: sessionId, offering_name, section_name },
    { onConflict: "session_id,offering_name,section_name" }
  );

  const res = NextResponse.json({ success: !error, message: error?.message || "Added" });
  res.cookies.set("schedule_session", sessionId, { httpOnly: true, sameSite: "lax", maxAge: 60 * 60 * 24 * 365 });
  return res;
}

export async function DELETE(req: NextRequest) {
  const sessionId = await getSessionId();
  const { offering_name, section_name } = await req.json();

  await supabase
    .from("schedules")
    .delete()
    .eq("session_id", sessionId)
    .eq("offering_name", offering_name)
    .eq("section_name", section_name);

  return NextResponse.json({ removed: true });
}
