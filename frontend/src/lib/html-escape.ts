// htmlEscape escapes the five HTML-significant ASCII characters so a
// DB-sourced string is safe to inject into Plotly's hovertext (which
// renders HTML by default).
//
// Mirrors `html.escape(s, quote=True)` from CPython's stdlib, used by the
// Shiny app's hover-text builder at
// reference/tfbpshiny/modules/binding/server/workspace.py:294-306.
// Every condition label / display name / gene symbol injected into the
// selected-regulator overlay hovertext MUST pass through this function.
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
