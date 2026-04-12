"use client";

import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { isToolUIPart } from "ai";
import { useState, useRef, useEffect, useCallback, useMemo } from "react";
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
  const lines = text.split("\n");
  let inList = false;
  let listLevel = 0;
  const out: string[] = [];

  for (const raw of lines) {
    let line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

    // Inline formatting
    line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    line = line.replace(
      /`(.*?)`/g,
      '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:0.7rem;font-family:var(--font-mono)">$1</code>'
    );

    const subBullet = line.match(/^ {2,}\* (.+)/);
    const topBullet = line.match(/^\* (.+)/);

    if (subBullet) {
      if (!inList) { inList = true; listLevel = 1; }
      listLevel = 1;
      out.push(`<div style="padding-left:12px;margin-top:1px">${subBullet[1]}</div>`);
    } else if (topBullet) {
      if (inList) {
        out.push('<div style="margin-top:10px"></div>');
      }
      inList = true;
      listLevel = 0;
      out.push(`<div>${topBullet[1]}</div>`);
    } else {
      if (inList) { inList = false; listLevel = 0; }
      line = line.replace(/\*(.*?)\*/g, "<em>$1</em>");
      if (line.trim() === "") {
        out.push('<div style="margin-top:6px"></div>');
      } else {
        out.push(`<div>${line}</div>`);
      }
    }
  }

  return out.join("");
}

// Match course codes and section lines separately
const COURSE_CODE_RE = /[A-Z]{2}\.\d{3}\.\d{3}/g;
const SECTION_RE = /Section\s+(\d{2})/g;

function MessageContent({ html, onAdd, onPreview, onPreviewEnd, validCourses }: {
  html: string;
  onAdd: (code: string, section: string) => void;
  onPreview: (code: string, section: string) => void;
  onPreviewEnd: () => void;
  validCourses: Set<string>;
}) {
  // Combined regex: match either a course code or a "Section NN" pattern
  const TOKEN_RE = /([A-Z]{2}\.\d{3}\.\d{3})|Section\s+(\d{2})/g;
  const parts: { type: "html" | "code" | "section"; text: string; value?: string }[] = [];
  let lastIdx = 0;

  const matches = [...html.matchAll(TOKEN_RE)];
  for (const match of matches) {
    const idx = match.index!;
    if (idx > lastIdx) parts.push({ type: "html", text: html.slice(lastIdx, idx) });
    if (match[1]) {
      // Course code like EN.601.230 — also grab the course name that follows
      // e.g. "EN.601.226 Data Structures" or "EN.601.226</strong> Data Structures"
      let endIdx = idx + match[0].length;
      const rest = html.slice(endIdx);
      // Grab trailing text: course name up to em dash (—), HTML tag, line break, another course code, or "Section"
      // Must handle HTML entities (&amp;), hyphens, colons, parens, etc.
      const nameMatch = rest.match(/^((?:\s+(?!Section\s)(?!<)(?!—)(?!\u2014)(?![A-Z]{2}\.\d{3}\.\d{3})(?:&amp;|&lt;|&gt;|[^\s<—\u2014])+)*)/);
      const trailingName = nameMatch ? nameMatch[0] : "";
      endIdx += trailingName.length;
      parts.push({ type: "code", text: html.slice(idx, endIdx), value: match[1] });
      lastIdx = endIdx;
      continue;
    } else if (match[2]) {
      // Section NN
      parts.push({ type: "section", text: match[0], value: match[2] });
    }
    lastIdx = idx + match[0].length;
  }
  if (lastIdx < html.length) parts.push({ type: "html", text: html.slice(lastIdx) });

  if (matches.length === 0) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  // Pre-compute: parent course code for each section, and section count per course code
  const sectionCourseMap = new Map<number, string>();
  const codeSectionCount = new Map<number, number>();
  const codeFirstSection = new Map<number, string>(); // for single-section courses
  let currentCode = "";
  let currentCodeIdx = -1;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].type === "code") {
      currentCode = parts[i].value!;
      currentCodeIdx = i;
      codeSectionCount.set(i, 0);
    }
    if (parts[i].type === "section" && currentCodeIdx >= 0) {
      sectionCourseMap.set(i, currentCode);
      codeSectionCount.set(currentCodeIdx, (codeSectionCount.get(currentCodeIdx) || 0) + 1);
      if (!codeFirstSection.has(currentCodeIdx)) codeFirstSection.set(currentCodeIdx, parts[i].value!);
    }
  }

  const addBtn = (code: string, section: string) => (
    <button
      onClick={(e) => { e.stopPropagation(); onAdd(code, section); }}
      onMouseEnter={() => onPreview(code, section)}
      onMouseLeave={onPreviewEnd}
      className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-full bg-emerald-100 text-emerald-600 hover:bg-emerald-200 text-[9px] font-bold leading-none transition-colors flex-shrink-0 align-middle ml-0.5"
      title={`Add ${code} section ${section}`}
    >+</button>
  );

  return (
    <span>
      {parts.map((p, i) => {
        if (p.type === "html") {
          return <span key={i} dangerouslySetInnerHTML={{ __html: p.text }} />;
        }
        if (p.type === "code") {
          const isValid = validCourses.has(p.value!);
          const sections = codeSectionCount.get(i) || 0;
          if (sections <= 1 && isValid) {
            const section = codeFirstSection.get(i) || "01";
            return <strong key={i}>{p.text}{addBtn(p.value!, section)}</strong>;
          }
          return <strong key={i}>{p.text}</strong>;
        }
        if (p.type === "section") {
          const courseCode = sectionCourseMap.get(i) || "";
          if (!courseCode || !validCourses.has(courseCode)) return <span key={i}>{p.text}</span>;
          return <span key={i}>{p.text}{addBtn(courseCode, p.value!)}</span>;
        }
        return <span key={i}>{p.text}</span>;
      })}
    </span>
  );
}

