import { supabase } from "./supabase";
import { getNextCode } from "./naming";
import type { Persona, Hook, Body, Angle, Concept, Actor, Rule, ConstructorSession, Brief, Creative } from "./types";
import { FORMULATION_COLUMNS, rowToFormulation, type Formulation, type FormulationRow, type Axis, type FormulationProduct } from "./formulations";

// ── helpers ───────────────────────────────────────────────────────────────────

function snake<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const s = k.replace(/([A-Z])/g, "_$1").toLowerCase();
    out[s] = obj[k];
  }
  return out;
}

function camel<T>(obj: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const k in obj) {
    const c = k.replace(/_([a-z])/g, (_, l) => l.toUpperCase());
    out[c] = obj[k];
  }
  return out as T;
}

function camels<T>(rows: Record<string, unknown>[]): T[] {
  return rows.map(r => camel<T>(r));
}

// ── Formulations (06.10.2026) — уникальные дословные параметры; запись только через /api/formulations ──

export const formulationStore = {
  getAll: async (filter?: { axis?: Axis; product?: FormulationProduct | "all" }): Promise<Formulation[]> => {
    const out: Formulation[] = [];
    for (let from = 0; ; from += 1000) {
      let q = supabase.from("formulations").select(FORMULATION_COLUMNS).order("created_at").range(from, from + 999);
      if (filter?.axis) q = q.eq("axis", filter.axis);
      if (filter?.product && filter.product !== "all") q = q.eq("product", filter.product);
      const { data } = await q;
      out.push(...((data ?? []) as FormulationRow[]).map(rowToFormulation));
      if (!data || data.length < 1000) break;
    }
    return out;
  },
  byIds: async (ids: string[]): Promise<Record<string, Formulation>> => {
    const uniq = Array.from(new Set(ids.filter(Boolean)));
    const map: Record<string, Formulation> = {};
    for (let i = 0; i < uniq.length; i += 200) {
      const { data } = await supabase.from("formulations").select(FORMULATION_COLUMNS).in("id", uniq.slice(i, i + 200));
      for (const r of (data ?? []) as FormulationRow[]) map[r.id] = rowToFormulation(r);
    }
    return map;
  },
};

// ── Personas (устаревшая библиотека категорий — только чтение старых брифов) ──

