import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_KEY!
);

// Gemini 2.5 Flash Vertex AI pricing (per token)
const INPUT_COST_PER_TOKEN = 0.30 / 1_000_000;   // $0.30 per 1M input tokens
const OUTPUT_COST_PER_TOKEN = 2.50 / 1_000_000;   // $2.50 per 1M output tokens

const BUDGET_LIMIT = 150; // dollars — cut off at $150 to preserve credits

export async function checkBudget(): Promise<{ allowed: boolean; totalCost: number }> {
  const { data } = await supabase
    .from("cost_tracking")
    .select("total_cost")
    .eq("id", "global")
    .single();

  const totalCost = data?.total_cost ?? 0;
  return { allowed: totalCost < BUDGET_LIMIT, totalCost };
}

export async function recordUsage(inputTokens: number, outputTokens: number): Promise<number> {
  const cost = (inputTokens * INPUT_COST_PER_TOKEN) + (outputTokens * OUTPUT_COST_PER_TOKEN);

  // Upsert: increment the running total
  const { data: existing } = await supabase
    .from("cost_tracking")
    .select("total_cost, total_input_tokens, total_output_tokens, request_count")
    .eq("id", "global")
    .single();

  if (existing) {
    await supabase
      .from("cost_tracking")
      .update({
        total_cost: existing.total_cost + cost,
        total_input_tokens: existing.total_input_tokens + inputTokens,
        total_output_tokens: existing.total_output_tokens + outputTokens,
        request_count: existing.request_count + 1,
        updated_at: new Date().toISOString(),
      })
      .eq("id", "global");
  } else {
    await supabase
      .from("cost_tracking")
      .insert({
        id: "global",
        total_cost: cost,
        total_input_tokens: inputTokens,
        total_output_tokens: outputTokens,
        request_count: 1,
        updated_at: new Date().toISOString(),
      });
  }

  return (existing?.total_cost ?? 0) + cost;
}
