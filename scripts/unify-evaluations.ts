import { createClient } from "@supabase/supabase-js";

const sb = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Find the sibling course code (undergrad <-> grad)
// Pattern: 4xx <-> 6xx (diff of 200), 3xx <-> 5xx for some departments
function getSiblingCode(code: string): string | null {
  const parts = code.split(".");
  if (parts.length !== 3) return null;
  const num = parseInt(parts[2]);
  if (num >= 400 && num < 500) {
    return `${parts[0]}.${parts[1]}.${num + 200}`;
  }
  if (num >= 600 && num < 700) {
    return `${parts[0]}.${parts[1]}.${num - 200}`;
  }
  // Some departments use 3xx/5xx
  if (num >= 300 && num < 400) {
    return `${parts[0]}.${parts[1]}.${num + 200}`;
  }
  if (num >= 500 && num < 600) {
    return `${parts[0]}.${parts[1]}.${num - 200}`;
  }
  return null;
}

async function main() {
  console.log("Unifying undergrad/grad evaluations...\n");

  // Get all courses with their current eval data
  let allCourses: { offering_name: string; title: string; overall_quality: number | null }[] = [];
  let offset = 0;
  while (true) {
    const { data } = await sb.from("courses")
      .select("offering_name, title, overall_quality")
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    allCourses = allCourses.concat(data);
    if (data.length < 1000) break;
    offset += 1000;
  }

  // Deduplicate by offering_name
  const courseMap = new Map<string, typeof allCourses[0]>();
  for (const c of allCourses) {
    if (!courseMap.has(c.offering_name)) courseMap.set(c.offering_name, c);
  }
  console.log(`Loaded ${courseMap.size} unique courses`);

  // Get all evaluations
  let allEvals: {
    course_code: string;
    overall_quality: number;
    instructor_effectiveness: number;
    intellectual_challenge: number;
    workload: number;
    feedback_usefulness: number;
    num_respondents: number;
  }[] = [];
  offset = 0;
  while (true) {
    const { data } = await sb.from("evaluations")
      .select("course_code, overall_quality, instructor_effectiveness, intellectual_challenge, workload, feedback_usefulness, num_respondents")
      .range(offset, offset + 999);
    if (!data || data.length === 0) break;
    allEvals = allEvals.concat(data as typeof allEvals);
    if (data.length < 1000) break;
    offset += 1000;
  }
  console.log(`Loaded ${allEvals.length} evaluations`);

  // Group evaluations by course code
  const evalsByCode = new Map<string, typeof allEvals>();
  for (const e of allEvals) {
    const arr = evalsByCode.get(e.course_code) || [];
    arr.push(e);
    evalsByCode.set(e.course_code, arr);
  }

  // For each course, compute unified metrics combining sibling evaluations
  let updated = 0;
  let unified = 0;

  for (const [code, course] of courseMap) {
    const siblingCode = getSiblingCode(code);
    const myEvals = evalsByCode.get(code) || [];
    const siblingEvals = siblingCode ? (evalsByCode.get(siblingCode) || []) : [];
    const combinedEvals = [...myEvals, ...siblingEvals];

    if (combinedEvals.length === 0) continue;

    const hasSibling = siblingEvals.length > 0;
    if (hasSibling) unified++;

    // Weighted average by num_respondents
    let totalRespondents = 0;
    let sumQuality = 0, sumInstructor = 0, sumChallenge = 0, sumWorkload = 0, sumFeedback = 0;

    for (const e of combinedEvals) {
      const w = e.num_respondents || 1;
      totalRespondents += w;
      if (e.overall_quality != null) sumQuality += e.overall_quality * w;
      if (e.instructor_effectiveness != null) sumInstructor += e.instructor_effectiveness * w;
      if (e.intellectual_challenge != null) sumChallenge += e.intellectual_challenge * w;
      if (e.workload != null) sumWorkload += e.workload * w;
      if (e.feedback_usefulness != null) sumFeedback += e.feedback_usefulness * w;
    }

    const avg = (sum: number) => totalRespondents > 0 ? Math.round((sum / totalRespondents) * 100) / 100 : null;

    const { error } = await sb.from("courses").update({
      overall_quality: avg(sumQuality),
      instructor_effectiveness: avg(sumInstructor),
      intellectual_challenge: avg(sumChallenge),
      workload: avg(sumWorkload),
      feedback_usefulness: avg(sumFeedback),
      num_respondents: totalRespondents,
      num_evaluations: combinedEvals.length,
    }).eq("offering_name", code);

    if (!error) updated++;
    if (updated % 200 === 0) process.stdout.write(`  Updated ${updated}...\r`);
  }

  console.log(`\nDone! Updated ${updated} courses, ${unified} have unified undergrad/grad evaluations.`);

  // Show an example
  const { data: example } = await sb.from("courses")
    .select("offering_name, title, overall_quality, num_respondents, num_evaluations")
    .in("offering_name", ["EN.601.433", "EN.601.633"])
    .limit(2);
  console.log("\nExample (Intro Algorithms):");
  example?.forEach((c) => console.log(`  ${c.offering_name}: quality=${c.overall_quality}, respondents=${c.num_respondents}, evals=${c.num_evaluations}`));
}

main().catch(console.error);