// --- Parse prerequisites: split on ";" into restrictions vs actual prereqs ---
const RESTRICTION_PATTERNS = [
  /^students?\s+(may|can|must|should)\s+(not|only|receive|earn)/i,
  /^student\s+may\s+not\s+enroll/i,
  /^credit\s+(may|can)\s+(only|not)/i,
  /^you\s+(cannot|can\s+not|may\s+not)/i,
];

function splitPrerequisites(raw: string): { restrictions: string[]; prereqs: string[] } {
  const parts = raw.split(";").map((s) => s.trim()).filter(Boolean);
  const restrictions: string[] = [];
  const prereqs: string[] = [];
  for (const part of parts) {
    if (RESTRICTION_PATTERNS.some((p) => p.test(part))) {
      restrictions.push(part);
    } else {
      prereqs.push(part);
    }
  }
  return { restrictions, prereqs };
}

// ===================== COMPONENT =====================

export default function Home() {
  const { messages, sendMessage, setMessages, status, error } = useChat<CourseAgentUIMessage>({
    transport: new DefaultChatTransport({ api: "/api/chat" }),
  });

  // Debug: log status transitions and errors
  useEffect(() => {
    if (error) console.error("[chat error]", error);
  }, [error]);
  useEffect(() => {
    console.log("[chat status]", status, "messages:", messages.length, "last role:", messages[messages.length - 1]?.role);
  }, [status, messages]);
  const [input, setInput] = useState("");
  const [schedule, setSchedule] = useState<ScheduledCourse[]>([]);
  const [selected, setSelected] = useState<ScheduledCourse | null>(null);
  const [previewCourse, setPreviewCourse] = useState<ScheduledCourse | null>(null);

  // Build set of valid course codes from tool outputs in messages
  const validCourses = useMemo(() => {
    const codes = new Set<string>();
    for (const msg of messages) {
      for (const part of msg.parts) {
        if ("output" in part && part.output) {
          try {
            const output = part.output as Record<string, unknown>;
            const courses = (output.courses || output.results) as Record<string, string>[] | undefined;
            if (Array.isArray(courses)) {
              for (const c of courses) {
                if (c.offering_name) codes.add(c.offering_name);
              }
            }
          } catch { /* ignore */ }
        }
      }
    }
    return codes;
  }, [messages]);

  // Cache fetched course data for preview hover
  const previewCache = useRef(new Map<string, ScheduledCourse | null>());
  const handlePreview = useCallback(async (code: string, section: string) => {
    const key = `${code}::${section}`;
    if (previewCache.current.has(key)) {
      setPreviewCourse(previewCache.current.get(key) || null);
      return;
    }
    try {
      const res = await fetch(`/api/course-detail?code=${encodeURIComponent(code)}&section=${encodeURIComponent(section)}&full=1`);
      if (!res.ok) { setPreviewCourse(null); return; }
      const data = await res.json();
      if (data?.offering_name) {
        previewCache.current.set(key, data);
        setPreviewCourse(data);
      }
    } catch {
      setPreviewCourse(null);
    }
  }, []);
  const clearPreview = useCallback(() => setPreviewCourse(null), []);
  interface ProfRatingResult {
    name: string;
    rating: {
      first_name: string;
      last_name: string;
      avg_rating: number;
      avg_difficulty: number;
      num_ratings: number;
      would_take_again_pct: number | null;
    } | null;
  }
  const [profRatings, setProfRatings] = useState<ProfRatingResult[] | "loading" | null>(null);
  interface CourseDetail {
    description: string | null;
    prerequisites: string | null;
    corequisites: string | null;
    restrictions: string | null;
    overall_quality: number | null;
    instructor_effectiveness: number | null;
    intellectual_challenge: number | null;
    workload: number | null;
    feedback_usefulness: number | null;
    num_evaluations: number | null;
    num_respondents: number | null;
  }
  const [courseDetail, setCourseDetail] = useState<CourseDetail | "loading" | null>(null);
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

  // Click outside to dismiss detail panel (but not when clicking another course block)
  useEffect(() => {
    if (!selected) return;
    function handleClick(e: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        // Don't close if clicking on another course block — let its onClick handle the swap
        const target = e.target as HTMLElement;
        if (target.closest("[data-course-block]")) return;
        setSelected(null);
        setProfRatings(null);
        setCourseDetail(null);
      }
    }
    const id = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", handleClick);
    };
  }, [selected]);

  // Fetch professor ratings and course detail when a course is selected.
  // Keep old data visible until new data is ready (no flash).
  const [panelReady, setPanelReady] = useState(false);
  useEffect(() => {
    if (!selected) {
      setProfRatings(null);
      setCourseDetail(null);
      setPanelReady(false);
      return;
    }

    let cancelled = false;
    setPanelReady(false);

    const profPromise: Promise<ProfRatingResult[]> = (() => {
      const name = selected.instructors_full_name;
      if (!name || name === "Staff") return Promise.resolve([]);
      return fetch(`/api/professor?name=${encodeURIComponent(name)}`)
        .then((r) => r.json())
        .catch(() => []);
    })();

    const detailPromise: Promise<CourseDetail | null> = fetch(
      `/api/course-detail?code=${encodeURIComponent(selected.offering_name)}`
    )
      .then((r) => r.json())
      .then((data: CourseDetail | null) => data || null)
      .catch(() => null);

    Promise.all([profPromise, detailPromise]).then(([prof, detail]) => {
      if (cancelled) return;
      setProfRatings(prof);
      setCourseDetail(detail);
      setPanelReady(true);
    });

    return () => { cancelled = true; };
  }, [selected]);

  const isActive = status === "submitted" || status === "streaming";

  // Auto-retry logic: detect silent failures and resend seamlessly.
  const retryCount = useRef(0);
  const retrying = useRef(false);

  // When status settles to "ready", check if we got a response. If not, retry.
  useEffect(() => {
    if (status !== "ready") return;

    const t = setTimeout(() => {
      const last = messages[messages.length - 1];
      if (!last) return;
      const hasText = last.role === "assistant" &&
        last.parts.some((p) => p.type === "text" && p.text.trim());
      if (hasText) { retryCount.current = 0; retrying.current = false; return; }
      if (retryCount.current >= 2) { retryCount.current = 0; retrying.current = false; return; }

      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const text = lastUser?.parts.find((p) => p.type === "text");
      if (text && text.type === "text") {
        retrying.current = true;
        retryCount.current++;
        sendMessage({ text: text.text });
      }
    }, 1500);

    return () => clearTimeout(t);
  }, [status, messages, sendMessage]);

  const lastMsg = messages[messages.length - 1];
  const lastAssistantHasText = lastMsg?.role === "assistant" &&
    lastMsg.parts.some((p) => p.type === "text" && p.text.trim());
  // Always show loading if: actively processing, OR last message has no text yet and we're not done
  const isLoading = isActive || (
    messages.length > 0 &&
    !lastAssistantHasText &&
    !error
  );

  // Stable color assignment: hash the course key so colors don't shift on removal
  const colorOf = useCallback(
    (c: ScheduledCourse) => {
      const key = `${c.offering_name}::${c.section_name}`;
      let hash = 0;
      for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
      return PALETTE[Math.abs(hash) % PALETTE.length];
    },
    []
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
    isPreview?: boolean;
  }[] = [];
  const addBlocks = (course: ScheduledCourse, isPreview = false) => {
    const mbs = parseMeetings(course.meetings);
    mbs.forEach((mb) => {
      mb.days.forEach((dayIdx) => {
        if (dayIdx > 4) return;
        blocks.push({
          course,
          dayIdx,
          top: (mb.startHour - 8) * ROW_H + (mb.startMin / 60) * ROW_H,
          height: (mb.endHour - mb.startHour) * ROW_H + ((mb.endMin - mb.startMin) / 60) * ROW_H,
          isPreview,
        });
      });
    });
  };
  schedule.forEach((c) => addBlocks(c));
  if (previewCourse) addBlocks(previewCourse, true);

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

                  if (block.isPreview) {
                    return (
                      <div
                        key={`preview-${block.dayIdx}-${block.top}`}
                        className="absolute rounded-lg overflow-hidden pointer-events-none"
                        style={{
                          top: block.top,
                          height: block.height,
                          left: `calc(52px + ${block.dayIdx} * ((100% - 52px) / 5) + 3px + ${idx} * ((100% - 52px) / 5 - 6px) / ${total})`,
                          width: `calc(((100% - 52px) / 5 - 6px) / ${total})`,
                          background: "rgba(16, 185, 129, 0.12)",
                          border: "2px dashed rgba(16, 185, 129, 0.5)",
                          zIndex: 15,
                        }}
                      >
                        <div className="px-2 py-1.5">
                          <span className="text-[10px] font-bold text-emerald-700 leading-none truncate block">
                            {block.course.offering_name}
                          </span>
                          <span className="text-[10px] text-emerald-600 leading-snug truncate block mt-0.5 opacity-80">
                            {block.course.title}
                          </span>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div
                      key={`${block.course.offering_name}-${block.course.section_name}-${block.dayIdx}-${block.top}`}
                      data-course-block
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
                        onClick={async (e) => {
                          e.stopPropagation();
                          await fetch("/api/schedule", {
                            method: "DELETE",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({ offering_name: block.course.offering_name, section_name: block.course.section_name }),
                          });
                          fetchSchedule();
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
          {selected && panelReady && (
            <div
              ref={panelRef}
              className="absolute bottom-0 left-0 right-0 bg-white border-t border-slate-200 shadow-[0_-4px_24px_rgba(0,0,0,0.08)] z-20 max-h-[55%] flex flex-col"
            >
              <div className="overflow-y-auto px-5 py-4">
                {/* Header */}
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
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={async () => {
                        await fetch("/api/schedule", {
                          method: "DELETE",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ offering_name: selected.offering_name, section_name: selected.section_name }),
                        });
                        setSelected(null); setProfRatings(null); setCourseDetail(null);
                        fetchSchedule();
                      }}
                      className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-red-50 text-red-500 hover:bg-red-100 transition-colors"
                    >
                      Remove
                    </button>
                    <button
                      onClick={() => { setSelected(null); setProfRatings(null); setCourseDetail(null); }}
                      className="w-6 h-6 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-600 hover:bg-slate-100 transition-colors text-xs"
                    >
                      &#10005;
                    </button>
                  </div>
                </div>

                {/* Two-column layout */}
                <div className="grid grid-cols-[1fr_1fr] gap-5">
                  {/* Left: course info + evals + professor ratings */}
                  <div className="space-y-3">
                    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[12px]">
                      <div>
                        <span className="text-slate-400">Credits</span>
                        <p className="text-slate-700 font-medium">{selected.credits}</p>
                      </div>
                      <div>
                        <span className="text-slate-400">Format</span>
                        <p className="text-slate-700 font-medium">{selected.instruction_method || "N/A"}</p>
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
                      <div className="col-span-2">
                        <span className="text-slate-400">Instructor</span>
                        <p className="text-slate-700 font-medium">{selected.instructors_full_name || "Staff"}</p>
                      </div>
                    </div>

                    {/* Course evaluations */}
                    <div>
                      <span className="text-[11px] text-slate-400">Course Evaluations</span>
                      {courseDetail && courseDetail !== "loading" && courseDetail.overall_quality !== null ? (
                        <div className="mt-1.5 space-y-1.5">
                          {([
                            ["Overall Quality", courseDetail.overall_quality],
                            ["Instructor", courseDetail.instructor_effectiveness],
                            ["Challenge", courseDetail.intellectual_challenge],
                            ["Workload", courseDetail.workload],
                          ] as const).map(([label, value]) =>
                            value !== null ? (
                              <div key={label} className="flex items-center gap-2 text-[12px]">
                                <span className="text-slate-500 w-[100px] shrink-0">{label}</span>
                                <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                                  <div
                                    className="h-full rounded-full"
                                    style={{
                                      width: `${((value as number) / 5) * 100}%`,
                                      background: label === "Workload"
                                        ? (value as number) > 3.5 ? "#f87171" : (value as number) > 2.5 ? "#fbbf24" : "#34d399"
                                        : (value as number) >= 4 ? "#34d399" : (value as number) >= 3 ? "#fbbf24" : "#f87171",
                                    }}
                                  />
                                </div>
                                <span className="text-slate-700 font-semibold w-7 text-right">{(value as number).toFixed(1)}</span>
                              </div>
                            ) : null
                          )}
                          {courseDetail.num_respondents !== null && (
                            <p className="text-[11px] text-slate-400">
                              {courseDetail.num_respondents} respondent{courseDetail.num_respondents !== 1 && "s"}
                            </p>
                          )}
                        </div>
                      ) : courseDetail === "loading" ? (
                        <p className="text-[12px] text-slate-400 mt-0.5">Loading...</p>
                      ) : (
                        <p className="text-[12px] text-slate-400 mt-0.5">No data available</p>
                      )}
                    </div>

                    {/* Professor ratings */}
                    <div>
                      <span className="text-[11px] text-slate-400">RateMyProfessors</span>
                      <div className="mt-1 text-[12px] space-y-1.5">
                        {profRatings === "loading" && (
                          <span className="text-slate-400">Loading...</span>
                        )}
                        {Array.isArray(profRatings) && profRatings.length === 0 && (
                          <span className="text-slate-400">N/A</span>
                        )}
                        {Array.isArray(profRatings) && profRatings.map((pr) => (
                          <div key={pr.name} className="flex items-center gap-3 text-slate-700">
                            <span className="font-medium text-slate-500 min-w-[90px] truncate">
                              {pr.name.split(",").reverse().map(s => s.trim()).join(" ")}
                            </span>
                            {pr.rating ? (
                              <>
                                <span><span className="font-semibold">{pr.rating.avg_rating.toFixed(1)}</span><span className="text-slate-400">/5</span></span>
                                <span><span className="font-semibold">{pr.rating.avg_difficulty.toFixed(1)}</span><span className="text-slate-400"> diff</span></span>
                                {pr.rating.would_take_again_pct !== null && pr.rating.would_take_again_pct >= 0 && (
                                  <span><span className="font-semibold">{Math.round(pr.rating.would_take_again_pct)}%</span><span className="text-slate-400"> retake</span></span>
                                )}
                                <span className="text-slate-400 text-[11px]">({pr.rating.num_ratings})</span>
                              </>
                            ) : (
                              <span className="text-slate-400">N/A</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>

                  {/* Right: description + prerequisites */}
                  <div className="space-y-3">
                    {courseDetail === "loading" && (
                      <p className="text-[11px] text-slate-400">Loading details...</p>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.description && (
                      <div>
                        <span className="text-[11px] text-slate-400">Description</span>
                        <p className="text-[12px] text-slate-600 leading-relaxed mt-0.5">
                          {courseDetail.description}
                        </p>
                      </div>
                    )}
                    {courseDetail && courseDetail !== "loading" && courseDetail.prerequisites && (() => {
                      const { restrictions, prereqs } = splitPrerequisites(courseDetail.prerequisites);
                      return (
                        <>
                          {prereqs.length > 0 && (
                            <div>
                              <span className="text-[11px] text-slate-400">Prerequisites</span>
                              <p className="text-[12px] text-slate-600 leading-relaxed mt-0.5">
                                {prereqs.join("; ")}
                              </p>
                            </div>
                          )}
                          {restrictions.length > 0 && (
                            <div>
                              <span className="text-[11px] text-slate-400">Restrictions</span>
                              {restrictions.map((r, i) => (
                                <p key={i} className="text-[12px] text-amber-600 leading-relaxed mt-0.5">
                                  {r}
                                </p>
                              ))}
                            </div>
                          )}
                        </>
                      );
                    })()}
                    {courseDetail && courseDetail !== "loading" && !courseDetail.description && !courseDetail.prerequisites && (
                      <p className="text-[12px] text-slate-400">No description available</p>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>
      </main>

      {/* ---- RIGHT: Chat ---- */}
      <aside className="w-[380px] shrink-0 border-l border-slate-200 bg-white flex flex-col">
        {/* Chat header — aligned with left top bar */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-200 bg-white/80 backdrop-blur-sm shrink-0">
          <p className="text-base font-semibold text-slate-900 tracking-tight">
            Course Assistant
          </p>
          {messages.length > 0 && (
            <button
              onClick={() => setMessages([])}
              className="text-[11px] text-slate-400 hover:text-slate-600 transition-colors"
              title="Clear chat"
            >
              Clear
            </button>
          )}
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {messages.length === 0 && !isLoading && (
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
                    onClick={() => {
                      sendMessage({ text: s });
                    }}
                    className="block w-full text-left px-3 py-2 rounded-lg text-xs text-slate-600 bg-slate-50 hover:bg-blue-50 hover:text-blue-700 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((message, msgIdx) => {
            // Hide assistant messages that have no visible content (only hidden tool parts)
            if (message.role === "assistant") {
              const hasVisible = message.parts.some((p) => p.type === "text" && p.text.trim());
              if (!hasVisible) return null;
            }
            // Hide duplicate user messages created by auto-retry
            if (retrying.current && message.role === "user" && msgIdx > 0) {
              const prevUsers = messages.slice(0, msgIdx).filter((m) => m.role === "user");
              const thisText = message.parts.find((p) => p.type === "text");
              if (thisText && thisText.type === "text" && prevUsers.some((m) => {
                const t = m.parts.find((p) => p.type === "text");
                return t && t.type === "text" && t.text === thisText.text;
              })) return null;
            }
            return (
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
                    if (message.role === "user") {
                      return (
                        <div
                          key={i}
                          className="text-[12px] leading-[1.6] [&>strong]:font-semibold"
                          dangerouslySetInnerHTML={{ __html: md(part.text) }}
                        />
                      );
                    }
                    return (
                      <div
                        key={i}
                        className="text-[12px] leading-[1.6] [&>strong]:font-semibold"
                      >
                        <MessageContent
                          html={md(part.text)}
                          validCourses={validCourses}
                          onAdd={async (code, section) => {
                            await fetch("/api/schedule", {
                              method: "POST",
                              headers: { "Content-Type": "application/json" },
                              body: JSON.stringify({ offering_name: code, section_name: section }),
                            });
                            fetchSchedule();
                            clearPreview();
                          }}
                          onPreview={handlePreview}
                          onPreviewEnd={clearPreview}
                        />
                      </div>
                    );
                  }
                  if (isToolUIPart(part)) {
                    return null;
                  }
                  return null;
                })}
              </div>
            </div>
          );
          })}

          {isLoading && (() => {
            const last = messages[messages.length - 1];
            if (!last) return false;
            if (last.role === "user") return true;
            const hasText = last.parts.some((p) => p.type === "text" && p.text.trim());
            return !hasText;
          })() && (
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
