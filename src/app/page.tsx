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

// --- Schedule grid constants ---
const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri"];
const HOURS = Array.from({ length: 14 }, (_, i) => i + 8);
const ROW_H = 52; // px per hour row

// --- Meeting parsing ---
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
  const match = part
    .trim()
    .match(/^(\S+)\s+(\d{1,2}):(\d{2})(AM|PM)\s*-\s*(\d{1,2}):(\d{2})(AM|PM)$/);
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
  return meetings
    .split(",")
    .map(parseSingleMeeting)
    .filter((b): b is MeetingBlock => b !== null);
}

// --- Color palette (softer, more distinct) ---
const PALETTE = [
  { bg: "#dbeafe", border: "#93c5fd", text: "#1e3a5f" },
  { bg: "#d1fae5", border: "#6ee7b7", text: "#064e3b" },
  { bg: "#ede9fe", border: "#c4b5fd", text: "#3b0764" },
  { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  { bg: "#fce7f3", border: "#f9a8d4", text: "#831843" },
  { bg: "#ccfbf1", border: "#5eead4", text: "#134e4a" },
  { bg: "#ffedd5", border: "#fdba74", text: "#7c2d12" },
  { bg: "#e0e7ff", border: "#a5b4fc", text: "#312e81" },
];

// --- Markdown helper ---
function md(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.*?)\*/g, "<em>$1</em>")
    .replace(
      /`(.*?)`/g,
      '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:0.7rem;font-family:var(--font-mono)">$1</code>'
    )
    .replace(/\n/g, "<br/>");
}

// ===================== COMPONENT =====================

