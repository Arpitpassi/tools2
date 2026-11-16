/**
 * Sense — Markdown → A4 preview / plain text / PDF, with LaTeX.
 * White page, black used only for text and outlines. Research-paper preview.
 *
 * Install:
 *   npm i react-markdown remark-gfm remark-math rehype-katex katex
 *
 * PDF: uses the browser's print engine (Save as PDF) so it matches the preview exactly.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import type { ChangeEvent, ClipboardEvent, KeyboardEvent, PointerEvent } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";

/* ───────────── Tunable constants ───────────── */
const INK = "#000000";
const PAPER = "#ffffff";
const MONO = `"Courier Prime", "Courier New", Courier, monospace`;
const SERIF = `"STIX Two Text", "Times New Roman", Times, serif`;
const RULE = `1px solid ${INK}`;
const CARD_RADIUS_PX = 18;
const BUTTON_RADIUS_PX = 999;
const NUMBER_SECTIONS_DEFAULT = true;
const STORAGE_KEY = "sense:doc";
const LEGACY_STORAGE_KEY = "typewriter-md:doc";
const PDF_TITLE = "document"; // suggested file name in the print dialog
/* A4 geometry — the preview is a real 210 × 297 mm sheet, scaled to fit */
const A4_W_MM = 210;
const A4_H_MM = 297;
const PDF_MARGIN_MM = 15;
const BASE_FONT_PX = 16;
const MAX_ZOOM = 3;
const MIN_ZOOM = 0.3;
const ZOOM_STEP = 0.1;
const SCROLL_PAD_PX = 24; // total horizontal padding inside the preview scroller
/* Resizable split (% of width for the editor) */
const SPLIT_DEFAULT = 50;
const SPLIT_MIN = 25;
const SPLIT_MAX = 75;
const GRID_PAD_PX = 24;
const MM_TO_PX = 96 / 25.4;
const AUTOSAVE_MS = 400;

const SAMPLE = `# On Digital Step Counting with Inertial Sensors

Arka · Department of Electronics and Communication Engineering

> **Abstract.** We describe a low-cost step counter built on a three-axis accelerometer. A band-pass filter isolates the gait frequency, and a peak detector with an adaptive threshold counts steps.

## Introduction

Walking produces a quasi-periodic acceleration with energy concentrated near $2\\,\\mathrm{Hz}$. Writing the sampled signal as $x[n]$, its spectrum is

$$
X(k) = \\sum_{n=0}^{N-1} x[n]\\, e^{-j 2\\pi kn/N}
$$

## Method

### Filtering

A moving-average FIR filter of length $M$ has output $y[n] = \\tfrac{1}{M}\\sum_{m=0}^{M-1} x[n-m]$.

### Results

| Filter | Taps | Accuracy |
|--------|------|----------|
| FIR    | 32   | 96.1 %   |
| IIR    | 2    | 93.4 %   |

## Conclusion

Both filters count steps reliably; the IIR variant is cheaper on an **ESP32**.
`;

