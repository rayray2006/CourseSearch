"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { isToolUIPart } from "ai";
import { useState, useRef, useEffect, useCallback } from "react";
import type { CourseAgentUIMessage } from "@/lib/agents/course-agent";

interface ScheduledCourse {
  offering_name: string;
  section_name: string;
  title: string;
  credits: string;
  meetings: string;
  location: string;
  building: string;
  instructors_full_name: string;
  instruction_method: string;
  department: string;
}

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
const HOURS = Array.from({ length: 14 }, (_, i) => i + 8); // 8 AM to 9 PM

interface MeetingBlock {
  days: number[];
  startHour: number;
  startMin: number;
  endHour: number;
  endMin: number;
}

const DAY_MAP: Record<string, number[]> = {
  M: [0], T: [1], W: [2], Th: [3], F: [4], Sa: [5], S: [6],
  MW: [0, 2], MF: [0, 4], MWF: [0, 2, 4], TTh: [1, 3],
  MT: [0, 1], MTW: [0, 1, 2], TWTh: [1, 2, 3], WF: [2, 4],
  TF: [1, 4], ThF: [3, 4],
  TWThF: [1, 2, 3, 4], MTWThF: [0, 1, 2, 3, 4], MTThF: [0, 1, 3, 4],
};

function parseSingleMeeting(part: string): MeetingBlock | null {
  const match = part.trim().match(/^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)$/);
  if (!match) return null;

  const [, dayStr, sh, sm, sap, eh, em, eap] = match;
  let startHour = parseInt(sh);
  const startMin = parseInt(sm);
  if (sap === "PM" && startHour !== 12) startHour += 12;
  if (sap === "AM" && startHour === 12) startHour = 0;

  let endHour = parseInt(eh);
  const endMin = parseInt(em);
  if (eap === "PM" && endHour !== 12) endHour += 12;
  if (eap === "AM" && endHour === 12) endHour = 0;

  const days = DAY_MAP[dayStr];
  if (!days) return null;

  return { days, startHour, startMin, endHour, endMin };
}

function parseMeetings(meetings: string): MeetingBlock[] {
  if (!meetings || meetings === "TBA") return [];
  // Split on comma for multi-part meetings like "T 1:30PM - 4:15PM, Th 1:30PM - 4:15PM"
  const parts = meetings.split(",");
  const blocks: MeetingBlock[] = [];
  for (const part of parts) {
    const parsed = parseSingleMeeting(part);
    if (parsed) blocks.push(parsed);
  }
  return blocks;
}

const COLORS = [
  "bg-blue-100 border-blue-300 text-blue-900",
  "bg-emerald-100 border-emerald-300 text-emerald-900",
  "bg-purple-100 border-purple-300 text-purple-900",
  "bg-amber-100 border-amber-300 text-amber-900",
  "bg-rose-100 border-rose-300 text-rose-900",
  "bg-cyan-100 border-cyan-300 text-cyan-900",
  "bg-orange-100 border-orange-300 text-orange-900",
  "bg-indigo-100 border-indigo-300 text-indigo-900",
];

