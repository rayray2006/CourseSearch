"use client";

interface Props {
  html: string;
  onAdd: (code: string, section: string) => void;
  onPreview: (code: string, section: string) => void;
  onPreviewEnd: () => void;
  validCourses: Set<string>;
  courseSections: { code: string; section: string }[];
}

export function MessageContent({ html, onAdd, onPreview, onPreviewEnd, validCourses, courseSections }: Props) {
  const TOKEN_RE = /([A-Z]{2}\.\d{3}\.\d{3})|Section\s+(\d{2})/g;
  const parts: { type: "html" | "code" | "section"; text: string; value?: string }[] = [];
  let lastIdx = 0;

  const matches = [...html.matchAll(TOKEN_RE)];
  for (const match of matches) {
    const idx = match.index!;
    if (idx > lastIdx) parts.push({ type: "html", text: html.slice(lastIdx, idx) });
    if (match[1]) {
      let endIdx = idx + match[0].length;
      const rest = html.slice(endIdx);
      const nameMatch = rest.match(/^((?:\s+(?!Section\s)(?!<)(?!—)(?!—)(?![A-Z]{2}\.\d{3}\.\d{3})(?:&amp;|&lt;|&gt;|[^\s<——])+)*)/);
      const trailingName = nameMatch ? nameMatch[0] : "";
      endIdx += trailingName.length;
      parts.push({ type: "code", text: html.slice(idx, endIdx), value: match[1] });
      lastIdx = endIdx;
      continue;
    } else if (match[2]) {
      parts.push({ type: "section", text: match[0], value: match[2] });
    }
    lastIdx = idx + match[0].length;
  }
  if (lastIdx < html.length) parts.push({ type: "html", text: html.slice(lastIdx) });

  if (matches.length === 0) {
    return <span dangerouslySetInnerHTML={{ __html: html }} />;
  }

  const sectionCourseMap = new Map<number, string>();
  const codeSectionCount = new Map<number, number>();
  const codeFirstSection = new Map<number, string>();
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

  const codeOccurrence = new Map<string, number>();

  return (
    <span>
      {parts.map((p, i) => {
        if (p.type === "html") {
          return <span key={i} dangerouslySetInnerHTML={{ __html: p.text }} />;
        }
        if (p.type === "code") {
          const code = p.value!;
          const isValid = validCourses.has(code);
          const sectionCount = codeSectionCount.get(i) || 0;

          const occ = codeOccurrence.get(code) || 0;
          codeOccurrence.set(code, occ + 1);
          const matchingSections = courseSections.filter((s) => s.code === code);
          const resolvedSection = matchingSections[occ]?.section || codeFirstSection.get(i) || "01";

          if (sectionCount <= 1 && isValid) {
            return <strong key={i}>{p.text}{addBtn(code, resolvedSection)}</strong>;
          }
          return <strong key={i}>{p.text}</strong>;
        }
        if (p.type === "section") {
          const courseCode = sectionCourseMap.get(i) || "";
          if (!courseCode || !validCourses.has(courseCode)) return <span key={i}>{p.text}</span>;
          const prevPart = i > 0 ? parts[i - 1] : null;
          const prevText = prevPart?.text || "";
          const isListContext = !prevText || prevText.endsWith("\n") || /[*\-•]\s*$/.test(prevText) || /:\s*$/.test(prevText) || prevPart?.type === "code";
          if (!isListContext) return <span key={i}>{p.text}</span>;
          return <span key={i}>{p.text}{addBtn(courseCode, p.value!)}</span>;
        }
        return <span key={i}>{p.text}</span>;
      })}
    </span>
  );
}
