#!/usr/bin/env node
/**
 * Одноразовый OAuth-флоу для Google Ads API → получение refresh token.
 *
 * Запуск:  node scripts/google-oauth.mjs            → Google Ads (scope adwords, ключ GOOGLE_ADS_REFRESH_TOKEN)
 *          node scripts/google-oauth.mjs --drive    → Google Drive для ТЗ в Google Docs (scope drive.file, ключ GOOGLE_DRIVE_REFRESH_TOKEN)
 *
 * Читает GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET из .env.local,
 * поднимает локальный сервер на http://localhost:8080, открывает браузер
 * для согласия, ловит code, меняет на токены и ДОПИСЫВАЕТ
 * GOOGLE_ADS_REFRESH_TOKEN в .env.local (+ печатает в консоль).
 *
 * Тип OAuth-клиента должен быть «Desktop app» — для него Google разрешает
 * loopback-redirect (http://localhost) без отдельной регистрации URI.
 */
import http from "node:http";
import { readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { exec } from "node:child_process";

const ENV_PATH = new URL("../.env.local", import.meta.url).pathname;
const PORT = 8080;
const REDIRECT = `http://localhost:${PORT}`;
const DRIVE = process.argv.includes("--drive");
const SCOPE = DRIVE ? "https://www.googleapis.com/auth/drive.file" : "https://www.googleapis.com/auth/adwords";
const TOKEN_KEY = DRIVE ? "GOOGLE_DRIVE_REFRESH_TOKEN" : "GOOGLE_ADS_REFRESH_TOKEN";

function readEnv(key) {
  const line = readFileSync(ENV_PATH, "utf8").split("\n").find(l => l.startsWith(key + "="));
  return line ? line.slice(key.length + 1).trim() : "";
}

// Для Drive — отдельный OAuth-клиент (проект Google Cloud, где включён Drive API); для Ads — клиент Google Ads.
const CLIENT_ID = DRIVE ? readEnv("GOOGLE_DRIVE_CLIENT_ID") : readEnv("GOOGLE_ADS_CLIENT_ID");
const CLIENT_SECRET = DRIVE ? readEnv("GOOGLE_DRIVE_CLIENT_SECRET") : readEnv("GOOGLE_ADS_CLIENT_SECRET");

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(DRIVE ? "❌ Нет GOOGLE_DRIVE_CLIENT_ID / GOOGLE_DRIVE_CLIENT_SECRET в .env.local" : "❌ Нет GOOGLE_ADS_CLIENT_ID / GOOGLE_ADS_CLIENT_SECRET в .env.local");
  process.exit(1);
}

const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
  client_id: CLIENT_ID,
  redirect_uri: REDIRECT,
  response_type: "code",
  scope: SCOPE,
  access_type: "offline",
  prompt: "consent",
}).toString();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT);
  const code = url.searchParams.get("code");
  const err = url.searchParams.get("error");

  if (err) {
    res.end(`Ошибка авторизации: ${err}. Можно закрыть вкладку.`);
    console.error("❌ Авторизация отклонена:", err);
    server.close();
    process.exit(1);
  }
  if (!code) { res.end("Жду code…"); return; }

  try {
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT,
        grant_type: "authorization_code",
      }).toString(),
    });
    const data = await tokenRes.json();
    if (!data.refresh_token) {
      res.end("Не пришёл refresh_token. Проверь консоль.");
      console.error("❌ Ответ без refresh_token:", JSON.stringify(data, null, 2));
      console.error("   Подсказка: отзови доступ приложения на myaccount.google.com/permissions и повтори (нужен prompt=consent).");
      server.close();
      process.exit(1);
    }

    // Токен ЗАМЕНЯЕМ, а не только дописываем: при переавторизации в .env.local
    // уже лежит старый (просроченный) GOOGLE_ADS_REFRESH_TOKEN, и прежняя
    // версия скрипта молча его не трогала — новый токен никуда не попадал.
    const env = readFileSync(ENV_PATH, "utf8");
    const re = new RegExp(`^${TOKEN_KEY}=.*$`, "m");
    if (re.test(env)) {
      writeFileSync(ENV_PATH, env.replace(re, `${TOKEN_KEY}=${data.refresh_token}`));
      console.log(`\n♻️  Старый ${TOKEN_KEY} в .env.local ЗАМЕНЁН на новый.`);
    } else {
      appendFileSync(ENV_PATH, `${TOKEN_KEY}=${data.refresh_token}\n`);
      console.log(`\n➕ ${TOKEN_KEY} дописан в .env.local.`);
    }

    res.end("✅ Готово! Refresh token получен и записан в .env.local. Можно закрыть вкладку.");
    console.log("\n✅ REFRESH TOKEN:\n");
    console.log("   " + data.refresh_token + "\n");
    // Прод обновляем сами: без этого токен в Vercel остаётся старым и ТЗ в Google Docs ломается молча (авария 16.10.2026).
    if (!process.argv.includes("--no-vercel")) {
      try {
        const { execSync } = await import("node:child_process");
        execSync(`vercel env rm ${TOKEN_KEY} production --yes`, { stdio: "ignore" });
        execSync(`vercel env add ${TOKEN_KEY} production`, { input: data.refresh_token, stdio: ["pipe", "ignore", "inherit"] });
        console.log(`   ☁️  ${TOKEN_KEY} обновлён в Vercel (production). Запускаю деплой, чтобы функции подхватили новый токен…`);
        execSync("vercel --prod --yes", { stdio: "inherit" });
      } catch (e) {
        console.log("   ⚠️  Не удалось обновить Vercel автоматически:", e instanceof Error ? e.message : e);
        console.log(`   Вручную: vercel env rm ${TOKEN_KEY} production --yes ; echo '<token>' | vercel env add ${TOKEN_KEY} production ; vercel --prod --yes`);
      }
    }
    server.close();
    process.exit(0);
  } catch (e) {
    res.end("Ошибка обмена кода. Проверь консоль.");
    console.error("❌", e);
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("\n🔑 Открываю браузер для согласия Google…");
  console.log("   Если не открылось — открой вручную:\n\n   " + authUrl + "\n");
  // Открываем именно Google Chrome (там залогинен нужный Google-аккаунт), а не дефолтный браузер.
  exec(`open -a "Google Chrome" "${authUrl}"`, (err) => {
    if (err) exec(`open "${authUrl}"`); // фолбэк на дефолтный браузер, если Chrome не найден
  });
});
