import { getDb } from "@/lib/db";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const db = getDb();

  if (name) {
    const row = db
      .prepare("SELECT program_name, program_url, school, schema FROM program_schemas WHERE program_name = ?")
      .get(name) as { program_name: string; program_url: string; school: string; schema: string } | undefined;

    if (!row) return NextResponse.json({ error: "No schema found" }, { status: 404 });

    return NextResponse.json({
      program_name: row.program_name,
      url: row.program_url ? `https://e-catalogue.jhu.edu${row.program_url}` : null,
      school: row.school,
      ...JSON.parse(row.schema),
    });
  }

  // List visible programs with schemas
  const rows = db
    .prepare("SELECT program_name, school FROM program_schemas WHERE visible = 1 ORDER BY school, program_name")
    .all() as { program_name: string; school: string }[];

  return NextResponse.json(rows);
}
