import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { BoundedStdioTransport } from "./mcp-transport.ts";
import { z } from "zod";
import { InstanceClient } from "./client.ts";
import { failure } from "./errors.ts";

export async function startMcp(name: string) {
  const client = new InstanceClient(name);
  const server = new McpServer({ name: "statewell", version: "0.0.0" });
  const call = async (operation: string, input = {}) => {
    try { return { content: [{ type: "text" as const, text: JSON.stringify(await client.request(operation, input)) }] }; }
    catch (error) { return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(failure(error)) }] }; }
  };
  server.registerTool("instance_inspect", { description: "Read the selected instance identity.", inputSchema: {} }, () => call("instance.inspect"));
  const inputSchema = { root: z.string().optional().describe("The exact absolute project root."), projectId: z.string().optional().describe("The expected project identifier.") };
  server.registerTool("project_resolve", { description: "Find the nearest Git root without creating a marker. Select that root before registration.", inputSchema }, input => call("project.resolve", input));
  server.registerTool("project_inspect", { description: "Read a project from the selected instance.", inputSchema }, input => call("project.inspect", input));
  server.registerTool("project_register", { description: "Register the exact selected root. Create a project marker if absent.", inputSchema }, input => call("project.register", input));
  await server.connect(new BoundedStdioTransport());
}
