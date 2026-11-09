// Локальный прогон прокладки Google → коды (без лимита времени функции): npx tsx scripts/google-automap.ts [limit] [metaFp] [image|video]
import { createServiceClient } from "../lib/supabase";
import { automapGoogle } from "../lib/google-automap";
async function main() {
  const limit = Number(process.argv[2] || 0) || undefined, metaFp = Number(process.argv[3] || 2000);
  const st = await automapGoogle(createServiceClient(), { deadlineMs: Date.now() + 6 * 3600_000, limit, metaFingerprintLimit: metaFp, only: (process.argv[4] as "image" | "video" | undefined) || undefined });
  console.log(JSON.stringify(st, null, 1));
}
main().catch(e => { console.error(e); process.exit(1); });
