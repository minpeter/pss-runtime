import { z } from "zod";

const catalog = [
  { sku: "kbd-basic", name: "Basic keyboard", priceCents: 4000 },
  { sku: "kbd-pro", name: "Pro keyboard", priceCents: 9000 },
  { sku: "mouse-basic", name: "Basic mouse", priceCents: 2000 },
] as const;

const queryInput = z.object({ query: z.string().min(1).max(100) }).strict();
const quoteInput = z
  .object({
    sku: z.string().min(1).max(64),
    quantity: z.number().int().min(1).max(100),
  })
  .strict();
const noteKey = z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const saveInput = z.object({ key: noteKey, value: z.json() }).strict();
const getInput = z.object({ key: noteKey }).strict();

export const toolDefinitions = [
  { name: "catalog.search", input: z.toJSONSchema(queryInput) },
  { name: "pricing.quote", input: z.toJSONSchema(quoteInput) },
  { name: "notes.save", input: z.toJSONSchema(saveInput) },
  { name: "notes.get", input: z.toJSONSchema(getInput) },
] as const;

export class ToolError extends Error {
  override readonly name = "ToolError";
}

export async function invokeTool(
  storage: DurableObjectStorage,
  name: string,
  args: unknown,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted();
  switch (name) {
    case "catalog.search": {
      const { query } = queryInput.parse(args);
      const products = (await storage.get<typeof catalog>("catalog")) ?? catalog;
      signal.throwIfAborted();
      await storage.put("catalog", products);
      return products.filter((product) => product.name.toLowerCase().includes(query.toLowerCase()));
    }
    case "pricing.quote": {
      const { sku, quantity } = quoteInput.parse(args);
      const products = (await storage.get<typeof catalog>("catalog")) ?? catalog;
      signal.throwIfAborted();
      const product = products.find((entry) => entry.sku === sku);
      if (!product) throw new ToolError(`Unknown SKU: ${sku}`);
      return { sku, quantity, totalCents: product.priceCents * quantity };
    }
    case "notes.save": {
      const { key, value } = saveInput.parse(args);
      await storage.put(`note:${key}`, value);
      return { key, value };
    }
    case "notes.get": {
      const { key } = getInput.parse(args);
      return (await storage.get(`note:${key}`)) ?? null;
    }
    default:
      throw new ToolError(`Unknown tool: ${name}`);
  }
}
