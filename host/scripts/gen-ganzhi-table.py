#!/usr/bin/env python3
"""Generates firmware/main/ganzhi_table.inc -- the boundary table the local-
clock screen uses to compute year/month ganzhi (stem-branch) pillars while
offline. See docs/local-clock-mode.md for the southern-hemisphere adjustment
rule and how it was derived/verified against a user-confirmed reference date.

Requires the `skyfield` package (pip install skyfield) -- it downloads the
JPL DE421 ephemeris (~17MB, cached after first run) to compute exact solar
longitude crossings. This is a one-off/rarely-run generator (the table only
needs regenerating to extend the covered date range further into the
future), not part of the normal npm-based build -- that's why it's Python
rather than joining the rest of this project's Node tooling.

Regenerate: pip install skyfield && python3 host/scripts/gen-ganzhi-table.py
"""
import json
from datetime import date, datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo

from skyfield import api
from skyfield.searchlib import find_discrete

HERE = Path(__file__).resolve().parent
OUT_PATH = HERE / ".." / ".." / "firmware" / "main" / "ganzhi_table.inc"

# Device's local timezone -- matches host/config.json's configured location
# (Auckland, NZ). The table encodes calendar-day boundaries in THIS zone
# because that's what the device's synced clock (T_TIME) displays.
TZ = ZoneInfo("Pacific/Auckland")
EPOCH = date(1970, 1, 1)  # matches T_TIME's date field representation

# Range to cover. Extend both ends and re-run when this runs low -- the
# device falls back to "no ganzhi data" gracefully outside the table range
# (see firmware's ganzhi lookup), it does not crash or show garbage.
RANGE_START = date(2026, 6, 1)
RANGE_END = date(2031, 9, 1)

STEMS_ZH = ["甲", "乙", "丙", "丁", "戊", "己", "庚", "辛", "壬", "癸"]
BRANCHES_ZH = ["子", "丑", "寅", "卯", "辰", "巳", "午", "未", "申", "酉", "戌", "亥"]

# 24 solar terms, index i = i*15deg ecliptic longitude, starting at chunfen (0deg).
TERM_NAMES = [
    "chunfen", "qingming", "guyu", "lixia", "xiaoman", "mangzhong",
    "xiazhi", "xiaoshu", "dashu", "liqiu", "chushu", "bailu",
    "qiufen", "hanlu", "shuangjiang", "lidong", "xiaoxue", "daxue",
    "dongzhi", "xiaohan", "dahan", "lichun", "yushui", "jingzhe",
]
# The 12 "jie" (month-boundary terms, as opposed to "qi" midpoint terms) in
# year-sequence order starting from lichun -- this order also gives each
# term's position (0-11) in the 12-month wu-hu-dun sequence.
SEQUENCE_IDX = [21, 23, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19]

# wu-hu-dun (五虎遁): year stem -> that year's yin-month (1st month) stem.
WUHU_DUN = {0: 2, 5: 2, 1: 4, 6: 4, 2: 6, 7: 6, 3: 8, 8: 8, 4: 0, 9: 0}

# ---- User-confirmed calibration anchor (see docs/local-clock-mode.md) ----
# 2026-07-27 17:26 Auckland local = bing-wu year * yi-chou month (southern-
# adjusted) * ren-yin day * ji-you hour. This fixes every offset below.
ANCHOR_YEAR_STEM, ANCHOR_YEAR_BRANCH = 2, 6  # bing=2, wu=6 -- the lichun-2026 window


def find_jie_terms(year_start, year_end):
    ts = api.load.timescale()
    eph = api.load("de421.bsp")
    sun, earth = eph["sun"], eph["earth"]

    def solar_longitude_deg(t):
        astrometric = earth.at(t).observe(sun).apparent()
        _, lon, _ = astrometric.ecliptic_latlon()
        return lon.degrees

    def crossing_check(target_deg):
        def f(t):
            lon = solar_longitude_deg(t)
            return ((lon - target_deg + 180) % 360) - 180 > 0
        f.step_days = 1.0
        return f

    t0, t1 = ts.utc(year_start, 1, 1), ts.utc(year_end, 1, 1)
    results = []
    for i, name in enumerate(TERM_NAMES):
        if i not in SEQUENCE_IDX:
            continue
        times, values = find_discrete(t0, t1, crossing_check(i * 15.0))
        for t, v in zip(times, values):
            if v:
                local_dt = t.utc_datetime().astimezone(TZ)
                results.append({"idx": i, "name": name, "local_date": local_dt.date()})
    results.sort(key=lambda x: x["local_date"])
    return results