/* ───────────── Helpers ───────────── */
const toPlainText = (md: string): string =>
  md
    .replace(/```[^\n]*\n([\s\S]*?)```/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/gm, "- ")
    .replace(/^\s*[-*+]\s+/gm, "- ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\*(.+?)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/^[-*_]{3,}\s*$/gm, "----------------")
    .replace(/\n{3,}/g, "\n\n")
    .trim();


/* ───────────── HTML paste → Markdown (keeps LaTeX) ───────────── */
/* Chat UIs (Gemini, ChatGPT, …) copy rendered math as text + TeX source,
   which garbles the Markdown. On paste we read the HTML instead and
   pull the TeX straight from the math nodes. */
const mathOf = (el: Element): { tex: string; display: boolean } | null => {
  const isMath =
    el.hasAttribute("data-math") || el.classList.contains("katex") || el.classList.contains("katex-display");
  if (!isMath) return null;
  const tex =
    el.getAttribute("data-math") ??
    el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ??
    "";
  if (!tex.trim()) return null;
  const display =
    el.classList.contains("katex-display") ||
    el.classList.contains("math-block") ||
    !!el.closest(".katex-display, .math-block");
  return { tex: tex.trim(), display };
};

const htmlToMarkdown = (html: string): string => {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const walk = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const el = node as Element;

    const m = mathOf(el);
    if (m) return m.display ? `\n\n$$\n${m.tex}\n$$\n\n` : `$${m.tex}$`;

    const kids = () => Array.from(el.childNodes).map(walk).join("");
    const tag = el.tagName.toLowerCase();

    if (/^h[1-6]$/.test(tag)) return `\n\n${"#".repeat(Number(tag[1]))} ${kids().trim()}\n\n`;

    switch (tag) {
      case "script":
      case "style":
      case "button":
      case "svg":
        return "";
      case "p":
        return `\n\n${kids().trim()}\n\n`;
      case "div":
      case "section":
        return `\n${kids()}\n`;
      case "br":
        return "\n";
      case "hr":
        return "\n\n---\n\n";
      case "strong":
      case "b":
        return kids().trim() ? `**${kids().trim()}**` : "";
      case "em":
      case "i":
        return kids().trim() ? `*${kids().trim()}*` : "";
      case "code":
        return `\`${el.textContent ?? ""}\``;
      case "pre":
        return `\n\n\`\`\`\n${(el.textContent ?? "").replace(/\n$/, "")}\n\`\`\`\n\n`;
      case "a":
        return el.getAttribute("href") ? `[${kids().trim()}](${el.getAttribute("href")})` : kids();
      case "blockquote":
        return `\n\n${kids().trim().split("\n").map((l) => "> " + l).join("\n")}\n\n`;
      case "ul":
      case "ol": {
        const items = Array.from(el.children)
          .filter((c) => c.tagName.toLowerCase() === "li")
          .map((li, i) => {
            const body = walk(li).trim().replace(/\n{2,}/g, "\n").replace(/\n/g, "\n   ");
            return `${tag === "ol" ? `${i + 1}.` : "-"} ${body}`;
          });
        return `\n\n${items.join("\n")}\n\n`;
      }
      case "table": {
        const rows = Array.from(el.querySelectorAll("tr")).map((tr) =>
          Array.from(tr.children).map((c) => walk(c).trim().replace(/\|/g, "\\|").replace(/\n+/g, " "))
        );
        if (!rows.length) return "";
        const line = (r: string[]) => `| ${r.join(" | ")} |`;
        const sep = `| ${rows[0].map(() => "---").join(" | ")} |`;
        return `\n\n${[line(rows[0]), sep, ...rows.slice(1).map(line)].join("\n")}\n\n`;
      }
      default:
        return kids();
    }
  };

  return walk(doc.body).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
};

/* A line made only of "=" would turn the line above into a heading */
const guardSetext = (md: string): string =>
  md.replace(/^[ \t]*=+[ \t]*$/gm, (l) => l.replace(/=/g, "\\="));

const saveBlob = (text: string, name: string, type = "text/plain") => {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
};

const loadInitial = (): string => {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? localStorage.getItem(LEGACY_STORAGE_KEY) ?? SAMPLE;
  } catch {
    return SAMPLE;
  }
};

type View = "preview" | "text";

