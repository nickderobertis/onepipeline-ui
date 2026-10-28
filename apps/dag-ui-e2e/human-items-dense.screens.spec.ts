import { test } from '@playwright/test';
import { readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';

// Independent throwaway fixture. No product routes or API mutations are added.
test('dense human items visual proposal', async ({ page }) => {
  const out = resolve(process.env.SHOTS_OUT!);
  mkdirSync(out, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  const shot = async (name: string) => { await page.screenshot({ path: join(out, `${name}.png`), animations: 'disabled' }); };
  await page.goto('/human-items');
  await page.waitForTimeout(2500);
  await shot('before-action-items');
  await page.goto('/'); await page.waitForTimeout(1500); await shot('before-host');
  await page.goto('/human-items');
  const html = readFileSync(join(import.meta.dirname, 'fixtures/human-items-dense/mock.html'), 'utf8');
  const reset = async () => { await page.goto('/human-items'); await page.setContent(html); };
  await reset(); await shot('after-full-width');
  await page.getByRole('button', { name: 'Open Q1', exact: true }).click(); await shot('after-detail');
  await reset();
  await page.getByRole('textbox', { name: 'Answer Q1', exact: true }).fill('Preview channel first.');
  await page.keyboard.press('Tab'); await shot('after-keyboard');
  await page.getByRole('textbox', { name: 'Answer Q2', exact: true }).fill('Eight hours.');
  await page.keyboard.press('Shift+Enter'); await page.keyboard.type('Renew when needed.'); await shot('after-newline');
  await page.getByRole('textbox', { name: 'Answer Q1', exact: true }).press('Enter'); await shot('after-answer');
  await reset(); await page.getByRole('button', { name: 'Open T2', exact: true }).click(); await shot('before-dismiss');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click(); await shot('after-dismiss');
  await reset(); await page.getByRole('button', { name: 'Open T1', exact: true }).click(); await shot('before-design');
  await page.getByRole('button', { name: 'Complete', exact: true }).click(); await shot('after-design');
  await reset(); await page.getByRole('button', { name: 'Open T1', exact: true }).click();
  await page.evaluate('window.mock.stale()'); await shot('before-stale');
  await page.getByRole('button', { name: 'Complete', exact: true }).click(); await shot('after-stale');
  for (const [filter, value] of [['kind','Task'],['kind','Question'],['blocking','Yes'],['blocking','No'],['priority','High'],['state','Dismissed'],['source','Plan / run'],['source','Manager session'],['source','Host']]) {
    await reset(); await page.getByLabel(filter, {exact:true}).selectOption(value); await shot(`after-filter-${filter}-${value.replaceAll(' ','-').replaceAll('/','-')}`);
  }
  await reset(); await page.getByRole('button', { name: 'Open T3', exact: true }).click(); await shot('after-host-detail');
  await page.goto('/'); await page.waitForTimeout(1500); await shot('after-host');
  await reset();
  const items = await page.evaluate('window.mock.items') as Array<{id:string;kind:string;priority:string;title:string;body:string;source:string;blocks:string;state:string;link?:string}>;
  const terminal = async (title: string, text: string) => { await page.setContent('<body style="margin:0;background:#0b1018;color:#dfe6ef;font:14px system-ui;padding:28px"><h1></h1><pre style="font:12px/1.4 monospace;white-space:pre-wrap"></pre></body>'); await page.locator('h1').evaluate((e,t)=>e.textContent=t,title); await page.locator('pre').evaluate((e,t)=>e.textContent=t,text); };
  const bin = resolve(import.meta.dirname, '../../target/debug/onepipeline-api');
  const existing = execFileSync(bin, ['--help'], {encoding:'utf8'});
  for (const mode of ['list','report']) {
    await terminal('Existing CLI · unchanged output', existing); await shot(`before-cli-${mode}`);
    const text = `ILLUSTRATIVE MOCK TEXT — not executed engine output\n$ onepipeline human-items ${mode}\nFilters: --kind --blocking yes|no --priority --state --source\n\n` + items.map(i=>`${i.id}  ${i.kind}  ${i.priority}  ${i.state}  ${i.title}\n  ${i.body}\n  Source: ${i.source} · ${i.blocks}${i.link?'\n  '+i.link:''}${i.state==='Dismissed'?'\n  Reason: the run ended':''}`).join('\n\n');
    await terminal(`Proposed CLI ${mode} · illustrative mock`,text); await shot(`after-cli-${mode}`);
  }
});
