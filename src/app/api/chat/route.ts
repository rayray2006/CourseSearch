import { createAgentUIStreamResponse, UIMessage } from "ai";
import { createCourseAgent } from "@/lib/agents/course-agent";
import { setSessionId, setActiveTerm } from "@/lib/tools/schedule-tools";
import { cookies } from "next/headers";

export const maxDuration = 60;

export async function POST(req: Request) {
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
