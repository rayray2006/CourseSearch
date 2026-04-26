import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const maxDuration = 300;

const BASE_URL = "https://sis.jhu.edu/api/classes";

const SCHOOLS = [
  "Krieger School of Arts and Sciences",
  "Krieger School of Arts and Sciences Advanced Academic Programs",
  "Whiting School of Engineering",
];

interface SISCourse {
  OfferingName: string;
  SectionName: string;
  Title: string;
  Credits: string;
  Department: string;
  SchoolName: string;
  Level: string;
  Status: string;
  DOW: string;
  TimeOfDay: string;
  Meetings: string;
  Location: string;
  Building: string;
  InstructionMethod: string;
  Instructors: string;
  InstructorsFullName: string;
  MaxSeats: string;
  OpenSeats: string;
  Waitlisted: string;
  IsWritingIntensive: string;
  Areas: string;
  Repeatable: string;
  Term: string;
  TermStartDate: string;
}

async function getCurrentTerm(supabase: ReturnType<typeof createClient>): Promise<string | null> {
  const { data, error } = await supabase
    .from("available_terms")
    .select("term")
    .eq("is_current", true)
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data.term as string;
}

async function fetchSchool(school: string, term: string, apiKey: string): Promise<SISCourse[]> {
  const url = `${BASE_URL}/${encodeURIComponent(school)}/${encodeURIComponent(term)}?key=${apiKey}`;
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) return [];
  return (await res.json()) as SISCourse[];
}

export async function GET(request: Request) {
  const auth = request.headers.get("authorization");
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const apiKey = process.env.JHU_API_KEY;
  const supaUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_KEY;
  if (!apiKey || !supaUrl || !supaKey) {
    return NextResponse.json({ error: "missing env" }, { status: 500 });
  }

  const supabase = createClient(supaUrl, supaKey);
  const term = await getCurrentTerm(supabase);
  if (!term) return NextResponse.json({ error: "no current term" }, { status: 500 });

  const started = Date.now();
  const allRows: SISCourse[] = [];
  for (const school of SCHOOLS) {
    const rows = await fetchSchool(school, term, apiKey);
    allRows.push(...rows);
  }

  let updated = 0;
  let failed = 0;
  let firstError: string | null = null;
  for (let i = 0; i < allRows.length; i += 500) {
    const chunk = allRows.slice(i, i + 500).map((c) => ({
      offering_name: c.OfferingName,
      section_name: c.SectionName,
      title: c.Title,
      credits: c.Credits,
      department: c.Department,
      school_name: c.SchoolName,
      level: c.Level,
      status: c.Status,
      dow: c.DOW,
      time_of_day: c.TimeOfDay,
      meetings: c.Meetings,
      location: c.Location,
      building: c.Building,
      instruction_method: c.InstructionMethod,
      instructors: c.Instructors,
      instructors_full_name: c.InstructorsFullName,
      max_seats: c.MaxSeats,
      open_seats: c.OpenSeats,
      waitlisted: c.Waitlisted,
      is_writing_intensive: c.IsWritingIntensive,
      areas: c.Areas,
      repeatable: c.Repeatable,
      term: c.Term,
      term_start_date: c.TermStartDate,
    }));
    const { error } = await supabase
      .from("courses")
      .upsert(chunk, { onConflict: "offering_name,section_name,term" });
    if (error) {
      failed += chunk.length;
      if (!firstError) firstError = error.message;
    } else updated += chunk.length;
  }

  return NextResponse.json({
    term,
    fetched: allRows.length,
    updated,
    failed,
    firstError,
    durationMs: Date.now() - started,
  });
}
