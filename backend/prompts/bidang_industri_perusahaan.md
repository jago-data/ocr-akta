# Extraction rule — `bidang_industri_perusahaan`

**This app does not run prompts.** Extraction is delegated to the internal OCR API
(`backend/ocr_client.py` posts the PDF and stores what comes back), so nothing here is
executed by this backend. This file is the *specification* for whoever operates that API:
the rule the model must follow for this one field, with the reasoning and the test cases.
Keep it in step with the API's own prompt — when the two disagree, this file is what the
reviewers in the Akta app were told to expect.

Source: **Pasal 3** — *Maksud dan Tujuan serta Kegiatan Usaha*.

---

## The rule

Pasal 3 normally has two ayat:

- **ayat (1)** — the general purpose. Broad sectors, no codes: `PERDAGANGAN`, `JASA`,
  `PEMBANGUNAN`.
- **ayat (2)** — the detailed activities. This is where KBLI codes appear.

Which ayat to take is decided by whether **any** KBLI code is present in Pasal 3:

1. **At least one point carries a KBLI code → take ayat (2), and only ayat (2).**
   Output every coded activity, one array element per point. Do not summarise, do not
   merge two points into one string, do not drop a point because it looks similar to
   another.

   Canonical form is `KODE-DESKRIPSI` — the code, a single hyphen, no spaces around it,
   description in UPPERCASE. Normalise whatever layout the deed uses:

   | in the deed | output |
   |---|---|
   | `70209 - AKTIVITAS KONSULTASI MANAJEMEN LAINNYA` | `70209-AKTIVITAS KONSULTASI MANAJEMEN LAINNYA` |
   | `PERDAGANGAN BESAR (78828)` | `78828-PERDAGANGAN BESAR` |
   | `PENYEWAAN ALAT KONSTRUKSI DENGAN OPERATOR (KBLI 43905)` | `43905-PENYEWAAN ALAT KONSTRUKSI DENGAN OPERATOR` |

   Drop the literal token `KBLI`. A code is numeric, usually 5 digits.

   A point in ayat (2) that has **no** code still belongs in the output — as its plain
   uppercase description, no hyphen. The trigger for using ayat (2) is that *some* point
   has a code, not that *every* point does; silently discarding the uncoded ones would
   lose real business activities.

2. **No point anywhere in Pasal 3 carries a KBLI code → take ayat (1), and only ayat (1).**
   Plain uppercase strings, one array element per point, e.g.
   `["PERDAGANGAN", "JASA"]`. Skip ayat (2) entirely in this case — without codes it
   restates ayat (1) at greater length and produces duplicates.

3. **Pasal 3 cannot be located, or has no business purpose → `[]`.**
   An empty array, never `[""]` and never a guess from the company name.

## Point per point

The output is a list of the deed's points, not a description of them. One point in the
deed is exactly one element in the array.

- Never join points with commas, `dan`, or `/` into a single string.
- Never split one point into several because it contains a comma.
- Keep the deed's order.
- Keep duplicates out: the same code twice is one element.
- A point spanning two lines is still one point — join the lines with a single space.

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

**One clause is unverified.** In every coded deed in the gold set, *all* points carry a
code — 4/4, 5/5, 14/14, 2/2. So "a point in ayat (2) with no code is still returned" has
no example behind it; it follows from the rule being triggered by *at least one* code
rather than by all of them. If a genuinely mixed Pasal 3 turns up, add it to the gold set,
because that is the case where two reasonable readings differ.

Two failures to watch for, both seen in practice:

- **A coded deed answered with ayat (1).** Symptom: 2–4 broad sectors where the deed lists
  a dozen coded activities. The reviewer sees `PERDAGANGAN` for a company whose Pasal 3
  names 14 KBLI codes.
- **An uncoded deed answered with both ayat.** Symptom: `["PERDAGANGAN", "PERDAGANGAN
  BESAR DAN ECERAN", ...]` — ayat (2) paraphrasing ayat (1), producing near-duplicates.

## Prompt text

Ready to paste into the API's extraction prompt as the section for this field.

```text
bidang_industri_perusahaan — from Pasal 3 (Maksud dan Tujuan serta Kegiatan Usaha).

Decide which ayat to use by scanning ALL of Pasal 3 for KBLI codes (numeric, usually 5
digits; the word "KBLI" may or may not appear):

- If AT LEAST ONE point carries a KBLI code, extract from ayat (2) only. Return every
  point of ayat (2) as its own array element. Coded points use the exact form
  "KODE-DESKRIPSI": code, one hyphen, no spaces, description in UPPERCASE, the token
  "KBLI" removed. A point in ayat (2) with no code is still returned, as its plain
  uppercase description.
- If NO point in Pasal 3 carries a KBLI code, extract from ayat (1) only, as plain
  uppercase strings, one array element per point. Ignore ayat (2).
- If Pasal 3 or the business purpose cannot be found, return [].

One point in the deed is exactly one element. Do not merge points, do not split a point on
its commas, keep the deed's order, and remove exact duplicates. Return a JSON array of
strings and nothing else.
```
