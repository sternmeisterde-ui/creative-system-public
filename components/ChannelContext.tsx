"use client";
import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { PRODUCTS, isProduct, type Product } from "@/lib/product";

// Сквозной выбор КАНАЛА (28.09.2026): у каждого канала свой цикл, панель, отчёт и субъективный
// анализ; «Все каналы» — общий дашборд без операционных действий. Выбор живёт в localStorage
// (cs.channel) и переопределяется параметром ?channel= в URL.

export type Channel = "all" | "meta" | "google" | "tiktok";

export const CHANNELS: { id: Channel; label: string; short: string; color: string; icon: string }[] = [
  { id: "all",    label: "Все каналы", short: "Все",    color: "#E8AA42", icon: "◎" },
  { id: "meta",   label: "Meta Ads",   short: "Meta",   color: "#48B8D0", icon: "◐" },
  { id: "google", label: "Google Ads", short: "Google", color: "#6EC8A0", icon: "●" },
  { id: "tiktok", label: "TikTok Ads", short: "TikTok", color: "#C490D1", icon: "♪" },
];

export const channelMeta = (c: Channel) => CHANNELS.find(x => x.id === c) ?? CHANNELS[0];

/** query-string для API: пусто при «все каналы» */
export const channelQuery = (c: Channel, first = true) => (c === "all" ? "" : `${first ? "?" : "&"}platform=${c}`);
/** query-string канал + продукт: "" | "?platform=meta" | "?product=medadmin" | "?platform=meta&product=medadmin" */
export const filterQuery = (c: Channel, p: Product) => {
  const parts = [c !== "all" ? `platform=${c}` : null, p !== "all" ? `product=${p}` : null].filter(Boolean);
  return parts.length ? `?${parts.join("&")}` : "";
};

const KEY = "cs.channel";
const PKEY = "cs.product";

interface Ctx { channel: Channel; setChannel: (c: Channel) => void; isAll: boolean; product: Product; setProduct: (p: Product) => void }
const ChannelCtx = createContext<Ctx>({ channel: "all", setChannel: () => {}, isAll: true, product: "all", setProduct: () => {} });

export function ChannelProvider({ children }: { children: React.ReactNode }) {
  const [channel, setChannelState] = useState<Channel>("all");
  // Продукт (Бухгалтер / Медадмин / оба) — второй сквозной выбор: отчёт, конструктор, неделя, аналитика
  const [product, setProductState] = useState<Product>("all");
  // Пока канал не прочитан из URL/localStorage — детей не рендерим: иначе страницы сначала
  // грузят данные для «all», потом для реального канала, и медленный первый ответ затирает второй.
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get("channel") as Channel | null;
    const saved = window.localStorage.getItem(KEY) as Channel | null;
    const pick = (v: string | null): Channel | null => (v && CHANNELS.some(c => c.id === v) ? (v as Channel) : null);
    const c = pick(fromUrl) ?? pick(saved) ?? "all";
    setChannelState(c);
    if (fromUrl) window.localStorage.setItem(KEY, c);
    const pUrl = new URLSearchParams(window.location.search).get("product");
    const pSaved = window.localStorage.getItem(PKEY);
    const prod: Product = isProduct(pUrl) ? pUrl : isProduct(pSaved) ? pSaved : "all";
    setProductState(prod);
    if (pUrl) window.localStorage.setItem(PKEY, prod);
    setReady(true);
  }, []);

  const setChannel = (c: Channel) => {
    setChannelState(c);
    window.localStorage.setItem(KEY, c);
  };

  const setProduct = (p: Product) => { setProductState(p); window.localStorage.setItem(PKEY, p); };
  const value = useMemo(() => ({ channel, setChannel, isAll: channel === "all", product, setProduct }), [channel, product]);
  return <ChannelCtx.Provider value={value}>{ready ? children : null}</ChannelCtx.Provider>;
}

export function useChannel() {
  return useContext(ChannelCtx);
}

/** Переключатель каналов — в сайдбаре и, при желании, на страницах. */
export function ChannelSwitch({ compact = false }: { compact?: boolean }) {
  const { channel, setChannel } = useChannel();
  return (
    <div style={{ display: "grid", gridTemplateColumns: compact ? "repeat(4, auto)" : "1fr 1fr", gap: 4 }}>
      {CHANNELS.map(c => {
        const active = channel === c.id;
        return (
          <button key={c.id} onClick={() => setChannel(c.id)} title={c.label} style={{
            padding: compact ? "5px 10px" : "7px 8px", borderRadius: 7, fontSize: 11, cursor: "pointer", fontFamily: "inherit",
            fontWeight: active ? 700 : 500, textAlign: "left", display: "flex", alignItems: "center", gap: 6,
            border: active ? `1px solid ${c.color}66` : "1px solid rgba(255,255,255,0.06)",
            background: active ? `${c.color}1A` : "rgba(255,255,255,0.02)", color: active ? c.color : "#666",
          }}>
            <span style={{ fontSize: 10 }}>{c.icon}</span>{compact ? c.short : c.label}
          </button>
        );
      })}
    </div>
  );
}

/** Продукт: Бухгалтер / Медадмин / оба. */
export function useProduct() {
  const { product, setProduct } = useContext(ChannelCtx);
  return { product, setProduct, isAllProducts: product === "all" };
}

export function ProductSwitch() {
  const { product, setProduct } = useProduct();
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 4 }}>
      {PRODUCTS.map(p => {
        const active = product === p.id;
        return (
          <button key={p.id} onClick={() => setProduct(p.id)} title={p.label} style={{
            padding: "6px 4px", borderRadius: 7, fontSize: 11, cursor: "pointer", fontFamily: "inherit",
            fontWeight: active ? 700 : 500, display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
            border: active ? `1px solid ${p.color}66` : "1px solid rgba(255,255,255,0.06)",
            background: active ? `${p.color}1A` : "rgba(255,255,255,0.02)", color: active ? p.color : "#666",
          }}>
            <span style={{ fontSize: 10 }}>{p.icon}</span>{p.short}
          </button>
        );
      })}
    </div>
  );
}
