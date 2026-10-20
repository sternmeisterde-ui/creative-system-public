// ── Общие помощники для DOCX-выгрузок (отчёт, ТЗ/бриф) ──────────────────────
// Вынесены из app/api/analytics/report/docx: заголовки, абзацы с **жирным** и `кодом`, таблицы,
// markdown → docx (заголовки, списки, таблицы), внешние ссылки.
import {
  Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, BorderStyle, ShadingType, ExternalHyperlink,
  type IParagraphOptions,
} from "docx";

export const FONT = "Calibri";
export const eur = (v: number | null | undefined, d = 1) => (v == null ? "—" : `€${v.toFixed(d)}`);
export const ruDate = (iso: string) => new Date(iso).toLocaleDateString("ru-RU");

export function runs(text: string, base: { bold?: boolean; size?: number; color?: string } = {}): TextRun[] {
  const out: TextRun[] = [];
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  for (const p of parts) {
    if (p.startsWith("**") && p.endsWith("**")) out.push(new TextRun({ text: p.slice(2, -2), bold: true, font: FONT, size: base.size ?? 22, color: base.color }));
    else if (p.startsWith("`") && p.endsWith("`")) out.push(new TextRun({ text: p.slice(1, -1), font: "Consolas", size: (base.size ?? 22) - 2, color: "3B5B7A" }));
    else out.push(new TextRun({ text: p, bold: base.bold, font: FONT, size: base.size ?? 22, color: base.color }));
  }
  return out;
}
export const para = (text: string, opts: Partial<IParagraphOptions> & { bold?: boolean; size?: number; color?: string } = {}) => {
  const { bold, size, color, ...rest } = opts;
  return new Paragraph({ children: runs(text, { bold, size, color }), spacing: { after: 80 }, ...rest });
};
export const h1 = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: t, font: FONT, bold: true, size: 30, color: "1F2A44" })], spacing: { before: 280, after: 120 } });
export const h2 = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun({ text: t, font: FONT, bold: true, size: 24, color: "2E6F8E" })], spacing: { before: 200, after: 80 } });
export const h3 = (t: string) => new Paragraph({ heading: HeadingLevel.HEADING_3, children: [new TextRun({ text: t, font: FONT, bold: true, size: 22, color: "3B5B7A" })], spacing: { before: 160, after: 60 } });
export const small = (t: string) => para(t, { size: 18, color: "666666" });

/** Абзац со ссылкой: «подпись: текст ссылки» */
export function linkPara(label: string, url: string, text?: string): Paragraph {
  return new Paragraph({
    spacing: { after: 40 },
    children: [
      ...(label ? [new TextRun({ text: `${label}: `, font: FONT, size: 20, color: "666666" })] : []),
      new ExternalHyperlink({ link: url, children: [new TextRun({ text: text ?? url, font: FONT, size: 20, style: "Hyperlink" })] }),
    ],
  });
}

const border = { style: BorderStyle.SINGLE, size: 4, color: "D9DEE7" };
export function table(header: string[], rows: string[][], widths?: number[]): Table {
  const mk = (cells: string[], head = false) => new TableRow({
    tableHeader: head,
    children: cells.map((c, i) => new TableCell({
      width: widths ? { size: widths[i], type: WidthType.PERCENTAGE } : undefined,
      shading: head ? { type: ShadingType.CLEAR, fill: "1F2A44", color: "auto" } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      margins: { top: 60, bottom: 60, left: 100, right: 100 },
      children: [new Paragraph({ children: runs(c, { bold: head, size: 18, color: head ? "FFFFFF" : undefined }) })],
    })),
  });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [mk(header, true), ...rows.map(r => mk(r))] });
}

/** markdown → docx: заголовки (# … ####), жирные строки, списки (дефис, звёздочка, нумерация), таблицы с |, разделители --- */
export function markdownToDocx(md: string): (Paragraph | Table)[] {
  const out: (Paragraph | Table)[] = [];
  const lines = md.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const t = line.trim();
    if (!t || t === "---") { i++; continue; }
    if (t.startsWith("|")) {
      const block: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) { block.push(lines[i].trim()); i++; }
      // экранированный «\\|» внутри ячейки (тексты боди с разделителем) не режем
      const cells = (l: string) => l.replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map(c => c.trim().split("\\|").join("|"));
      const body = block.filter(l => !/^\|?\s*:?-{2,}/.test(l.replace(/\|/g, "").trim()) && !/^\|[\s\-:|]+\|$/.test(l));
      if (body.length >= 1) {
        const head = cells(body[0]); const rows = body.slice(1).map(cells).map(r => head.map((_, k) => r[k] ?? ""));
        out.push(table(head, rows)); out.push(new Paragraph({ spacing: { after: 80 } }));
      }
      continue;
    }
    const hm = t.match(/^(#{1,4})\s+(.*)$/);
    if (hm) { out.push(hm[1].length <= 2 ? h1(hm[2].replace(/\*\*/g, "")) : h2(hm[2].replace(/\*\*/g, ""))); i++; continue; }
    if (/^\*\*[^*]+\*\*:?$/.test(t)) { out.push(para(t.replace(/\*\*/g, ""), { bold: true, spacing: { before: 120, after: 60 } })); i++; continue; }
    const bm = t.match(/^[-*•]\s+(.*)$/);
    if (bm) { out.push(new Paragraph({ children: runs(bm[1]), bullet: { level: 0 }, spacing: { after: 40 } })); i++; continue; }
    const nm = t.match(/^(\d+)[.)]\s+(.*)$/);
    if (nm) { out.push(new Paragraph({ children: [new TextRun({ text: `${nm[1]}. `, bold: true, font: FONT, size: 22 }), ...runs(nm[2])], indent: { left: 360 }, spacing: { after: 40 } })); i++; continue; }
    out.push(para(t)); i++;
  }
  return out;
}