export default function Home() {
  const { messages, sendMessage, status } = useChat<CourseAgentUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");
  const [schedule, setSchedule] = useState<ScheduledCourse[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const fetchSchedule = useCallback(async () => {
    const res = await fetch("/api/schedule");
    if (res.ok) setSchedule(await res.json());
  }, []);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Poll schedule after each assistant message finishes
  useEffect(() => {
    if (status === "ready") fetchSchedule();
  }, [status, fetchSchedule]);

  // Initial load
  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  const isLoading = status === "submitted" || status === "streaming";

  const colorMap = new Map<string, string>();
  schedule.forEach((c, i) => {
    colorMap.set(`${c.offering_name}::${c.section_name}`, COLORS[i % COLORS.length]);
  });

  const totalCredits = schedule.reduce((sum, c) => {
    const parsed = parseFloat(c.credits);
    return sum + (isNaN(parsed) ? 0 : parsed);
  }, 0);

  return (
    <div className="flex flex-col h-screen bg-gray-50">
      {/* Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-3 flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-lg font-semibold text-gray-900">
            JHU Course Planner
          </h1>
          <p className="text-xs text-gray-500">Fall 2026</p>
        </div>
        <div className="text-sm text-gray-600">
          <span className="font-medium">{schedule.length}</span> courses
          {" / "}
          <span className="font-medium">{totalCredits}</span> credits
        </div>
      </header>

      <div className="flex flex-1 overflow-hidden">
        {/* Schedule Panel (Left) */}
        <div className="flex-1 overflow-auto p-4">
          {schedule.length === 0 ? (
            <div className="flex items-center justify-center h-full text-gray-400">
              <div className="text-center">
                <p className="text-lg mb-1">No courses yet</p>
                <p className="text-sm">
                  Use the chat to search and add courses
                </p>
              </div>
            </div>
          ) : (
            <div className="h-full overflow-auto">
              <div className="min-w-[600px]">
                {/* Day headers */}
                <div className="grid grid-cols-[60px_repeat(5,1fr)] sticky top-0 bg-gray-50 z-10 border-b border-gray-200">
                  <div />
                  {DAYS.map((day) => (
                    <div
                      key={day}
                      className="text-center text-xs font-medium text-gray-500 py-2 border-l border-gray-200"
                    >
                      {day}
                    </div>
                  ))}
                </div>

                {/* Time grid */}
                <div className="relative grid grid-cols-[60px_repeat(5,1fr)]">
                  {/* Hour labels + lines */}
                  {HOURS.map((hour) => (
                    <div key={hour} className="contents">
                      <div className="h-12 text-xs text-gray-400 text-right pr-2 pt-0 -mt-2">
                        {hour > 12 ? hour - 12 : hour}
                        {hour >= 12 ? "PM" : "AM"}
                      </div>
                      {DAYS.map((_, di) => (
                        <div
                          key={di}
                          className="h-12 border-l border-t border-gray-200"
                        />
                      ))}
                    </div>
                  ))}

                  {/* Course blocks with overlap handling */}
                  {(() => {
                    // Build list of all blocks with their positions
                    const blocks: {
                      course: ScheduledCourse;
                      dayIdx: number;
                      topOffset: number;
                      height: number;
                      color: string;
                    }[] = [];

                    schedule.forEach((course) => {
                      const meetingBlocks = parseMeetings(course.meetings);
                      if (meetingBlocks.length === 0) return;
                      const color =
                        colorMap.get(
                          `${course.offering_name}::${course.section_name}`
                        ) || COLORS[0];

                      meetingBlocks.forEach((mb) => {
                        mb.days.forEach((dayIdx) => {
                          if (dayIdx > 4) return;
                          const topOffset =
                            (mb.startHour - 8) * 48 +
                            (mb.startMin / 60) * 48;
                          const height =
                            (mb.endHour - mb.startHour) * 48 +
                            ((mb.endMin - mb.startMin) / 60) * 48;
                          blocks.push({ course, dayIdx, topOffset, height, color });
                        });
                      });
                    });

                    // For each block, find overlapping siblings on same day
                    return blocks.map((block) => {
                      const overlapping = blocks.filter(
                        (b) =>
                          b.dayIdx === block.dayIdx &&
                          b.topOffset < block.topOffset + block.height &&
                          b.topOffset + b.height > block.topOffset
                      );
                      // Sort overlapping group consistently so index is stable
                      overlapping.sort((a, b) => {
                        const keyA = `${a.course.offering_name}::${a.course.section_name}`;
                        const keyB = `${b.course.offering_name}::${b.course.section_name}`;
                        return keyA.localeCompare(keyB);
                      });
                      const overlapIndex = overlapping.indexOf(block);
                      const overlapCount = overlapping.length;

                      return (
                        <div
                          key={`${block.course.offering_name}-${block.course.section_name}-${block.dayIdx}`}
                          className={`absolute border rounded-md px-1 py-0.5 overflow-hidden text-xs leading-tight group ${block.color}`}
                          style={{
                            top: `${block.topOffset}px`,
                            height: `${block.height}px`,
                            left: `calc(60px + ${block.dayIdx} * ((100% - 60px) / 5) + 2px + ${overlapIndex} * ((100% - 60px) / 5 - 4px) / ${overlapCount})`,
                            width: `calc(((100% - 60px) / 5 - 4px) / ${overlapCount})`,
                          }}
                        >
                          <button
                            onClick={() => {
                              sendMessage({
                                text: `Remove ${block.course.offering_name} section ${block.course.section_name} from my schedule`,
                              });
                            }}
                            className="absolute top-0 right-0 w-4 h-4 flex items-center justify-center text-[10px] opacity-0 group-hover:opacity-70 hover:!opacity-100 transition-opacity bg-white/50 rounded-bl"
                            title="Remove from schedule"
                          >
                            ✕
                          </button>
                          <div className="font-semibold truncate">
                            {block.course.offering_name}
                          </div>
                          <div className="truncate">{block.course.title}</div>
                        </div>
                      );
                    });
                  })()}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Chat Sidebar (Right) */}
        <div className="w-[400px] border-l border-gray-200 bg-white flex flex-col shrink-0">
          {/* Chat messages */}
          <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3">
            {messages.length === 0 && (
              <div className="text-center py-8">
                <p className="text-sm font-medium text-gray-700 mb-2">
                  Ask me about courses
                </p>
                <div className="space-y-1.5">
                  {[
                    "What CS courses are available?",
                    "Find morning MWF classes",
                    "Show me writing intensive courses",
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      onClick={() => sendMessage({ text: suggestion })}
                      className="block w-full px-3 py-1.5 bg-gray-50 border border-gray-200 rounded-lg text-xs text-gray-600 hover:bg-blue-50 hover:border-blue-200 transition-colors text-left"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {messages.map((message) => (
              <div
                key={message.id}
                className={`flex ${message.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[90%] rounded-xl px-3 py-2 ${
                    message.role === "user"
                      ? "bg-blue-600 text-white"
                      : "bg-gray-100 text-gray-900"
                  }`}
                >
                  {message.parts.map((part, i) => {
                    if (part.type === "text") {
                      return (
                        <div
                          key={i}
                          className="whitespace-pre-wrap text-xs leading-relaxed"
                          dangerouslySetInnerHTML={{
                            __html: formatMarkdown(part.text),
                          }}
                        />
                      );
                    }
                    if (isToolUIPart(part)) {
                      if (part.state === "output-available") return null;
                      return (
                        <div
                          key={i}
                          className="flex items-center gap-1.5 text-xs text-gray-400 py-0.5"
                        >
                          <span className="animate-pulse">&#9679;</span>
                          Working...
                        </div>
                      );
                    }
                    return null;
                  })}
                </div>
              </div>
            ))}

            {isLoading && messages[messages.length - 1]?.role === "user" && (
              <div className="flex justify-start">
                <div className="bg-gray-100 rounded-xl px-3 py-2">
                  <div className="flex items-center gap-1.5 text-xs text-gray-400">
                    <span className="animate-pulse">&#9679;</span>
                    Thinking...
                  </div>
                </div>
              </div>
            )}

            <div ref={messagesEndRef} />
          </div>

          {/* Chat input */}
          <div className="border-t border-gray-200 px-3 py-3">
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (input.trim() && !isLoading) {
                  sendMessage({ text: input });
                  setInput("");
                }
              }}
              className="flex gap-2"
            >
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                disabled={isLoading}
                placeholder="Search courses or manage schedule..."
                className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent text-xs disabled:opacity-50"
              />
              <button
                type="submit"
                disabled={isLoading || !input.trim()}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg font-medium text-xs hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                Send
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}

function formatMarkdown(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(
      /`(.*?)`/g,
      '<code style="background:#e5e7eb;padding:0 3px;border-radius:3px;font-size:11px">$1</code>'
    )
    .replace(/\n/g, "<br />");
}
