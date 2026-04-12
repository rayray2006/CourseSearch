import { getProgramSchemaFull, getVisiblePrograms } from "@/lib/data";
import { NextRequest, NextResponse } from "next/server";

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");

  if (name) {
    const row = await getProgramSchemaFull(name);
    if (!row) return NextResponse.json({ error: "No schema found" }, { status: 404 });

    return NextResponse.json({
      program_name: row.program_name,
      url: row.program_url ? `https://e-catalogue.jhu.edu${row.program_url}` : null,
      school: row.school,
      ...JSON.parse(row.schema),
    });
  }

  // List visible programs with schemas
  const rows = await getVisiblePrograms();
  return NextResponse.json(rows);
}
