#!/usr/bin/env python3
"""Линтер речи для брифа: проверяет текст реплик против правил корпуса (rules.json), словаря ударений и помет Ожегова.

  python3 check_brief.py <файл.md|txt> [--wpm 130] [--dialog] [--json]

Что проверяет: длина ролика по словам, длина предложений, начала предложений, вопросы, заполнители/маркеры, адресат (ты/вы),
присутствие «я», бан-слова и таблицу замен, ИИ-конструкции (триады, «не просто…, а», причастия/деепричастия, «который» подряд),
книжный регистр по Ожегову, хук (длина первой фразы, приветствие, тип), призыв (ссылка/сохрани), ударения в трудных словах.
Из markdown берёт только речь: строки таблицы «Сценарий» (вторая колонка) или раздел «Речь/Сценарий»; если разметки нет — весь текст.
"""
from __future__ import annotations
import json, re, sys, argparse, statistics as st
from pathlib import Path
HERE = Path(__file__).resolve().parent
RULES = json.load(open(HERE.parent / "references" / "rules.json", encoding="utf-8"))
LOCAL = HERE.parent / "data"                                                # переносимая версия: словари внутри скилла
DATA = Path.home() / "ru-reels/data/analysis/lang"     # локальная версия: полные словари на диске
def _load(*cands):
    for p in cands:
        try: return json.load(open(p, encoding="utf-8"))
        except Exception: continue
    return {}
STRESS = _load(LOCAL / "stress.json", DATA / "stress.json"); OZH = _load(LOCAL / "ozhegov_marks.json", DATA / "ozhegov_marks.json")
try:
    import pymorphy3; MORPH = pymorphy3.MorphAnalyzer()
except Exception:
    MORPH = None
ACUTE = "́"
TOK = re.compile(r"[а-яёА-ЯЁ][а-яёА-ЯЁ\-́]*")

def extract_speech(text: str) -> str:
    """Речь из брифа: 2-я колонка таблиц сценария, либо раздел «Сценарий/Речь», либо весь текст."""
    rows = []
    col = 1  # колонка реплики: по заголовку «Реплика» (бриф Creative System: 4-я), иначе вторая (templates/brief.md)
    for line in text.split("\n"):
        if line.strip().startswith("|") and not re.match(r"^\|\s*[-:| ]+\|?\s*$", line.strip()):
            cells = [c.strip() for c in re.split(r"(?<!\\)\|", line.strip().strip("|"))]
            hdr = next((i for i, c in enumerate(cells) if re.match(r"^реплик", c, re.I)), -1)
            if hdr >= 0: col = hdr; continue
            if len(cells) >= 2 and re.match(r"^\d{1,2}:\d{2}", cells[0]):
                rows.append(cells[col] if col < len(cells) else cells[1])
    if rows:
        return " ".join(rows)
    m = re.search(r"##+\s*(Сценарий|Речь|Текст)[^\n]*\n(.*?)(?=\n##+\s|\Z)", text, re.S | re.I)
    if m:
        body = re.sub(r"\|[^|\n]*\|", " ", m.group(2))
        return body
    return text

