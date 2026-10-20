#!/usr/bin/env python3
"""Справка по слову или фразе из словарей и корпуса.

  python3 lookup.py stress <слово>          — варианты ударения (Викисловарь)
  python3 lookup.py register <слово>        — пометы Ожегова (разг./прост./книжн./высок./…) и начало статьи
  python3 lookup.py define <слово>          — толкование из Ожегова (первые 400 символов)
  python3 lookup.py corpus "<фраза>" [n]    — примеры употребления в корпусе рилсов с автором и ссылкой
  python3 lookup.py classic "<фраза>" [n]   — цитаты из классики (29 книг) с этой фразой
  python3 lookup.py freq <слово>            — частота в речи (корпус) vs письменной норме (НКРЯ ipm)
"""
import json, re, sys
from pathlib import Path
ROOT = Path.home() / "ru-reels"          # локальная версия (корпус, классика, полные словари)
LANG = ROOT / "data/analysis/lang"
LOCAL = Path(__file__).resolve().parent.parent / "data"           # переносимая версия (усечённые словари внутри скилла)
def load(p):
    for cand in (LOCAL / Path(p).name, p):
        try: return json.load(open(cand, encoding="utf-8"))
        except Exception: continue
    return {}
def lemma(w):
    try:
        import pymorphy3; return pymorphy3.MorphAnalyzer().parse(w)[0].normal_form.replace("ё", "е")
    except Exception: return w.lower().replace("ё", "е")

def main():
    if len(sys.argv) < 3: print(__doc__); return
    cmd, arg = sys.argv[1], sys.argv[2].strip().lower()
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    if cmd == "stress":
        st = load(LANG / "stress.json"); forms = st.get(arg.replace("́", ""))
        print(f"{arg}: {' / '.join(forms) if forms else 'нет в словаре (заимствование/имя/форма с ё?) — см. references/08_stress.md'}")
        l = lemma(arg)
        if l != arg and st.get(l): print(f"лемма {l}: {' / '.join(st[l])}")
    elif cmd in ("register", "define"):
        oz = load(LANG / "ozhegov_marks.json"); l = lemma(arg); e = oz.get(l) or oz.get(arg)
        if not e: print(f"{arg} (лемма {l}): нет в Ожегове — либо сленг/заимствование/имя, либо форма"); return
        print(f"{l}: пометы на всё слово: {e.get('marks') or '—'}; внутри значений: {e.get('sense_marks') or '—'}")
        if cmd == "define":
            if not (ROOT / "lang/raw/ozhegov.txt").exists(): print(e.get("head")); return
            txt = (ROOT / "lang/raw/ozhegov.txt").read_text(encoding="utf-8")
            m = re.search(rf"(?m)^{re.escape(l.upper())}\d?,.*(?:\n(?![А-ЯЁ][А-ЯЁ\-]+\d?,).*){{0,6}}", txt)
            print(re.sub(r"\s+", " ", m.group(0))[:400] if m else e.get("head"))
        else: print(e.get("head"))
    elif cmd == "corpus":
        if not (ROOT / "data/corpus.jsonl").exists(): print("корпус доступен только в локальной версии (ru-reels/data/corpus.jsonl)"); return
        k = 0
        for line in open(ROOT / "data/corpus.jsonl", encoding="utf-8"):
            r = json.loads(line); t = (r.get("transcript_whisper") or "").lower()
            i = t.find(arg)
            if i >= 0:
                s = t[max(0, i - 90): i + len(arg) + 90].replace("\n", " ")
                print(f"- …{s}… — @{r.get('owner')}, {r.get('plays')} просм., {r.get('url')}"); k += 1
                if k >= n: break
        if not k: print("в корпусе не найдено")
    elif cmd == "classic":
        if not (ROOT / "lang/user/classics").exists(): print("классика доступна только в локальной версии (ru-reels/lang/user/classics)"); return
        k = 0
        for f in sorted((ROOT / "lang/user/classics").glob("*.txt")):
            t = f.read_text(encoding="utf-8", errors="ignore")
            for m in re.finditer(re.escape(arg), t.lower()):
                s = t[max(0, m.start() - 120): m.end() + 120].replace("\n", " ")
                print(f"- «…{s}…» — {f.stem}"); k += 1
                if k >= n: break
            if k >= n: break
        if not k: print("в классике не найдено")
    elif cmd == "freq":
        fw = load(LANG / "freq_written.json"); q = load(ROOT / "data/analysis/quant.json"); l = lemma(arg)
        sp = next((c for ll, c, d in q.get("lemmas_top300", []) if ll == l), None)
        tot = q.get("tokens", 1)
        print(f"{l}: письменная норма {fw.get(l, 0):.1f} ipm; в корпусе речи {'%.0f ipm' % (sp / tot * 1e6) if sp else 'вне топ-300 (см. lookup corpus)'}")
    else: print(__doc__)

if __name__ == "__main__":
    main()
