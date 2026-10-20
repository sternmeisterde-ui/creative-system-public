#!/usr/bin/env python3
"""Референсы из корпуса для написания брифа.

  python3 inspire.py hooks <тип> [n]        — дословные хуки заданного типа из сильных роликов
                                              (я-история | провокация-утверждение | ты-ситуация | обещание-результата | интрига-секрет | анти-совет | вопрос | цитата-реплика)
  python3 inspire.py phrases <функция> [n]  — нейтив-фразы по функции (см. ключи в rules.json native_phrases_by_function) или подстрока названия
  python3 inspire.py cta [n]                — как звучат призывы
  python3 inspire.py closers [n]            — последние слова роликов
  python3 inspire.py transcript <shortCode> — полный транскрипт ролика (для интонационного референса)
"""
import json, sys
from pathlib import Path
HERE = Path(__file__).resolve().parent
R = json.load(open(HERE.parent / "references" / "rules.json", encoding="utf-8"))
ROOT = Path.home() / "ru-reels"
def main():
    if len(sys.argv) < 2: print(__doc__); return
    cmd = sys.argv[1]; arg = sys.argv[2] if len(sys.argv) > 2 else ""; n = int(sys.argv[3]) if len(sys.argv) > 3 else 8
    if cmd == "hooks":
        ex = R["hook_examples"].get(arg)
        if not ex: print("типы:", ", ".join(R["hook_examples"].keys())); return
        for e in ex[:n]: print(f"- «{e}»")
    elif cmd == "phrases":
        cats = R["native_phrases_by_function"]; key = next((k for k in cats if arg.lower() in k.lower()), None)
        if not key: print("функции:", "; ".join(cats.keys())); return
        print(f"## {key}"); print(", ".join(cats[key]))
    elif cmd == "cta":
        for t, c in R["cta_texts"][:int(arg or 15)]: print(f"- «{t}» ({c})")
    elif cmd == "closers":
        for t, c in R["closers_last3"][:int(arg or 15)]: print(f"- «{t}» ({c})")
    elif cmd == "transcript":
        for line in open(ROOT / "data/corpus.jsonl", encoding="utf-8"):
            r = json.loads(line)
            if r["shortCode"] == arg:
                print(r.get("url"), "|", r.get("owner"), "|", r.get("plays"), "просм."); print(r.get("transcript_gemini") or r.get("transcript_whisper")); return
        print("не найден")
    else: print(__doc__)
if __name__ == "__main__":
    main()
