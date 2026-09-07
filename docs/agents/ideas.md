# Tooling ideas

## Web search capability

We currently have no built-in web search tool. The agent can fetch pages
directly with `wget` and query DuckDuckGo's plain-HTML endpoint
(`html.duckduckgo.com/html/?q=...`) as a workaround, but that is ad hoc and
fragile (UA sniffing, bot blocks, no JS rendering).

Idea: package this as a first-class capability — an extension/custom tool, a
sidecar, or a skill — so any agent session gets:

- A `search` tool wrapping one or more engines (DuckDuckGo HTML plus a
  fallback), returning ranked result titles + URLs.
- A `fetch` tool that retrieves a URL as text, with a headless-browser option
  for JS-rendered pages.
- Caching of results per query to avoid repeat network work.
- Explicit limits (timeout, size cap, deny localhost/private IPs) so a
  prompt-injected URL cannot be turned into an SSRF vector.