export const personaStore = {
  getAll: async (): Promise<Persona[]> => {
    const { data } = await supabase.from("personas").select("*").order("created_at");
    return camels<Persona>(data ?? []);
  },
  save: async (p: Omit<Persona, "id" | "createdAt">): Promise<Persona> => {
    const code = p.code || await getNextCode("personas");
    const { data } = await supabase.from("personas").insert(snake({ ...p, code } as Record<string, unknown>)).select().single();
    return camel<Persona>(data);
  },
  update: async (id: string, p: Partial<Persona>): Promise<void> => {
    await supabase.from("personas").update(snake(p as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("personas").delete().eq("id", id);
  },
};

// ── Hooks ─────────────────────────────────────────────────────────────────────

export const hookStore = {
  getAll: async (): Promise<Hook[]> => {
    const { data } = await supabase.from("hooks").select("*").order("created_at");
    return camels<Hook>(data ?? []);
  },
  save: async (h: Omit<Hook, "id" | "createdAt">): Promise<Hook> => {
    const code = h.code || await getNextCode("hooks");
    const { data } = await supabase.from("hooks").insert(snake({ ...h, code } as Record<string, unknown>)).select().single();
    return camel<Hook>(data);
  },
  update: async (id: string, h: Partial<Hook>): Promise<void> => {
    await supabase.from("hooks").update(snake(h as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("hooks").delete().eq("id", id);
  },
};

// ── Bodies ────────────────────────────────────────────────────────────────────

export const bodyStore = {
  getAll: async (): Promise<Body[]> => {
    const { data } = await supabase.from("bodies").select("*").order("created_at");
    return camels<Body>(data ?? []);
  },
  save: async (b: Omit<Body, "id" | "createdAt">): Promise<Body> => {
    const code = b.code || await getNextCode("bodies");
    const { data } = await supabase.from("bodies").insert(snake({ ...b, code } as Record<string, unknown>)).select().single();
    return camel<Body>(data);
  },
  update: async (id: string, b: Partial<Body>): Promise<void> => {
    await supabase.from("bodies").update(snake(b as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("bodies").delete().eq("id", id);
  },
};

// ── Angles ────────────────────────────────────────────────────────────────────

export const angleStore = {
  getAll: async (): Promise<Angle[]> => {
    const { data } = await supabase.from("angles").select("*").order("created_at");
    return camels<Angle>(data ?? []);
  },
  save: async (a: Omit<Angle, "id" | "createdAt">): Promise<Angle> => {
    const code = a.code || await getNextCode("angles");
    const { data } = await supabase.from("angles").insert(snake({ ...a, code } as Record<string, unknown>)).select().single();
    return camel<Angle>(data);
  },
  update: async (id: string, a: Partial<Angle>): Promise<void> => {
    await supabase.from("angles").update(snake(a as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("angles").delete().eq("id", id);
  },
};

// ── Concepts (концепции видео, код V{n}) ──────────────────────────────────────

export const conceptStore = {
  getAll: async (): Promise<Concept[]> => {
    const { data } = await supabase.from("concepts").select("*").order("code");
    return camels<Concept>(data ?? []).sort((a, b) => (parseInt((a.code ?? "V0").slice(1)) || 0) - (parseInt((b.code ?? "V0").slice(1)) || 0));
  },
  save: async (c: Omit<Concept, "id" | "createdAt">): Promise<Concept> => {
    const code = c.code || await getNextCode("concepts");
    const { data } = await supabase.from("concepts").insert(snake({ ...c, code } as Record<string, unknown>)).select().single();
    return camel<Concept>(data);
  },
  update: async (id: string, c: Partial<Concept>): Promise<void> => {
    await supabase.from("concepts").update(snake(c as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("concepts").delete().eq("id", id);
  },
};

// ── Actors (конкретные актёры: реальные по имени, ИИ — по кодам WOM/MAN) ──────

export const actorStore = {
  getAll: async (): Promise<Actor[]> => {
    const { data } = await supabase.from("actors").select("*").order("kind").order("code");
    return camels<Actor>(data ?? []);
  },
  save: async (a: Omit<Actor, "id" | "createdAt">): Promise<Actor> => {
    const { data } = await supabase.from("actors").insert(snake({ ...a, code: a.code.trim().toUpperCase() } as Record<string, unknown>)).select().single();
    return camel<Actor>(data);
  },
  update: async (id: string, a: Partial<Actor>): Promise<void> => {
    await supabase.from("actors").update(snake(a as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("actors").delete().eq("id", id);
  },
};

// ── Rules ─────────────────────────────────────────────────────────────────────

export const ruleStore = {
  getAll: async (): Promise<Rule[]> => {
    const { data } = await supabase.from("rules").select("*").order("created_at");
    return camels<Rule>(data ?? []);
  },
  save: async (r: Omit<Rule, "id" | "createdAt">): Promise<Rule> => {
    const { data } = await supabase.from("rules").insert(snake(r as Record<string, unknown>)).select().single();
    return camel<Rule>(data);
  },
  update: async (id: string, r: Partial<Rule>): Promise<void> => {
    await supabase.from("rules").update(snake(r as Record<string, unknown>)).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("rules").delete().eq("id", id);
  },
};

// ── Constructor Sessions ───────────────────────────────────────────────────────

export const sessionStore = {
  getAll: async (): Promise<ConstructorSession[]> => {
    const { data } = await supabase.from("constructor_sessions").select("*").order("created_at", { ascending: false });
    return camels<ConstructorSession>(data ?? []);
  },
  save: async (s: Omit<ConstructorSession, "id" | "createdAt">): Promise<ConstructorSession> => {
    const payload = {
      name: s.name,
      flow: s.flow ?? "com",
      selected_personas: s.selectedPersonas,
      selected_hooks: s.selectedHooks,
      selected_bodies: s.selectedBodies,
      selected_angles: s.selectedAngles,
      format: s.format,
      total_combinations: s.totalCombinations,
      status: s.status,
    };
    const { data } = await supabase.from("constructor_sessions").insert(payload).select().single();
    return camel<ConstructorSession>(data);
  },
  update: async (id: string, s: Partial<ConstructorSession>): Promise<void> => {
    const payload: Record<string, unknown> = {};
    if (s.name !== undefined) payload.name = s.name;
    if (s.status !== undefined) payload.status = s.status;
    if (s.selectedPersonas !== undefined) payload.selected_personas = s.selectedPersonas;
    if (s.selectedHooks !== undefined) payload.selected_hooks = s.selectedHooks;
    if (s.selectedBodies !== undefined) payload.selected_bodies = s.selectedBodies;
    if (s.selectedAngles !== undefined) payload.selected_angles = s.selectedAngles;
    if (s.totalCombinations !== undefined) payload.total_combinations = s.totalCombinations;
    if (s.format !== undefined) payload.format = s.format;
    await supabase.from("constructor_sessions").update(payload).eq("id", id);
  },
  delete: async (id: string): Promise<void> => {
    await supabase.from("constructor_sessions").delete().eq("id", id);
  },
};

// ── Briefs ────────────────────────────────────────────────────────────────────

export const briefStore = {
  getAll: async (): Promise<Brief[]> => {
    const { data } = await supabase.from("briefs").select("*").order("created_at");
    return camels<Brief>(data ?? []);
  },
  getBySession: async (sessionId: string): Promise<Brief[]> => {
    const { data } = await supabase.from("briefs").select("*")
      .eq("session_id", sessionId)
      .order("batch_index");
    return camels<Brief>(data ?? []);
  },
  clearBySession: async (sessionId: string): Promise<void> => {
    await supabase.from("briefs").delete().eq("session_id", sessionId);
  },
  saveMany: async (briefs: Omit<Brief, "id" | "createdAt">[]): Promise<Brief[]> => {
    const payload = briefs.map((b, i) => ({
      session_id: b.sessionId,
      persona_id: b.personaId ?? null,
      hook_id: b.hookId,
      body_id: b.bodyId,
      angle_id: b.angleId,
      format: b.format,
      adapted_hook: b.adaptedHook,
      adapted_body: b.adaptedBody,
      adapted_angle: b.adaptedAngle,
      full_brief: b.fullBrief,
      // Auto-approve: убрали ручной gate «одобрить/правки» — все брифы готовы к производству.
      status: "approved",
      batch_index: b.batchIndex ?? i,
    }));
    const { data } = await supabase.from("briefs").insert(payload).select();
    return camels<Brief>(data ?? []);
  },
  updateStatus: async (id: string, status: Brief["status"], revisionNote?: string): Promise<void> => {
    await supabase.from("briefs").update({ status, revision_note: revisionNote ?? null }).eq("id", id);
  },
};

// ── Creatives ─────────────────────────────────────────────────────────────────

export const creativeStore = {
  getAll: async (): Promise<Creative[]> => {
    const { data } = await supabase.from("creatives").select("*").order("created_at", { ascending: false });
    return camels<Creative>(data ?? []);
  },
  save: async (c: Omit<Creative, "id" | "createdAt">): Promise<Creative> => {
    const payload = {
      source: c.source,
      flow: c.flow ?? "com",
      persona_id: c.personaId,
      hook_id: c.hookId,
      body_id: c.bodyId,
      angle_id: c.angleId,
      format: c.format,
      status: c.status,
      meta_ad_id: c.metaAdId,
      meta_ad_name: c.metaAdName,
      competitor_name: c.competitorName,
      raw_text: c.rawText,
      description: c.description,
      notes: c.notes,
    };
    const { data } = await supabase.from("creatives").insert(payload).select().single();
    return camel<Creative>(data);
  },
  update: async (id: string, c: Partial<Creative>): Promise<void> => {
    await supabase.from("creatives").update(snake(c as Record<string, unknown>)).eq("id", id);
  },
};
