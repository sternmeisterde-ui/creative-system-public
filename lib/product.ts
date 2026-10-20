// ── Продукт (30.09.2026): Бухгалтер vs Медадмин ──────────────────────────────
// Флоу отчёт → конструктор → сценарии → брифы разводится по продуктам. Продукт креатива
// определяется по имени объявления и именам кампании/адсета (токены, не подстроки:
// «andromeda» — не med), явное значение в ad_name_mapping.product перекрывает эвристику.
// Всё, что не Медадмин, считаем Бухгалтером — это базовый продукт, старые крео без маркеров его.

export type Product = "all" | "buchhalter" | "medadmin";

export const PRODUCTS: { id: Product; label: string; short: string; color: string; icon: string }[] = [
  { id: "all",        label: "Оба продукта", short: "Все",  color: "#E8AA42", icon: "◎" },
  { id: "buchhalter", label: "Бухгалтер",    short: "Бух",  color: "#6EC8A0", icon: "▤" },
  { id: "medadmin",   label: "Медадмин",     short: "Мед",  color: "#FF8B5A", icon: "✚" },
];
export const productMeta = (p: Product) => PRODUCTS.find(x => x.id === p) ?? PRODUCTS[0];
export const isProduct = (v: unknown): v is Product => v === "all" || v === "buchhalter" || v === "medadmin";

// Маркеры Медадмина: имя объявления / кампании / адсета. Коды параметров MED*, MH*, MB*, MA* — медицинская библиотека.
const MED_WORD = /(^|[^a-zа-яё])(med|medical|medadmin|medizin\w*|mfa|мед\w*|praxis\w*|arzt\w*|rezeption\w*|reception\w*|admin_med|med_admin)([^a-zа-яё]|$)/i;
const MED_CODE = /(^|[^A-Za-z])(MED|MH|MB|MA)\d+([^A-Za-z0-9]|$)/;
// Коды формулировок (06.10.2026): M{P|H|B|A}\d{6} — Медадмин, B{P|H|B|A}\d{6} — Бухгалтер.
const MED_FORM = /(^|[^A-Za-z0-9])M[PHBA]\d{6}([^A-Za-z0-9]|$)/;
const BUH_FORM = /(^|[^A-Za-z0-9])B[PHBA]\d{6}([^A-Za-z0-9]|$)/;

export function detectProduct(adName: string | null | undefined, campaignName?: string | null, adsetName?: string | null, override?: string | null): Exclude<Product, "all"> {
  if (override === "buchhalter" || override === "medadmin") return override;
  const name = adName ?? "";
  if (MED_FORM.test(name)) return "medadmin";
  if (BUH_FORM.test(name)) return "buchhalter";
  if (MED_WORD.test(name) || MED_CODE.test(name)) return "medadmin";
  const ctx = `${campaignName ?? ""} ${adsetName ?? ""}`;
  if (MED_WORD.test(ctx)) return "medadmin";
  return "buchhalter";
}

/** Фильтр строк по продукту; all — без фильтра. */
export function matchesProduct<T extends { ad_name?: string | null; adName?: string | null; campaign_name?: string | null; campaignName?: string | null; adset_name?: string | null; adsetName?: string | null }>(
  row: T, product: Product, override?: string | null,
): boolean {
  if (product === "all") return true;
  return detectProduct(row.ad_name ?? row.adName, row.campaign_name ?? row.campaignName, row.adset_name ?? row.adsetName, override) === product;
}

/** query-string для API: пусто при «оба продукта» */
export const productQuery = (p: Product, first = true) => (p === "all" ? "" : `${first ? "?" : "&"}product=${p}`);
