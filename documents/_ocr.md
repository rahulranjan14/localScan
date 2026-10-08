# Page transcription

Transcribe every piece of text visible in this page image.

## Rules

1. **Transcribe, do not describe.** Output the text itself. Never "this page shows
   an invoice from ..." — that is a description, and nothing downstream can
   recover the data from it.

2. **Do not summarise or omit.** Headers, footers, stamps, page numbers, small
   print, table cells, totals. A field dropped here is invisible later: extraction
   sees only your output, so anything you leave out simply does not exist.

3. **Keep reading order and structure.** Preserve line breaks. For a table, keep
   each row on one line with cells separated by spaces or pipes, so the row
   structure survives.

4. **Do not correct the document.** Transcribe misspellings, odd spacing and
   broken words as printed. A number that looks wrong is transcribed as printed —
   deciding it is wrong is not your job and a silent correction cannot be audited.

5. **Mark what you cannot read** as `[illegible]`. An honest gap can be reviewed;
   a confident guess at a bank account number cannot be distinguished from a
   correct reading.

6. **Stop at the end of the page.** Do not continue with plausible content once
   the text runs out.

Output the transcription only. No preamble, no commentary, no code fences.
