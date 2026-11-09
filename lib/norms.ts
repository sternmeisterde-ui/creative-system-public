import { brief } from "@/lib/brief";
import type { FormulationProduct } from "@/lib/formulations";

/**
 * Нормы фактов продукта (например: «зарплата от 2200 €, не 3000»). Формулировка — неизменяемый дословный текст,
 * поэтому устаревший факт не правится на месте: движок пака подменяет формулировку преемником (тот же текст с новой нормой,
 * parent_code = старая), генерация брифов отказывается писать бриф по устаревшему тексту.
 */
export interface OutdatedClaim { product: FormulationProduct | "all"; pattern: string; replace: string; note: string }

export function outdatedClaims(product: FormulationProduct): OutdatedClaim[] {
  return (brief.outdated_claims ?? []).filter(c => c.product === "all" || c.product === product);
}

/** Какая норма нарушена в тексте (первая), или null. */
export function outdatedIn(text: string, product: FormulationProduct): OutdatedClaim | null {
  for (const c of outdatedClaims(product)) if (new RegExp(c.pattern, "iu").test(text)) return c;
  return null;
}

/** Текст с применёнными нормами; равен исходному, если нарушений нет. */
export function applyNorms(text: string, product: FormulationProduct): string {
  let t = text;
  for (const c of outdatedClaims(product)) t = t.replace(new RegExp(c.pattern, "giu"), c.replace);
  return t;
}
