// Shared schedule + chat utilities used by both desktop and mobile layouts.

export interface ScheduledCourse {
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

export const DAYS_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const DAYS_LONG = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
export const HOURS = Array.from({ length: 14 }, (_, i) => i + 8);
export const ROW_H = 52;

export interface MeetingBlock {
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

export function parseSingleMeeting(part: string): MeetingBlock | null {
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

export function parseMeetings(meetings: string): MeetingBlock[] {
  if (!meetings || meetings === "TBA") return [];
  return meetings
    .split(",")
    .map(parseSingleMeeting)
    .filter((b): b is MeetingBlock => b !== null);
}

export function formatTime(hour: number, min: number): string {
  const ap = hour >= 12 ? "PM" : "AM";
  const h12 = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
  return `${h12}:${String(min).padStart(2, "0")}${ap}`;
}

export const PALETTE = [
  { bg: "#dbeafe", border: "#93c5fd", text: "#1e3a5f" },
  { bg: "#d1fae5", border: "#6ee7b7", text: "#064e3b" },
  { bg: "#ede9fe", border: "#c4b5fd", text: "#3b0764" },
  { bg: "#fef3c7", border: "#fcd34d", text: "#78350f" },
  { bg: "#fce7f3", border: "#f9a8d4", text: "#831843" },
  { bg: "#ccfbf1", border: "#5eead4", text: "#134e4a" },
  { bg: "#ffedd5", border: "#fdba74", text: "#7c2d12" },
  { bg: "#e0e7ff", border: "#a5b4fc", text: "#312e81" },
];

export function colorFor(key: string) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(hash) % PALETTE.length];
}

export function md(text: string): string {
  const lines = text.split("\n");
  let inList = false;
  const out: string[] = [];

  for (const raw of lines) {
    let line = raw.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    line = line.replace(/\*\*(.*?)\*\*/g, "<strong>$1</strong>");
    line = line.replace(
      /`(.*?)`/g,
      '<code style="background:#f1f5f9;padding:1px 4px;border-radius:4px;font-size:0.7rem;font-family:var(--font-mono)">$1</code>'
    );

    const subBullet = line.match(/^ {2,}\* (.+)/);
    const topBullet = line.match(/^\* (.+)/);

    if (subBullet) {
      if (!inList) inList = true;
      out.push(`<div style="padding-left:20px;margin-top:2px;display:flex;gap:6px"><span style="color:#94a3b8;flex-shrink:0">↳</span><span>${subBullet[1]}</span></div>`);
    } else if (topBullet) {
      if (inList) out.push('<div style="margin-top:6px"></div>');
      inList = true;
      out.push(`<div style="margin-top:2px;display:flex;gap:6px"><span style="color:#94a3b8;flex-shrink:0">•</span><span>${topBullet[1]}</span></div>`);
    } else {
      if (inList) inList = false;
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
