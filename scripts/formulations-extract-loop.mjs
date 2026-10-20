// Цикл дословной разметки объявлений Meta через /api/formulations/extract-batch.
// Берёт объявления без кодов формулировок (нет маппинга или в маппинге старые групповые коды), по убыванию спенда.
// node scripts/formulations-extract-loop.mjs [--base https://your-deployment.vercel.app] [--limit 4] [--product medadmin|buchhalter] [--min-spend 0] [--shard 0/3] [--dry]
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const base = (opt("--base", process.env.CS_BASE_URL ?? "http://localhost:3000")).replace(/\/$/, "");
const limit = Number(opt("--limit", 4));
const product = opt("--product", undefined);
const minSpend = Number(opt("--min-spend", 0));
const dryRun = args.includes("--dry");
const shardArg = opt("--shard", undefined); // "0/3" — этот цикл берёт 0-й из 3 непересекающихся срезов
const shard = shardArg ? { i: Number(shardArg.split("/")[0]), n: Number(shardArg.split("/")[1]) } : undefined;

let total = 0, created = 0, failed = 0, rounds = 0;
const seenFail = new Map();
for (;;) {
  const res = await fetch(`${base}/api/formulations/extract-batch`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ limit, product, minSpend, dryRun, shard, exclude: [...seenFail.keys()] }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) { console.error("HTTP", res.status, j.error ?? j); process.exit(1); }
  if (dryRun) { console.log(JSON.stringify(j, null, 1)); break; }
  rounds++; total += j.processed ?? 0; created += j.createdCodes ?? 0; failed += j.failed?.length ?? 0;
  for (const f of j.failed ?? []) { seenFail.set(f.adName, (seenFail.get(f.adName) ?? 0) + 1); console.error("  ✗", f.adName, "—", f.error); }
  console.log(`[${new Date().toISOString().slice(11, 19)}] раунд ${rounds}: +${j.processed} (новых кодов ${j.createdCodes}), ошибок ${j.failed?.length ?? 0}, осталось ≈ ${j.remaining}, без ассета ${j.noAsset}`);
  if (!j.remaining) break; // remaining уже без exclude-списка
}
console.log(`Готово: размечено ${total}, новых формулировок ${created}, ошибок ${failed}`);
