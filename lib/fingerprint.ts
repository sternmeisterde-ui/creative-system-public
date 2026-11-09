import sharp from "sharp";

// Перцептивный отпечаток картинки (dHash, 64 бита): серое 9×8, сравнение соседних пикселей по строкам.
// Устойчив к пересжатию, ресайзу и смене формата; не устойчив к смене фона/шрифта — это и нужно:
// другой фон = другой креатив (тексты при этом наследуются через выписку формулировок).
export async function dhashOf(buffer: ArrayBuffer | Buffer): Promise<string> {
  const { data } = await sharp(Buffer.from(buffer as ArrayBuffer)).flatten({ background: "#ffffff" }).grayscale().resize(9, 8, { fit: "fill" }).raw().toBuffer({ resolveWithObject: true });
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) bits += data[y * 9 + x] > data[y * 9 + x + 1] ? "1" : "0";
  let hex = "";
  for (let i = 0; i < 64; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}

export function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}

/** Порог «та же картинка»: ≤ 2 из 64 бит (пересжатие, ресайз). 06.11.2026: на 5–6 шаблонные баннеры одной серии
 *  с другим заголовком/бейджем совпадали как «копии» (buh_table_4 ≈ table_7, flower_10 ≈ flower_9) — проверено глазами.
 *  Всё, что дальше 2, идёт через текст: те же тексты дадут те же коды, но креатив будет отдельным. */
export const SAME_IMAGE_MAX_DISTANCE = 2;

export async function fetchImageHash(url: string): Promise<string> {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
  if (!r.ok) throw new Error(`картинка ${r.status}`);
  return dhashOf(await r.arrayBuffer());
}