/* ───────────── Component ───────────── */
export default function App() {
  const [md, setMd] = useState<string>(loadInitial);
  const [view, setView] = useState<View>("preview");
  const [numbered, setNumbered] = useState(NUMBER_SECTIONS_DEFAULT);
  const [copied, setCopied] = useState(false);
  const paperRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [zoom, setZoom] = useState(1); // fit-to-width zoom
  const [manual, setManual] = useState<number | null>(null); // null = fit
  const [split, setSplit] = useState(SPLIT_DEFAULT);
  const [dragging, setDragging] = useState(false);
  const gridRef = useRef<HTMLElement>(null);
  const scale = manual ?? zoom;
  const [pages, setPages] = useState(1);

  const plain = useMemo(() => toPlainText(md), [md]);
  const safeMd = useMemo(() => guardSetext(md), [md]);
  const words = useMemo(() => (md.trim() ? md.trim().split(/\s+/).length : 0), [md]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, md);
      } catch {
        /* storage unavailable */
      }
    }, AUTOSAVE_MS);
    return () => clearTimeout(t);
  }, [md]);

  // Lock to light: stops forced dark mode from inverting the black/white design
  useEffect(() => {
    const add = (name: string, content: string) => {
      const m = document.createElement("meta");
      m.name = name;
      m.content = content;
      document.head.appendChild(m);
      return m;
    };
    const metas = [add("color-scheme", "light"), add("darkreader-lock", "")];
    return () => metas.forEach((m) => m.remove());
  }, []);

  // Fit the A4 sheet to the available width
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const fit = () =>
      setZoom(Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, (el.clientWidth - SCROLL_PAD_PX) / (A4_W_MM * MM_TO_PX))));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Estimate page count from content height vs. printable A4 height
  useEffect(() => {
    const el = paperRef.current;
    if (!el || view !== "preview") return;
    const count = () => {
      const r = el.getBoundingClientRect();
      if (!r.width) return;
      const contentMm = (r.height / r.width) * (A4_W_MM - 2 * PDF_MARGIN_MM);
      setPages(Math.max(1, Math.ceil(contentMm / (A4_H_MM - 2 * PDF_MARGIN_MM) - 0.001)));
    };
    count();
    const ro = new ResizeObserver(count);
    ro.observe(el);
    return () => ro.disconnect();
  }, [view, md, numbered]);

  // Exact PDF: print the live preview through the browser (vector text, real KaTeX, real A4 pages)
  const downloadPdf = () => {
    flushSync(() => setView("preview"));
    const prev = document.title;
    const restore = () => {
      document.title = prev;
      window.removeEventListener("afterprint", restore);
    };
    document.title = PDF_TITLE;
    window.addEventListener("afterprint", restore);
    window.print();
  };

  const copyText = async () => {
    try {
      await navigator.clipboard.writeText(view === "text" ? plain : md);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard blocked */
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const html = e.clipboardData.getData("text/html");
    if (!html || !/katex|data-math|<h[1-6][\s>]|<table|<li[\s>]/i.test(html)) return; // plain paste otherwise
    e.preventDefault();
    const ta = e.currentTarget;
    const { selectionStart: a, selectionEnd: b } = ta;
    setMd(md.slice(0, a) + htmlToMarkdown(html) + md.slice(b));
  };

  const onSplitDown = (e: PointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setDragging(true);
  };
  const onSplitMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging || !gridRef.current) return;
    const r = gridRef.current.getBoundingClientRect();
    const pct = ((e.clientX - r.left - GRID_PAD_PX) / (r.width - 2 * GRID_PAD_PX)) * 100;
    setSplit(Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, pct)));
  };
  const onSplitKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "ArrowLeft") setSplit((v) => Math.max(SPLIT_MIN, v - 2));
    if (e.key === "ArrowRight") setSplit((v) => Math.min(SPLIT_MAX, v + 2));
  };

  const importFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) setMd(await f.text());
    e.target.value = "";
  };

  return (
    <div className="tw">
      <style>{css}</style>

      <header className="bar">
        <h1>
          Sense
        </h1>
        <nav className="actions" aria-label="Actions">
          <button onClick={() => fileRef.current?.click()}>Open</button>
          <button onClick={() => saveBlob(md, "document.md", "text/markdown")}>.md</button>
          <button onClick={() => saveBlob(plain, "document.txt")}>.txt</button>
          <button className="primary" onClick={downloadPdf}>
            PDF
          </button>
          <input ref={fileRef} type="file" accept=".md,.markdown,.txt" hidden onChange={importFile} />
        </nav>
      </header>

      <main
        className="grid"
        ref={gridRef}
        style={{ gridTemplateColumns: `minmax(0, ${split}fr) 20px minmax(0, ${100 - split}fr)` }}
      >
        <section className="card editor" aria-label="Markdown input">
          <div className="tabs">
            <span className="label">Markdown</span>
            <div className="row">
              <button onClick={copyText}>{copied ? "Copied" : "Copy"}</button>
              <button onClick={() => setMd("")}>Clear</button>
            </div>
          </div>
          <textarea
            value={md}
            onChange={(e) => setMd(e.target.value)}
            onPaste={onPaste}
            spellCheck={false}
            placeholder="Start typing…"
            aria-label="Markdown source"
          />
        </section>

        <div
          className={"splitter" + (dragging ? " drag" : "")}
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize panes"
          tabIndex={0}
          onPointerDown={onSplitDown}
          onPointerMove={onSplitMove}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onKeyDown={onSplitKey}
        />

        <section className="card output" aria-label="Output">
          <div className="tabs">
            <div role="tablist">
              <button role="tab" aria-selected={view === "preview"} onClick={() => setView("preview")}>
                Preview
              </button>
              <button role="tab" aria-selected={view === "text"} onClick={() => setView("text")}>
                Text
              </button>
            </div>
            {view === "preview" && (
              <div className="row">
                <button aria-label="Zoom out" onClick={() => setManual(Math.max(MIN_ZOOM, scale - ZOOM_STEP))}>
                  −
                </button>
                <button aria-label="Fit to width" onClick={() => setManual(null)}>
                  {Math.round(scale * 100)}%
                </button>
                <button aria-label="Zoom in" onClick={() => setManual(Math.min(MAX_ZOOM, scale + ZOOM_STEP))}>
                  +
                </button>
                <button aria-pressed={numbered} onClick={() => setNumbered((n) => !n)}>
                  Numbering
                </button>
              </div>
            )}
          </div>

          <div className="scroll" ref={scrollRef}>
            {view === "preview" ? (
              <div className="zoomer" style={{ zoom: scale }}>
                <div className="page">
                  <div className={"paper" + (numbered ? " num" : "")} ref={paperRef}>
                    <ReactMarkdown remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>
                      {safeMd}
                    </ReactMarkdown>
                  </div>
                </div>
              </div>
            ) : (
              <pre className="plain">{plain}</pre>
            )}
          </div>
        </section>
      </main>

      <footer className="status">
        <span>{words} words</span>
        <span>{md.length} chars</span>
        <span>{md.split("\n").length} lines</span>
        <span>A4 · ~{pages} {pages === 1 ? "page" : "pages"}</span>
      </footer>
    </div>
  );
}