export default function Home() {
  const { messages, sendMessage, status } = useChat<CourseAgentUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });
  const [input, setInput] = useState("");
  const [schedule, setSchedule] = useState<ScheduledCourse[]>([]);
  const [selected, setSelected] = useState<ScheduledCourse | null>(null);
  const [profRating, setProfRating] = useState<{
    first_name: string;
    last_name: string;
    department: string;
    avg_rating: number;
    avg_difficulty: number;
    num_ratings: number;
    would_take_again_pct: number | null;
  } | null | "loading" | "none">(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const fetchSchedule = useCallback(async () => {
    const res = await fetch("/api/schedule");
    if (res.ok) setSchedule(await res.json());
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    if (status === "ready") fetchSchedule();
  }, [status, fetchSchedule]);

  useEffect(() => {
    fetchSchedule();
  }, [fetchSchedule]);

  // Click outside to dismiss detail panel
  useEffect(() => {
    if (!selected) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        setSelected(null);
        setProfRating(null);
      }
    }
    // Delay to avoid the click that opened the panel from immediately closing it
    const id = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [selected]);

  // Fetch professor rating when a course is selected
  useEffect(() => {
    if (!selected) { setProfRating(null); return; }
    const name = selected.instructors_full_name;
    if (!name || name === "Staff") { setProfRating("none"); return; }
    setProfRating("loading");
    fetch(`/api/professor?name=${encodeURIComponent(name)}`)
      .then((r) => r.json())
      .then((data) => setProfRating(data || "none"))
      .catch(() => setProfRating("none"));
  }, [selected]);

  const isLoading = status === "submitted" || status === "streaming";

  // Color assignment
  const colorOf = useCallback(
    (c: ScheduledCourse) => {
      const idx = schedule.findIndex(
        (s) =>
          s.offering_name === c.offering_name &&
          s.section_name === c.section_name
      );
      return PALETTE[idx % PALETTE.length];
    },
    [schedule]
  );

  const totalCredits = schedule.reduce((sum, c) => {
    const n = parseFloat(c.credits);
    return sum + (isNaN(n) ? 0 : n);
  }, 0);

  // Build positioned blocks for the grid
  const blocks: {
    course: ScheduledCourse;
    dayIdx: number;
    top: number;
    height: number;
  }[] = [];
  schedule.forEach((course) => {
    const mbs = parseMeetings(course.meetings);
    mbs.forEach((mb) => {
      mb.days.forEach((dayIdx) => {
        if (dayIdx > 4) return;
        blocks.push({
          course,
          dayIdx,
          top: (mb.startHour - 8) * ROW_H + (mb.startMin / 60) * ROW_H,
          height:
            (mb.endHour - mb.startHour) * ROW_H +
            ((mb.endMin - mb.startMin) / 60) * ROW_H,
        });
      });
    });
  });

  return (
    <div className="flex h-full">
      {/* ---- LEFT: Schedule ---- */}
      <main className="flex-1 flex flex-col min-w-0">
        {/* Top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-white/80 backdrop-blur-sm shrink-0">
          <div className="flex items-baseline gap-3">
            <h1 className="text-base font-semibold text-slate-900 tracking-tight">
              JHU Course Planner
            </h1>
            <span className="text-[11px] font-medium text-slate-400 uppercase tracking-wider">
              Fall 2026
            </span>
          </div>
          {schedule.length > 0 && (
            <div className="flex items-center gap-4 text-xs text-slate-500">
              <span>
                <span className="font-semibold text-slate-700">
                  {schedule.length}
                </span>{" "}
                course{schedule.length !== 1 && "s"}
              </span>
              <span className="w-px h-3 bg-slate-200" />
              <span>
                <span className="font-semibold text-slate-700">
                  {totalCredits}
                </span>{" "}
                credits
              </span>
            </div>
          )}
        </div>

        {/* Grid area */}
        <div className="flex-1 overflow-auto relative">
          {schedule.length === 0 ? (
            <div className="flex items-center justify-center h-full">
              <div className="text-center space-y-2 max-w-xs">
                <div className="mx-auto w-12 h-12 rounded-xl bg-slate-100 flex items-center justify-center text-slate-300 text-xl">
                  +
                </div>
                <p className="text-sm font-medium text-slate-500">
                  Your schedule is empty
                </p>
                <p className="text-xs text-slate-400 leading-relaxed">
                  Search for courses in the chat panel and ask to add them to
                  your schedule.
                </p>
              </div>
            </div>
          ) : (
            <div className="min-w-[640px] p-4">
              {/* Day headers */}
              <div
                className="grid sticky top-0 z-10 bg-slate-50/95 backdrop-blur-sm"
                style={{
                  gridTemplateColumns: "52px repeat(5, 1fr)",
                }}
              >
                <div />
                {DAYS_SHORT.map((d) => (
                  <div
                    key={d}
                    className="text-center text-[11px] font-semibold text-slate-400 uppercase tracking-wider py-2"
                  >
                    {d}
                  </div>
                ))}
              </div>

              {/* Grid body */}
              <div
                className="relative grid"
                style={{
                  gridTemplateColumns: "52px repeat(5, 1fr)",
                }}
              >
                {/* Hour rows */}
                {HOURS.map((h) => (
                  <div key={h} className="contents">
                    <div
                      className="text-[10px] text-slate-400 text-right pr-2 -translate-y-1.5 select-none"
                      style={{ height: ROW_H }}
                    >
                      {h > 12 ? h - 12 : h} {h >= 12 ? "pm" : "am"}
                    </div>
                    {DAYS_SHORT.map((_, di) => (
                      <div
                        key={di}
                        className="border-t border-slate-100"
                        style={{ height: ROW_H }}
                      />
                    ))}
                  </div>
                ))}

                {/* Course blocks */}
                {blocks.map((block) => {
                  const siblings = blocks.filter(
                    (b) =>
                      b.dayIdx === block.dayIdx &&
                      b.top < block.top + block.height &&
                      b.top + b.height > block.top
                  );
                  siblings.sort((a, b) => {
                    const ka = `${a.course.offering_name}::${a.course.section_name}`;
                    const kb = `${b.course.offering_name}::${b.course.section_name}`;
                    return ka.localeCompare(kb);
                  });
                  const idx = siblings.indexOf(block);
                  const total = siblings.length;
                  const pal = colorOf(block.course);

                  return (
                    <div
                      key={`${block.course.offering_name}-${block.course.section_name}-${block.dayIdx}-${block.top}`}
                      className="absolute rounded-lg overflow-hidden group cursor-pointer transition-shadow hover:shadow-md"
                      style={{
                        top: block.top,
                        height: block.height,
                        left: `calc(52px + ${block.dayIdx} * ((100% - 52px) / 5) + 3px + ${idx} * ((100% - 52px) / 5 - 6px) / ${total})`,
                        width: `calc(((100% - 52px) / 5 - 6px) / ${total})`,
                        background: pal.bg,
                        borderLeft: `3px solid ${pal.border}`,
                        color: pal.text,
                      }}
                      onClick={() => setSelected(block.course)}
                    >
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          sendMessage({
                            text: `Remove ${block.course.offering_name} section ${block.course.section_name} from my schedule`,
                          });
                          if (selected?.offering_name === block.course.offering_name && selected?.section_name === block.course.section_name) {
                            setSelected(null);
                          }
                        }}
                        className="absolute top-1 right-1 w-4 h-4 rounded-full flex items-center justify-center text-[9px] opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:bg-black/10 transition-all"
                        title="Remove"
                      >
                        &#10005;
                      </button>
                      <div className="px-2 py-1.5 h-full flex flex-col">
                        <span className="text-[10px] font-bold leading-none truncate">
                          {block.course.offering_name}
                        </span>
                        <span className="text-[10px] leading-snug truncate mt-0.5 opacity-80">
                          {block.course.title}
                        </span>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Course detail panel */}
          {selected && (
            <div
              ref={panelRef}
              className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] z-20"
            >
              <div className="px-5 py-4 max-w-2xl">
                {/* Header row */}
                <div className="flex items-start justify-between gap-4 mb-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono font-medium text-slate-400">
                        {selected.offering_name}
                      </span>
                      <span className="text-[11px] text-slate-300">
                        Section {selected.section_name}
                      </span>
                    </div>
                    <h3 className="text-sm font-semibold text-slate-900 mt-0.5">
                      {selected.title}
                    </h3>
                  </div>
                  <button
                    onClick={() => { setSelected(null); setProfRating(null); }}
                    className="shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors text-xs"
                  >
                    &#10005;
                  </button>
                </div>

                {/* Info grid */}
                <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-[12px]">
                  <div>
                    <span className="text-slate-400">Credits</span>
                    <p className="text-slate-700 font-medium">{selected.credits}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Instructor</span>
                    <p className="text-slate-700 font-medium">{selected.instructors_full_name || "Staff"}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Schedule</span>
                    <p className="text-slate-700 font-medium">{selected.meetings || "TBA"}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Location</span>
                    <p className="text-slate-700 font-medium">
                      {[selected.building, selected.location].filter(Boolean).join(", ") || "TBA"}
                    </p>
                  </div>
                  <div>
                    <span className="text-slate-400">Department</span>
                    <p className="text-slate-700 font-medium">{selected.department}</p>
                  </div>
                  <div>
                    <span className="text-slate-400">Format</span>
                    <p className="text-slate-700 font-medium">{selected.instruction_method || "N/A"}</p>
                  </div>
                </div>

                {/* Professor rating inline */}
                <div className="mt-3 pt-3 border-t border-slate-100">
                  <span className="text-[11px] text-slate-400">RateMyProfessors</span>
                  <div className="mt-1 text-[12px]">
                    {profRating === "loading" && (
                      <span className="text-slate-400">Loading...</span>
                    )}
                    {profRating === "none" && (
                      <span className="text-slate-400">N/A — no ratings found</span>
                    )}
                    {profRating !== null && profRating !== "loading" && profRating !== "none" && (
                      <div className="flex items-center gap-4 text-slate-700">
                        <span>
                          <span className="font-semibold">{profRating.avg_rating.toFixed(1)}</span>
                          <span className="text-slate-400">/5 rating</span>
                        </span>
                        <span>
                          <span className="font-semibold">{profRating.avg_difficulty.toFixed(1)}</span>
                          <span className="text-slate-400">/5 difficulty</span>
                        </span>
                        {profRating.would_take_again_pct !== null && profRating.would_take_again_pct >= 0 && (
                          <span>
                            <span className="font-semibold">{Math.round(profRating.would_take_again_pct)}%</span>
                            <span className="text-slate-400"> would retake</span>
                          </span>
                        )}
                        <span className="text-slate-400 text-[11px]">
                          ({profRating.num_ratings} rating{profRating.num_ratings !== 1 && "s"})
                        </span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="mt-3 pt-3 border-t border-slate-100 flex gap-2">
                  <button
                    onClick={() => {
                      sendMessage({
                        text: `Tell me more about ${selected.offering_name}, including description and prerequisites`,
                      });
                      setSelected(null);
                      setProfRating(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-slate-100 text-slate-600 hover:bg-slate-200 transition-colors"
                  >
                    More details
                  </button>
                  <button
                    onClick={() => {
                      sendMessage({
                        text: `Remove ${selected.offering_name} section ${selected.section_name} from my schedule`,
                      });
                      setSelected(null);
                      setProfRating(null);
                    }}
                    className="px-3 py-1.5 rounded-lg text-[11px] font-medium bg-red-50 text-red-600 hover:bg-red-100 transition-colors"
                  >
                    Remove from schedule
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ---- RIGHT: Chat ---- */}
      <aside className="w-[380px] shrink-0 border-l border-slate-200 bg-white flex flex-col">
        {/* Chat header */}
        <div className="px-4 py-3 border-b border-slate-100 shrink-0">
          <p className="text-xs font-semibold text-slate-700 tracking-tight">
            Course Assistant
          </p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && (
            <div className="pt-6 space-y-4">
              <p className="text-[13px] text-slate-500 leading-relaxed">
                I can help you find courses, check prerequisites, and build your
                schedule. Try:
              </p>
              <div className="space-y-1.5">
                {[
                  "Show me upper-level CS courses",
                  "What are the prereqs for Data Structures?",
                  "Find 3-credit MWF morning classes",
                  "Courses about machine learning",
                ].map((s) => (
                  <button
                    key={s}
                    onClick={() => sendMessage({ text: s })}
                    className="block w-full text-left px-3 py-2 rounded-lg text-xs text-slate-600 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                  >
                    {s}
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
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 ${
                  message.role === "user"
                    ? "bg-slate-800 text-white"
                    : "bg-slate-100 text-slate-800"
                }`}
              >
                {message.parts.map((part, i) => {
                  if (part.type === "text") {
                    return (
                      <div
                        key={i}
                        className="text-[12px] leading-[1.6] [&>strong]:font-semibold"
                        dangerouslySetInnerHTML={{ __html: md(part.text) }}
                      />
                    );
                  }
                  if (isToolUIPart(part)) {
                    if (part.state === "output-available") return null;
                    return (
                      <div
                        key={i}
                        className="flex items-center gap-1.5 text-[11px] text-slate-400 py-0.5"
                      >
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />
                        Searching...
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
              <div className="bg-slate-100 rounded-2xl px-3.5 py-2.5">
                <div className="flex items-center gap-2 text-[11px] text-slate-400">
                  <span className="flex gap-0.5">
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:0ms]" />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:150ms]" />
                    <span className="w-1 h-1 rounded-full bg-slate-400 animate-bounce [animation-delay:300ms]" />
                  </span>
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="px-4 py-3 border-t border-slate-100 shrink-0">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (input.trim() && !isLoading) {
                sendMessage({ text: input });
                setInput("");
              }
            }}
            className="flex items-center gap-2"
          >
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={isLoading}
              placeholder="Ask about courses..."
              className="flex-1 px-3 py-2 rounded-xl bg-slate-50 border border-slate-200 text-[12px] placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500/40 focus:border-blue-300 disabled:opacity-50 transition-all"
            />
            <button
              type="submit"
              disabled={isLoading || !input.trim()}
              className="p-2 rounded-xl bg-slate-800 text-white disabled:opacity-30 hover:bg-slate-700 transition-colors"
              aria-label="Send"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="22" y1="2" x2="11" y2="13" />
                <polygon points="22 2 15 22 11 13 2 9 22 2" />
              </svg>
            </button>
          </form>
        </div>
      </aside>
    </div>
  );
}
