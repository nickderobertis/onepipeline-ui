#!/usr/bin/env node
import { check } from "@onebudgetspec/sdk";

const result = await check({
  paths: [".github/budgets.yaml"],
  cwd: process.cwd(),
});
for (const budget of result.results) {
  console.log(`${budget.id}: ${budget.verdict} (${budget.actual})`);
  if (budget.error) console.error(budget.error);
}
if (result.results.some((budget) => budget.verdict !== "within"))
  process.exit(1);