def build_table():
    jie_terms = find_jie_terms(2025, RANGE_END.year + 2)
    lichun_terms = [t for t in jie_terms if t["idx"] == 21]
    ref_yi = next(i for i, t in enumerate(lichun_terms)
                  if t["local_date"].year == 2026 and t["local_date"].month == 2)

    def year_stem_branch(yi):
        offset = yi - ref_yi
        return (ANCHOR_YEAR_STEM + offset) % 10, (ANCHOR_YEAR_BRANCH + offset) % 12

    entries = []
    for t in jie_terms:
        candidates = [i for i, lt in enumerate(lichun_terms) if lt["local_date"] <= t["local_date"]]
        if not candidates:
            continue  # before our data's first lichun -- no year context, and outside RANGE anyway
        yi = max(candidates)
        pos = SEQUENCE_IDX.index(t["idx"])
        y_stem, y_branch = year_stem_branch(yi)
        yin_stem = WUHU_DUN[y_stem]
        m_stem = (yin_stem + pos) % 10
        m_branch_std = (2 + pos) % 12
        m_branch_southern = (m_branch_std + 6) % 12  # southern-hemisphere flip; stem unchanged
        if not (RANGE_START <= t["local_date"] <= RANGE_END):
            continue
        entries.append({
            "date": t["local_date"], "epoch_day": (t["local_date"] - EPOCH).days,
            "term": t["name"], "year_stem": y_stem, "year_branch": y_branch,
            "month_stem": m_stem, "month_branch": m_branch_southern,
        })
    entries.sort(key=lambda e: e["epoch_day"])
    return entries


def verify(entries):
    """Reproduce the calibration anchor purely from the generated table (not
    the live computation above) -- this is what actually ships to firmware,
    so it's what must be proven correct."""
    target_day = (date(2026, 7, 27) - EPOCH).days
    active = None
    for e in entries:
        if e["epoch_day"] <= target_day:
            active = e
    year = f"{STEMS_ZH[active['year_stem']]}{BRANCHES_ZH[active['year_branch']]}"
    month = f"{STEMS_ZH[active['month_stem']]}{BRANCHES_ZH[active['month_branch']]}"
    assert year == "丙午", f"year pillar mismatch: got {year}, want 丙午"
    assert month == "乙丑", f"month pillar mismatch: got {month}, want 乙丑"
    print(f"verified: table reproduces anchor (active boundary {active['date']}, year={year}, month={month})")


def generate_inc(entries):
    lines = [
        "// AUTO-GENERATED by host/scripts/gen-ganzhi-table.py. Do not edit by hand.",
        "// Regenerate: pip install skyfield && python3 host/scripts/gen-ganzhi-table.py",
        "// One entry per solar-term month boundary (jie), southern-hemisphere-adjusted:",
        "// year stem/branch standard (li-chun anchored); month stem standard (wu-hu-dun),",
        "// month branch flipped +6 to its seasonal-opposite pair. See",
        "// docs/local-clock-mode.md for the derivation and verification against a",
        "// user-confirmed reference date.",
        "// epoch_day = days since 1970-01-01 (same representation as T_TIME's date field).",
        "// Covers " + entries[0]["date"].isoformat() + " to " + entries[-1]["date"].isoformat() +
        " -- extend RANGE_END in gen-ganzhi-table.py and re-run once this runs low.",
        "struct GanzhiBoundary { uint16_t epoch_day; uint8_t year_sb; uint8_t month_sb; };",
        f"static const GanzhiBoundary GANZHI_TABLE[{len(entries)}] = {{",
    ]
    for e in entries:
        ysb = (e["year_stem"] << 4) | e["year_branch"]
        msb = (e["month_stem"] << 4) | e["month_branch"]
        lines.append(f"    {{ {e['epoch_day']}, {ysb}, {msb} }},  // {e['date'].isoformat()} {e['term']}")
    lines.append("};")
    return "\n".join(lines) + "\n"


if __name__ == "__main__":
    entries = build_table()
    verify(entries)
    OUT_PATH.write_text(generate_inc(entries), encoding="utf-8")
    print(f"wrote {OUT_PATH} ({len(entries)} entries)")
