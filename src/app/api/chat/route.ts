import { createAgentUIStreamResponse, UIMessage } from "ai";
import { courseAgent } from "@/lib/agents/course-agent";

export const maxDuration = 30;

export async function POST(req: Request) {
  const { messages }: { messages: UIMessage[] } = await req.json();

  return createAgentUIStreamResponse({
    agent: courseAgent,
    uiMessages: messages,
  });
}
