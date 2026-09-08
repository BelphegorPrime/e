import { type McpServerFiles } from "./index.js";

/**
 * Container MCP server: searxng web search and fetch tools.
 * Provides web_search and fetch_content tools for agents that support MCP.
 *
 * The searxng service (`service:egress` in the stack compose) shares the global
 * egress network namespace, so when the run also shares that namespace
 * (`localStackPresent`) the server reaches search at `localhost:8080`. The
 * server keeps an explicit node script; supergateway bridges its stdio to
 * streamable HTTP on port 3000 at `/mcp`, matching the shipped `filesystem`
 * example's shape.
 */
export function renderSearxngFiles(): McpServerFiles {
  return {
    Dockerfile:
      [
        `# Container MCP server: searxng web search and fetch tools.`,
        `FROM node:lts-alpine`,
        `RUN npm install -g @modelcontextprotocol/sdk supergateway`,
        `# The server script: web_search + fetch_content over the local Searxng.`,
        `WORKDIR /app`,
        `RUN cat > /app/mcp-server.mjs <<'SEARXNG_EOF'`,
        `import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";`,
        `import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";`,
        ``,
        `const server = new McpServer({ name: "searxng-search", version: "1.0.0" });`,
        `const SEARXNG = process.env.SEARXNG_URL ?? "http://localhost:8080";`,
        ``,
        `// Web search tool`,
        `server.tool(`,
        `  "web_search",`,
        `  {`,
        `    query: { type: "string", description: "Search query string" },`,
        `  },`,
        `  async ({ query }) => {`,
        `    try {`,
        `      const url = \`${"${SEARXNG}"}/search?format=json&q=${"${encodeURIComponent(query)}"}\`;`,
        `      const response = await fetch(url);`,
        `      if (!response.ok) {`,
        `        return { content: [{ type: "text", text: "Searxng error: " + response.status }], isError: true };`,
        `      }`,
        `      const data = await response.json();`,
        `      const results = (data.results ?? []).slice(0, 10).map(r => ({`,
        `        title: r.title ?? "(untitled)",`,
        `        url: r.url ?? "",`,
        `        snippet: (r.content ?? "").slice(0, 200),`,
        `      }));`,
        `      return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };`,
        `    } catch (error) {`,
        `      return { content: [{ type: "text", text: "Search error: " + error.message }], isError: true };`,
        `    }`,
        `  }`,
        `);`,
        ``,
        `// Fetch content tool`,
        `server.tool(`,
        `  "fetch_content",`,
        `  {`,
        `    url: { type: "string", description: "URL to fetch" },`,
        `  },`,
        `  async ({ url }) => {`,
        `    try {`,
        `      const urlObj = new URL(url);`,
        `      // Basic SSRF protection: block loopback and RFC-1918 private ranges.`,
        `      const parts = urlObj.hostname.split(".");`,
        `      const isPrivate = (`,
        `        urlObj.hostname === "localhost" ||`,
        `        urlObj.hostname === "127.0.0.1" ||`,
        `        urlObj.hostname.startsWith("192.168.") ||`,
        `        urlObj.hostname.startsWith("10.") ||`,
        `        (parts[0] === "172" && parts.length >= 2 && Number(parts[1]) >= 16 && Number(parts[1]) <= 31)`,
        `      );`,
        `      if (isPrivate) {`,
        `        return { content: [{ type: "text", text: "Error: Cannot fetch from local/private networks for security reasons" }], isError: true };`,
        `      }`,
        `      const response = await fetch(url);`,
        `      if (!response.ok) {`,
        `        return { content: [{ type: "text", text: "Fetch error: " + response.status + " " + response.statusText }], isError: true };`,
        `      }`,
        `      const text = await response.text();`,
        `      return { content: [{ type: "text", text: text.slice(0, 32768) }] };`,
        `    } catch (error) {`,
        `      return { content: [{ type: "text", text: "Fetch error: " + error.message }], isError: true };`,
        `    }`,
        `  }`,
        `);`,
        ``,
        `const transport = new StdioServerTransport();`,
        `await server.connect(transport);`,
        `console.error("Searxng MCP server running on stdio");`,
        `SEARXNG_EOF`,
        `EXPOSE 3000`,
        `# Serves streamable HTTP on PORT 3000 at /mcp.`,
        `CMD ["supergateway", "--stdio", "node /app/mcp-server.mjs", "--outputTransport", "streamableHttp", "--port", "3000"]`,
      ].join('\n') + '\n',
    'mcp.json': JSON.stringify(
      {
        transport: 'container',
        port: 3000,
      },
      null,
      2
    ) + '\n',
  };
}