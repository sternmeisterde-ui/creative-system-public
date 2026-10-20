import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Скилл ru-video-brief читается с диска в системный промпт генерации брифов (lib/ru-video-brief.ts) —
  // без трассировки Vercel не положит .md в бандл функции
  outputFileTracingIncludes: {
    "/api/ai/generate-briefs": ["./.claude/skills/ru-video-brief/SKILL.md", "./.claude/skills/ru-video-brief/references/*.md", "./.claude/skills/ru-video-brief/templates/*.md"],
  },
  experimental: {
    serverActions: {
      bodySizeLimit: "50mb",
    },
  },
  images: {
    // Превью Google/TikTok идут через наш резолвер с query (?adId=…) и сжимаются оптимизатором Next (PNG 1.3 МБ → webp ~30 КБ).
    // Без localPatterns оптимизатор отвечает INVALID_IMAGE_OPTIMIZE_REQUEST на локальные пути с query (Next 15+).
    localPatterns: [{ pathname: "/api/meta/thumb" }],
    minimumCacheTTL: 86400,
  },
};

export default nextConfig;