/* ───────────── Styles: white page, black only for text and outlines ───────────── */
const css = `
@import url("https://fonts.googleapis.com/css2?family=Courier+Prime:ital,wght@0,400;0,700;1,400&family=STIX+Two+Text:ital,wght@0,400;0,600;0,700;1,400;1,600&display=swap");

html, body { margin: 0 !important; padding: 0 !important; display: block !important; width: 100% !important;
  min-width: 0 !important; background: ${PAPER} !important; color: ${INK} !important; color-scheme: light !important; }
#root { max-width: none !important; width: 100% !important; margin: 0 !important; padding: 0 !important;
  text-align: left !important; }

.tw, .tw * { box-sizing: border-box; }
.tw, .tw * { color: var(--ink); scrollbar-color: var(--ink) var(--paper); scrollbar-width: thin; }
.tw {
  --ink: ${INK};
  --paper: ${PAPER};
  height: 100vh; height: 100dvh; display: flex; flex-direction: column;
  background: var(--paper); color: var(--ink);
  font-family: ${MONO}; font-size: 15px; line-height: 1.6;
}

/* Buttons: outline pills, no fills */
.tw button {
  font: inherit; font-size: 13px; color: var(--ink); background: transparent;
  border: ${RULE}; border-radius: ${BUTTON_RADIUS_PX}px;
  padding: 4px 14px; cursor: pointer; transition: box-shadow .12s ease;
}
.tw button:hover:not(:disabled),
.tw button.primary,
.tw button[aria-selected="true"],
.tw button[aria-pressed="true"] { box-shadow: inset 0 0 0 1px var(--ink); }
.tw button.primary { font-weight: 700; }
.tw button:disabled { cursor: wait; }
.tw :focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

/* Header */
.bar { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px;
  padding: 16px 24px; }
.bar h1 { margin: 0; font-size: 22px; font-weight: 700; letter-spacing: .04em; }
.actions, .row { display: flex; flex-wrap: wrap; gap: 8px; }

/* Rounded cards + resizable split */
.grid { flex: 1; min-height: 0; display: grid; padding: 0 ${GRID_PAD_PX}px 16px; }
.card { min-height: 0; display: flex; flex-direction: column; border: ${RULE};
  border-radius: ${CARD_RADIUS_PX}px; overflow: hidden; background: var(--paper); }
.splitter { position: relative; cursor: col-resize; touch-action: none; outline: none; }
.splitter::after { content: ""; position: absolute; left: 50%; top: 50%; width: 6px; height: 48px;
  transform: translate(-50%, -50%); border: ${RULE}; border-radius: 999px; }
.splitter:hover::after, .splitter:focus-visible::after, .splitter.drag::after { box-shadow: inset 0 0 0 1px var(--ink); }
.tabs { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 8px;
  padding: 8px 16px; border-bottom: ${RULE}; min-height: 54px; }
.tabs .label { padding-left: 4px; }
.tabs [role="tablist"] { display: flex; gap: 8px; }

.editor textarea {
  flex: 1; min-height: 0; resize: none; width: 100%; padding: 20px 24px;
  background: transparent; color: var(--ink); border: 0; outline: 0;
  font: inherit; line-height: 1.8; tab-size: 2; caret-color: var(--ink);
}
.editor textarea::placeholder { color: var(--ink); opacity: 1; font-style: italic; }

.scroll { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
.zoomer { width: ${A4_W_MM}mm; margin: 0 auto; }
.page { width: 100%; min-height: ${A4_H_MM}mm; padding: ${PDF_MARGIN_MM}mm; border: ${RULE};
  border-radius: 6px; background: var(--paper); }
.plain { margin: 0; padding: 8px 12px; white-space: pre-wrap; word-break: break-word; font: inherit; }

/* Print / Save as PDF: only the A4 paper, nothing else */
@page { size: A4; margin: ${PDF_MARGIN_MM}mm; }
@media print {
  html, body { background: ${PAPER} !important; height: auto !important; }
  .tw { position: static !important; display: block !important; height: auto !important; }
  .bar, .status, .tabs, .splitter, .editor { display: none !important; }
  .grid { display: block !important; padding: 0 !important; }
  .card { border: 0 !important; border-radius: 0 !important; overflow: visible !important; }
  .scroll { overflow: visible !important; padding: 0 !important; }
  .zoomer { zoom: 1 !important; width: auto !important; margin: 0 !important; }
  .page { border: 0 !important; border-radius: 0 !important; padding: 0 !important;
    min-height: 0 !important; width: auto !important; }
  .paper { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .paper h1, .paper h2, .paper h3, .paper h4 { break-after: avoid; }
  .paper table, .paper pre, .paper blockquote, .paper .katex-display, .paper tr, .paper img { break-inside: avoid; }
}

/* Research-paper typography */
.paper { width: 100%; background: var(--paper); color: var(--ink);
  font-family: ${SERIF}; font-size: ${BASE_FONT_PX}px; line-height: 1.55; text-align: justify; hyphens: auto; }
.paper h1 { text-align: center; font-size: 1.85em; font-weight: 700; line-height: 1.2; margin: 0 0 .5em; }
.paper h1 + p { text-align: center; font-style: italic; margin-bottom: 1.6em; }
.paper h2 { font-size: 1.12em; font-weight: 700; font-variant: small-caps; letter-spacing: .03em;
  margin: 1.8em 0 .5em; text-align: left; }
.paper h3 { font-size: 1em; font-style: italic; font-weight: 700; margin: 1.3em 0 .4em; text-align: left; }
.paper h4 { font-size: 1em; font-style: italic; font-weight: 400; margin: 1em 0 .3em; text-align: left; }
.paper p, .paper ul, .paper ol { margin: .65em 0; }
.paper ul, .paper ol { padding-left: 1.6em; }
.paper a { color: var(--ink); text-decoration: underline; text-underline-offset: 2px; }
.paper blockquote { margin: 1.3em 2.2em; padding: 0; border: 0; font-size: .93em; }
.paper blockquote p { margin: 0; }
.paper code { font-family: ${MONO}; font-size: .86em; border: 1px solid var(--ink);
  border-radius: 5px; padding: 0 5px; }
.paper pre { border: ${RULE}; border-radius: 10px; padding: 12px 14px; overflow: auto;
  text-align: left; hyphens: none; }
.paper pre code { border: 0; padding: 0; border-radius: 0; }
.paper hr { border: 0; border-top: 1px solid var(--ink); width: 30%; margin: 2em auto; }
.paper img { max-width: 100%; display: block; margin: 1em auto; filter: grayscale(1); }
.paper .katex-display { margin: 1.1em 0; overflow-x: auto; overflow-y: hidden; }
.paper .katex { color: var(--ink); }

/* Booktabs-style tables */
.paper table { border-collapse: collapse; margin: 1.3em auto; font-size: .93em;
  border-top: 2px solid var(--ink); border-bottom: 2px solid var(--ink); }
.paper th, .paper td { padding: 5px 16px; text-align: left; border: 0; }
.paper thead th { border-bottom: 1px solid var(--ink); font-weight: 700; }

/* Section numbering */
.paper.num { counter-reset: h2; }
.paper.num h2 { counter-increment: h2; counter-reset: h3; }
.paper.num h2::before { content: counter(h2) ".\\00a0\\00a0"; }
.paper.num h3 { counter-increment: h3; }
.paper.num h3::before { content: counter(h2) "." counter(h3) "\\00a0\\00a0"; }

.status { display: flex; gap: 20px; padding: 6px 24px 14px; font-size: 12px; }

@media (min-width: 901px) {
  .tw { position: fixed; inset: 0; height: auto; }
}

@media (max-width: 900px) {
  .tw { height: auto; min-height: 100vh; }
  .grid { grid-template-columns: 1fr !important; padding: 0 16px 16px; gap: 16px; }
  .splitter { display: none; }
  .editor textarea { min-height: 45vh; }
  .bar { padding: 14px 16px; }
  .status { padding: 6px 16px 14px; }
}
`;