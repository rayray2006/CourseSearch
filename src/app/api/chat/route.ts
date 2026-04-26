import { createAgentUIStreamResponse, UIMessage } from "ai";
import { createCourseAgent } from "@/lib/agents/course-agent";
import { setSessionId, setActiveTerm } from "@/lib/tools/schedule-tools";
import { checkBudget, recordUsage } from "@/lib/cost-tracker";
import { cookies } from "next/headers";

export const maxDuration = 60;

export async function POST(req: Request) {
  // Check budget before processing
  const budget = await checkBudget();
  if (!budget.allowed) {
    return new Response(
      `data: {"type":"start"}\n\ndata: {"type":"start-step"}\n\ndata: {"type":"text-start","id":"0"}\n\ndata: {"type":"text-delta","id":"0","delta":"Sorry, the free Gemini API credits for this app have been used up. The service is temporarily unavailable."}\n\ndata: {"type":"text-end","id":"0"}\n\ndata: {"type":"finish-step"}\n\ndata: {"type":"finish","finishReason":"stop"}\n\ndata: [DONE]\n`,
      { status: 200, headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } }
    );
  }

  const { messages, activeTerm: bodyTerm, selectedPrograms: bodyPrograms }: {
    messages: UIMessage[];
    activeTerm?: string;
    selectedPrograms?: string[];
  } = await req.json();

  const activeTerm = bodyTerm || "Fall 2026";
  const selectedPrograms = bodyPrograms || [];

  const cookieStore = await cookies();
  let sessionId = cookieStore.get("schedule_session")?.value;
  if (!sessionId) sessionId = "default";
  setSessionId(sessionId);
  setActiveTerm(activeTerm);

  const hasSisData = activeTerm !== "Spring 2027";

  const agent = createCourseAgent(activeTerm, hasSisData, selectedPrograms);

  try {
    return createAgentUIStreamResponse({
      agent,
      uiMessages: messages,
      onStepFinish: async (event) => {
        // Record token usage for each step (each LLM call, including tool-calling steps)
        const usage = event.usage;
        if (usage?.inputTokens || usage?.outputTokens) {
          const total = await recordUsage(usage.inputTokens || 0, usage.outputTokens || 0);
          console.log(`[cost] step: ${usage.inputTokens || 0} in / ${usage.outputTokens || 0} out — running total: $${total.toFixed(4)}`);
        }
      },
      onError: (error) => {
        console.error("[chat agent error]", error);
        return String(error);
      },
    });
  } catch (e) {
    console.error("[chat route error]", e);
    return new Response(JSON.stringify({ error: "Agent failed" }), { status: 500 });
  }
}