def sentences(t: str):
    parts = re.split(r"(?<=[.!?…])\s+|\n+", t)
    return [p.strip() for p in parts if TOK.search(p or "")]

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("file"); ap.add_argument("--wpm", type=float, default=130); ap.add_argument("--dialog", action="store_true", help="сценка: смешение ты/вы допустимо"); ap.add_argument("--json", action="store_true")
    a = ap.parse_args()
    raw = Path(a.file).read_text(encoding="utf-8")
    speech = extract_speech(raw)
    plain = speech.replace(ACUTE, "")
    toks = [t.lower() for t in TOK.findall(plain)]
    n = len(toks)
    sents = sentences(plain)
    lens = [len(TOK.findall(s)) for s in sents]
    low = " " + " ".join(toks) + " "
    R = RULES; rep = {"words": n, "duration_sec_at_wpm": round(n / a.wpm * 60, 1) if n else 0}
    issues, warns, oks = [], [], []

    # предложения
    if lens:
        rep["sent_median"] = st.median(lens); rep["sent_le5_share"] = round(sum(1 for l in lens if l <= 5) / len(lens) * 100)
        rep["sent_ge20_share"] = round(sum(1 for l in lens if l >= 20) / len(lens) * 100); rep["sent_max"] = max(lens)
        if rep["sent_median"] > 9: issues.append(f"предложения длинные: медиана {rep['sent_median']} слов (в живой речи 6)")
        elif rep["sent_median"] < 4: warns.append(f"предложения очень короткие: медиана {rep['sent_median']} (норма 6)")
        else: oks.append(f"медиана предложения {rep['sent_median']} слов")
        if rep["sent_le5_share"] < 30: issues.append(f"мало коротких реплик: {rep['sent_le5_share']}% ≤5 слов (в речи 48%)")
        if rep["sent_ge20_share"] > 12: issues.append(f"много длинных: {rep['sent_ge20_share']}% ≥20 слов (в речи 5%)")
        if rep["sent_max"] > 28: warns.append(f"самое длинное предложение {rep['sent_max']} слов — разбить")
        starters = sum(1 for s in sents if re.match(r"^(и|а|ну|вот|да)\b", s.lower()))
        rep["starters_share"] = round(starters / len(sents) * 100)
        if rep["starters_share"] < 8: warns.append(f"начала с «и/а/ну/вот/да» {rep['starters_share']}% (в речи ~20%) — добавить 2–3")
        else: oks.append(f"начала с и/а/ну/вот/да {rep['starters_share']}%")
        q = plain.count("?"); rep["questions_per100"] = round(q / max(n, 1) * 100, 1)
        if rep["questions_per100"] > 3: warns.append(f"вопросов {q} на {n} слов — многовато (норма ~1 на 100)")
        if re.search(r"\?[^.!?]*\?", plain.replace("\n", " ")) and q >= 3: warns.append("вопросы подряд — оставить один")

    # заполнители / маркеры
    markers = [m for m, c, d, p in R["markers_top"]]
    fill_set = ["ну", "вот", "короче", "типа", "как бы", "слушай", "слушайте", "смотри", "смотрите", "в общем", "значит", "это самое", "блин", "честно", "прям", "реально", "кстати", "знаете", "знаешь", "так вот", "по факту", "на самом деле", "ладно", "получается", "в смысле"]
    fillers = sum(low.count(f" {f} ") for f in fill_set); rep["fillers_per100"] = round(fillers / max(n, 1) * 100, 1)
    mk = sum(low.count(f" {m} ") for m in markers if " " not in m) + sum(low.count(f" {m} ") for m in markers if " " in m); rep["markers_per100"] = round(mk / max(n, 1) * 100, 1)
    if n >= 40:
        if rep["fillers_per100"] < 1: issues.append(f"заполнителей {rep['fillers_per100']}/100 — звучит как читка (норма 2–3: ну, вот, короче, слушай, честно)")
        elif rep["fillers_per100"] > 6: warns.append(f"заполнителей {rep['fillers_per100']}/100 — много (p90 в корпусе 6.6)")
        else: oks.append(f"заполнители {rep['fillers_per100']}/100")

    # адресат и «я»
    ty = sum(low.count(f" {w} ") for w in ["ты", "тебя", "тебе", "тобой", "твой", "твоя", "твои", "твоё", "твое", "твоей", "твою"]) + len(re.findall(r"\b(смотри|слушай|представь|знаешь|понимаешь|давай|напиши|скажи|попробуй|возьми|иди|стой|видишь|подумай|запомни|сохрани|подпишись|пиши)\b", low))
    vy = sum(low.count(f" {w} ") for w in ["вы", "вас", "вам", "вами", "ваш", "ваша", "ваши", "ваше", "вашей", "вашу"]) + len(re.findall(r"\b(смотрите|слушайте|представьте|знаете|понимаете|давайте|напишите|скажите|попробуйте|возьмите|идите|видите|подумайте|запомните|сохраните|подпишитесь|пишите)\b", low))
    ya = sum(low.count(f" {w} ") for w in ["я", "мне", "меня", "мной", "мой", "моя", "мои", "моё", "мое", "моей", "мою"])
    rep["ty"], rep["vy"], rep["ya_per100"] = ty, vy, round(ya / max(n, 1) * 100, 1)
    if ty and vy and not a.dialog and min(ty, vy) / max(ty, vy) > 0.25: issues.append(f"смешано «ты» ({ty}) и «вы» ({vy}) — выбрать одно (кроме сценки: флаг --dialog)")
    if not ty and not vy: issues.append("нет адресата: ни «ты», ни «вы», ни императива 2-го лица — у слабых роликов медиана 0, у сильных > 0")
    else: oks.append(f"адресат: ты {ty} / вы {vy}")
    if n >= 40 and rep["ya_per100"] < 1: warns.append(f"«я/мне/меня» {rep['ya_per100']}/100 — говорящего нет в тексте (в корпусе медиана 3)")

    # бан-слова и замены
    ban_hits = []
    for b in R["ban_words"] + list(R["prefer_map"].keys()):
        bb = b.lower()
        if (" " in bb and bb in low) or (" " not in bb and re.search(rf"(?<![а-яё]){re.escape(bb)}", low)):
            ban_hits.append(f"{b} → {R['prefer_map'].get(b, 'убрать / сказать проще')}")
    rep["ban_hits"] = sorted(set(ban_hits))
    if ban_hits: issues.append("книжные/ИИ-слова: " + "; ".join(sorted(set(ban_hits))[:12]))
    under = [w for w in R["written_underrepresented"] if len(w) >= 4 and re.search(rf"(?<![а-яё]){re.escape(w)}(?![а-яё])", low)]
    if under: warns.append("слова письменной нормы, которых в речи почти нет: " + ", ".join(under[:10]))

    # ИИ-конструкции
    triads = 0
    for s in sents:
        for clause in re.split(r"[;:]", s):
            if "," in clause and re.search(r"\sи\s", clause):
                items = [x for x in re.split(r",|\sи\s", clause) if x.strip()]
                if len(items) == 3: triads += 1
    rep["triads"] = triads
    if triads >= 2: issues.append(f"перечислений по три: {triads} — в живой речи триады редки (13% роликов), оставить одно или разбить")
    np_ = len(re.findall(r"не просто[^.!?]{0,40},\s*а\b", low)); rep["ne_prosto_a"] = np_
    if np_: warns.append(f"«не просто…, а…» ×{np_} — ИИ-каркас, в речи редок")
    if MORPH:
        prt = [t for t in toks if MORPH.parse(t)[0].tag.POS in ("PRTF", "PRTS", "GRND")]
        rep["participles"] = len(prt)
        if prt: issues.append(f"причастия/деепричастия ({len(prt)}): {', '.join(prt[:8])} — в речи их нет, переписать глаголом")
    kot = len(re.findall(r"\b(котор(ый|ая|ое|ые|ого|ому|ом|ой|ую|ых|ым|ыми))\b", low)); rep["kotoryj"] = kot
    if kot > max(2, n // 60): warns.append(f"«который» ×{kot} — многовато, дробить на реплики")
    rq = len(re.findall(r"\?\s+[А-ЯЁ][^.!?]{0,80}\.", plain)); 
    if rq >= 2: warns.append(f"риторический вопрос + сразу ответ ×{rq} — ИИ-ритм, оставить один")
    if re.search(r"важно (отметить|понимать|помнить)|давайте разберёмся|давайте разберемся|в современном мире|представьте себе.*представьте себе", low): issues.append("ИИ-штамп: «важно отметить/понимать», «давайте разберёмся», «в современном мире»")

    # регистр по Ожегову
    bookish = []
    if OZH and MORPH:
        for t in set(toks):
            l = MORPH.parse(t)[0].normal_form.replace("ё", "е")
            e = OZH.get(l)
            if e and any(m in e.get("marks", []) for m in ("книжн.", "высок.", "офиц.")) and l not in ("быть", "мочь", "весь", "должный"):
                bookish.append(f"{t} ({'/'.join(e['marks'])})")
    rep["bookish"] = bookish
    if len(bookish) >= 3: warns.append("книжный регистр по Ожегову: " + ", ".join(bookish[:10]))

    # хук
    if sents:
        first = sents[0]; fl = len(TOK.findall(first)); rep["hook_words"] = fl; rep["hook"] = first[:140]
        if fl > 12: issues.append(f"первая фраза {fl} слов — хук должен быть ≤ 12")
        fl_low = first.lower()
        if re.search(r"^(всем привет|привет|здравствуйте|добрый день|доброе утро|добрый вечер|друзья)", fl_low) or "меня зовут" in fl_low: issues.append("хук начинается с приветствия/представления — потеря первых секунд (у сильных роликов этого нет)")
        if re.search(r"в этом видео|сегодня мы поговорим|сегодня я расскажу", fl_low): issues.append("хук-анонс («в этом видео…») — заменить на историю, провокацию или ты-ситуацию")
        if re.match(r"^\d|^[^.!?]*\d{2,}[^.!?]*(тонн|процент|миллион|тысяч)", fl_low) and "я" not in fl_low.split()[:3]: warns.append("хук-цифра без «я» — тип с худшим перевесом по ER (0.3); цифра работает внутри личной истории")
        htype = "вопрос" if "?" in first else "ты-ситуация" if re.match(r"^(если (ты|вы|у тебя|у вас)|когда (ты|вы)|вы когда|ты когда|у тебя|у вас)", fl_low) else "я-история" if re.match(r"^(я|у меня|мне|мы)\b", fl_low) else "императив" if re.match(r"^(стой|смотри|смотрите|слушай|представь|не |никогда|давай)", fl_low) else "обещание" if re.search(r"^(сейчас|покажу|расскажу)", fl_low) else "утверждение/провокация"
        rep["hook_type_guess"] = htype
        if htype == "вопрос" and not re.match(r"^(а вы знали|а ты знал|вы когда|ты когда|как (ты|вы)|почему (ты|вы|у тебя|у вас))", fl_low): warns.append("хук-вопрос общего вида — тип с перевесом 0.8; работает только вопрос-ситуация про зрителя")

    # призыв
    tail = " ".join(sents[-2:]).lower() if sents else ""
    if re.search(r"ссылк|по ссылке|переход", tail): issues.append("призыв со ссылкой в финале — по ER резко проигрывает (5 против 31); заменить на комментарий/подписку/директ или убрать")
    if re.search(r"сохрани|сохраняй|сохраните", tail): warns.append("«сохрани» в финале — проигрывает по ER (4 против 23)")
    if re.search(r"(подпис|коммент|напиши|пишите|напишите|директ|как вам|что думаете)", tail): oks.append("призыв: комментарий/подписка/директ — рабочий тип")

    # ударения
    need = []
    trouble = set(R["stress_trouble"].keys()) | set(R["stress_loans"].keys()) | {"поняла", "взяла", "дала", "ждала", "брала", "спала", "приняла", "началась", "начался", "отдала", "звонит", "договор", "красивее", "торты", "включит", "включишь", "средства", "маркетинг", "латте", "эксперт", "телеграм", "инстаграм", "лайфхак", "директ", "капучино", "контент"}
    raw_toks = TOK.findall(speech)
    for t in raw_toks:
        tl = t.lower().replace(ACUTE, "")
        if tl in trouble and ACUTE not in t:
            hint = R["stress_trouble"].get(tl) or R["stress_loans"].get(tl) or "/".join(STRESS.get(tl, [])[:2])
            need.append(f"{t} → {hint}")
    homographs = [t for t in raw_toks if ACUTE not in t and len(STRESS.get(t.lower(), [])) > 1 and t.lower() in ("замок", "мука", "орган", "атлас", "стоит", "дома", "года", "большая", "пора", "потом", "уже", "дела", "руки", "ноги", "глаза", "слова", "стороны", "воды", "цены", "права", "начала")]
    rep["stress_missing"] = sorted(set(need)); rep["homographs_unmarked"] = sorted(set(homographs))
    if need: warns.append("ударения не расставлены: " + "; ".join(sorted(set(need))[:10]))
    if homographs: warns.append("омографы без ударения (для диктора): " + ", ".join(sorted(set(homographs))[:10]))

    rep["issues"], rep["warnings"], rep["ok"] = issues, warns, oks
    if a.json:
        print(json.dumps(rep, ensure_ascii=False, indent=1)); return
    print(f"# Проверка речи: {n} слов ≈ {rep['duration_sec_at_wpm']} с при {a.wpm:g} сл/мин")
    if lens: print(f"предложений {len(lens)}: медиана {rep['sent_median']} слов, ≤5 слов {rep['sent_le5_share']}%, ≥20 слов {rep['sent_ge20_share']}%, макс {rep['sent_max']}; начала с и/а/ну/вот/да {rep['starters_share']}%; вопросов {rep.get('questions_per100')}/100")
    print(f"заполнители {rep['fillers_per100']}/100, маркеры {rep['markers_per100']}/100; ты {ty} / вы {vy}; «я» {rep['ya_per100']}/100; хук: {rep.get('hook_type_guess','—')} ({rep.get('hook_words','—')} слов)")
    print("\n## Исправить (красное)"); print("\n".join(f"- {x}" for x in issues) or "- нет")
    print("\n## Посмотреть (жёлтое)"); print("\n".join(f"- {x}" for x in warns) or "- нет")
    print("\n## В норме"); print("\n".join(f"- {x}" for x in oks) or "- —")
    print(f"\nВердикт: {'ГОТОВО' if not issues else f'{len(issues)} красных — переписать'}")

if __name__ == "__main__":
    main()
