import { getSchedule } from "@/lib/schedule-store";
import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json(getSchedule());
}
