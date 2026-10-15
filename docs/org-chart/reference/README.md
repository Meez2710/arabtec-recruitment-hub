# Org chart reference pack (local only)

These files hold real employee names. They are git-ignored (see `.gitignore` here) and must never be committed, copied into code, seeds or tests.

| File | Use |
|---|---|
| `Aliva_OC_-_Oct.pdf` | Visual blueprint. Page 1 = project chart, page 2 = QA/QC page with a full-names panel. |
| `Aliva_OC_-_Sep.vsdx` | Source of truth for layout: A3 landscape 16.535 × 11.693 in; bands `#860915` (header Calibri Bold 18 pt white, footer); role boxes = Visio "Executive Belt" groups, title in the first sub-shape, main text = `X…` count + `- name` lines, Arial Bold 8 pt, 0.75 pt black border, width 1.125 in; joiners = red character runs with `dd/mm`; connectors = "Dynamic connector" glued Bottom→Top (`Connections.Bottom.X` → `Connections.Top.X`) with end arrows; logo = Foreign shape top-right (a low-resolution bitmap inside an EMF; use the Hub's vector `frontend/public/arabtec-logo.svg` instead); "Date: dd/mm/yyyy" text bottom-right. Import test target. |
| `Aliva_people_from_HR_sheet.csv` | People-level export (HR master cross-checked against the chart) with notes on mismatches. CSV import test target. |
| `prototype-org-chart-builder.html` | Working prototype from the claude.ai session: line editing engine (segment handles, end-dot reconnect, styles), PDF/Visio/SVG export code, CSV import, role-box export layout. Reuse logic, not its visual shell. |
