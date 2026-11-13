/**
 * The `invest` commands: Smart Growth portfolios, through the Tempora API. Every fact about a portfolio (its status,
 * chain, deposit token, minimums and the forms a withdrawal may take) is read from the API when the command runs;
 * nothing about a portfolio is kept here.
 *
 *   invest_products   the portfolios the API offers, with their minimums and steps
 *
 * Nothing here signs. Owner calls sign in through the connect page (`api.ts`), and every step the owner's wallet is
 * asked to sign or send is checked first by the client's own checks.
 */
import { z } from "zod";
import type { Command } from "../earn/commands.js";
import { redactEndpoints } from "../redact.js";
import { apiClient, apiUrl, failure } from "./api.js";

/** One JSON document, the way every treasury command answers. */
const text = (v: unknown) => JSON.stringify(v, null, 2);

const guarded =
  <A extends unknown[]>(fn: (...a: A) => Promise<string>) =>
  async (...a: A): Promise<string> => {
    try {
      return await fn(...a);
    } catch (e) {
      throw new Error(redactEndpoints(e instanceof Error ? e.message : String(e)));
    }
  };

export function buildInvestCommands(deps: { client?: ReturnType<typeof apiClient> } = {}): Record<string, Command> {
  const commands: Record<string, Command> = {};
  const register = <S extends z.ZodRawShape>(
    name: string,
    meta: { title: string; description: string; inputSchema: S },
    handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>,
  ): void => {
    commands[name] = { ...meta, inputSchema: z.object(meta.inputSchema), handler: handler as Command["handler"] };
  };
  const client = () => deps.client ?? apiClient();

  register(
    "invest_products",
    {
      title: "List Smart Growth portfolios",
      description:
        "The Smart Growth portfolios the Tempora API offers, read from the API now: each one's `id` (the value every other invest command takes as `product`), name, status, chain and deposit token, its minimums (`minimum.firstDepositUsd` for a first deposit, `minimum.topUpUsd` for a later one), the forms a deposit and a withdrawal may take (`amountForms`), and the steps the owner's wallet will be asked for (`steps`). A portfolio whose status is not `live` may refuse a deposit: say so to the operator. No sign-in is needed.",
      inputSchema: {},
    },
    guarded(async () => {
      const r = await client().products({});
      if (!r.ok) throw failure("The product list could not be read", r);
      const portfolios = r.body.products.filter((p) => p.kind === "portfolio");
      return text({
        api: apiUrl(),
        portfolios: portfolios.map((p) => ({
          id: p.id,
          name: p.name,
          status: p.status,
          chains: p.chains,
          tokens: p.tokens,
          minimum: p.minimum,
          amountForms: p.amountForms,
          steps: p.steps,
        })),
      });
    }),
  );

  return commands;
}
