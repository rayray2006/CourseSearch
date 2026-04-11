import { createAgentUIStreamResponse, UIMessage } from "ai";
import { courseAgent } from "@/lib/agents/course-agent";
import { setSessionId } from "@/lib/tools/schedule-tools";
import { cookies } from "next/headers";

export const maxDuration = 60;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  // Pass session ID to schedule tools
  const cookieStore = await cookies();
  let sessionId = cookieStore.get("schedule_session")?.value;
  if (!sessionId) sessionId = "default";
  setSessionId(sessionId);

  return createAgentUIStreamResponse({
    agent: courseAgent,
    uiMessages: messages,
  });
}
