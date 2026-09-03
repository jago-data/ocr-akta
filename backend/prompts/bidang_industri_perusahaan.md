# Extraction rule — `bidang_industri_perusahaan`

**This app does not run prompts.** Extraction is delegated to the internal OCR API, which
converts the deed to Markdown and runs its extraction over that, so nothing here is
executed locally. This file is the *specification* for whoever operates that API: the rule
the model must follow for this one field, with the reasoning and the test cases. Keep it in
step with the API's own prompt — when the two disagree, this file is what the reviewers in
the Akta app were told to expect.

The rule below therefore describes what the model sees in the **Markdown**, not the layout
of the original scan. Where the two differ — a heading that became a list item, a point
that wrapped across lines — the Markdown is what to reason about.

Source: **Pasal 3** — *Maksud dan Tujuan serta Kegiatan Usaha*.

---

## The rule

Pasal 3 normally has two ayat: ayat (1) the general purpose, ayat (2) the detailed
activities. **Do not rely on finding those numbers.** The conversion to Markdown often
buries them in the deed's dot leaders (`---- ---- 1. Maksud dan tujuan ----`), and some
deeds do not label them at all. Decide from what the lines *contain* instead.

### Codes decide, and the longest code wins

Scan the whole of Pasal 3 for KBLI codes — numeric, `KBLI` may or may not appear beside
them, and they come in two depths:

| depth | example in the deed | what it is |
|---|---|---|
| 2 digits | `Konstruksi Bangunan Sipil (Kode KBLI 42)` | the category heading |
| 5 digits | `42206 - KONSTRUKSI SENTRAL TELEKOMUNIKASI` | the actual activity |

A deed frequently carries **both**, because ayat (1) lists the categories and ayat (2)
lists the activities inside them. The 2-digit codes are then simply the first two digits of
the 5-digit ones — `42 → 42206`, `46 → 46523`. They are the same information, coarser.

1. **5-digit codes present → return only those.** One array element per code, in the form
   `KODE-DESKRIPSI`. Drop every 2-digit category code, and drop any uncoded line: with
   activities in hand, a category or a bare sector name beside them is a heading, not an
   extra activity.

2. **Only 2-digit codes present → return those**, same `KODE-DESKRIPSI` form. This is a
   deed that stopped at the category level; the categories are the most specific answer it
   contains.

3. **No codes anywhere → return the general sectors**, as plain uppercase strings, one per
   element — `["PERDAGANGAN", "JASA"]`. These come from ayat (1); where a longer,
   uncoded elaboration also appears, prefer the short sector terms and drop anything that
   merely restates one of them at greater length.

4. **Pasal 3 not locatable → `[]`.** Never `[""]`, never a guess from the company name.

### Canonical form

`KODE-DESKRIPSI` — the code, a single hyphen, no spaces around it, description in
UPPERCASE, the literal token `KBLI` removed:

| in the deed | output |
|---|---|
| `70209 - AKTIVITAS KONSULTASI MANAJEMEN LAINNYA` | `70209-AKTIVITAS KONSULTASI MANAJEMEN LAINNYA` |
| `PERDAGANGAN BESAR (78828)` | `78828-PERDAGANGAN BESAR` |
| `PENYEWAAN ALAT KONSTRUKSI DENGAN OPERATOR (KBLI 43905)` | `43905-PENYEWAAN ALAT KONSTRUKSI DENGAN OPERATOR` |
| `Konstruksi Khusus (Kode KBLI 43)` | `43-KONSTRUKSI KHUSUS` |

## Point per point

The output is a list of the deed's points, not a description of them. One point in the
deed is exactly one element in the array.

- Never join points with commas, `dan`, or `/` into a single string.
- Never split one point into several because it contains a comma.
- Keep the deed's order.
- Keep duplicates out: the same code twice is one element.
- A point wrapped across two lines in the Markdown is still one point — join it with a
  single space.

## Test cases from the gold set

These are real akta from `eval/gold`, and are the fastest way to tell whether a change to
the API's prompt broke this field.

| deed | expected | why |
|---|---|---|
| `moratelindo` | 14 elements, every one `KODE-DESKRIPSI`, first `42206-KONSTRUKSI SENTRAL TELEKOMUNIKASI` | ayat (2) has codes → rule 1 |
| `trisula` | `["PERDAGANGAN", "JASA"]` | no codes anywhere → rule 2, ayat (1) only |
| `mkp` | 8 plain uppercase sectors, first `PEMBANGUNAN` | no codes anywhere → rule 2 |
| `wika` | `[]` | Pasal 3 not locatable in the scan → rule 3 |

Checked against all 11 gold deeds: 4 take ayat (2) with codes, 6 take ayat (1) with none,
1 returns `[]`. Every one falls cleanly into a single branch.

Every coded deed in the gold set has *all* of its points coded — 4/4, 5/5, 14/14, 2/2 —
which is the evidence for dropping uncoded points under rule 1 rather than mixing them in.

Two failures to watch for, both seen in practice:

- **A coded deed answered with ayat (1).** Symptom: 2–4 broad sectors where the deed lists
  a dozen coded activities. The reviewer sees `PERDAGANGAN` for a company whose Pasal 3
  names 14 KBLI codes.
- **An uncoded deed answered with both ayat.** Symptom: `["PERDAGANGAN", "PERDAGANGAN
  BESAR DAN ECERAN", ...]` — ayat (2) paraphrasing ayat (1), producing near-duplicates.
- **A coded deed with uncoded lines mixed in.** Symptom: a broad sector with no code
  sitting among `KODE-DESKRIPSI` entries. Codes win; the uncoded line is the heading.
- **Category codes returned instead of activity codes.** The one seen on `moratelindo`:
  8 two-digit categories from ayat (1) instead of the 14 five-digit activities from ayat
  (2). Both are real KBLI codes and both look correct in isolation — the giveaway is that
  every code is 2 digits, and that each is the prefix of a 5-digit code further down.

## Prompt text

Ready to paste into the API's extraction prompt as the section for this field.

```text
bidang_industri_perusahaan — from Pasal 3 (Maksud dan Tujuan serta Kegiatan Usaha).

Do not rely on locating "ayat (1)" or "ayat (2)" — the numbering is often lost in
conversion. Decide from the content.

Scan ALL of Pasal 3 for KBLI codes. They appear at two depths: 2-digit CATEGORY codes
(e.g. "Konstruksi Khusus (Kode KBLI 43)") and 5-digit ACTIVITY codes (e.g. "43212 -
INSTALASI KOMUNIKASI"). A deed often lists both, and the 2-digit codes are just the first
two digits of the 5-digit ones.

- If any 5-DIGIT codes are present, return ONLY those, one array element each, in the exact
  form "KODE-DESKRIPSI": code, one hyphen, no spaces, description in UPPERCASE, the token
  "KBLI" removed. Drop every 2-digit category code and every line with no code — beside
  the activities they are headings, not extra activities.
- If only 2-DIGIT codes are present, return those, in the same form.
- If NO codes appear anywhere, return the general business sectors as plain uppercase
  strings, one element per sector, preferring the short sector terms over any longer line
  that restates one of them.
- If Pasal 3 or the business purpose cannot be found, return [].

One point in the deed is exactly one element. Do not merge points, do not split a point on
its commas, keep the deed's order, and remove exact duplicates. Return a JSON array of
strings and nothing else.
```
