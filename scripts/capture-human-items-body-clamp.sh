#!/usr/bin/env bash
# Illustrative screenshots only; no behavioral assertions or product server.
# Reuses the dense spike's Playwright Chromium and setContent approach.
# With workspace dependencies installed, no module override is needed.
set -euo pipefail
cd "$(dirname "$0")/.."
: "${ONEPIPELINE_NODE_SCRATCH_DIR:?Set an existing capture scratch directory}"
export BODY_CLAMP_OUT="${BODY_CLAMP_OUT:-$ONEPIPELINE_NODE_SCRATCH_DIR/body-clamp}"
mkdir -p "$BODY_CLAMP_OUT"
export BODY_CLAMP_BASE=3d8f95b363dc086ff3a5a6ba44c12f9fc69cfbd3
# BEFORE_ONLY / AFTER_ONLY allow initial production without recapturing a side.
node --input-type=module <<'JS'
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || './apps/dag-ui-e2e/node_modules/@playwright/test/index.mjs');
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
const fixture = 'apps/dag-ui-e2e/fixtures/human-items-dense/mock.html';
const baseline = execFileSync('git', ['show', `${process.env.BODY_CLAMP_BASE}:${fixture}`], { encoding: 'utf8' });
const out = process.env.BODY_CLAMP_OUT;
mkdirSync(out, {recursive:true});
const browser = await chromium.launch({headless:true, args:['--disable-gpu','--force-color-profile=srgb','--font-render-hinting=none','--disable-lcd-text','--hide-scrollbars']});
try {
  const page = await browser.newPage({viewport:{width:1440,height:900},deviceScaleFactor:2});
  // Same public synthetic workload on both sides; original short examples stay intact.
  const body = 'Read the recovery checklist from beginning to end before publishing the access guide. ' + Array.from({length:12}, (_,i)=>`Checkpoint ${i+1}: describe how a reader can replace a lost security key using a spare key, confirm the public support route, record the recovery steps in plain language, and return to the guide without losing their place. `).join('') + 'Final instruction: save the recovery guide and share the public checklist.';
  for (const side of process.env.BEFORE_ONLY ? ['before'] : process.env.AFTER_ONLY ? ['after'] : ['before','after']) {
    await page.goto('about:blank');
    await page.setContent(side==='before' ? baseline : readFileSync(fixture,'utf8'));
    await page.evaluate(body=>{ window.mock.items.find(i=>i.id==='T2').body=body; window.mock.select(null); }, body);
    if (!process.env.DETAILS_ONLY) await page.screenshot({path:join(out,`${side}-body-clamp-list.png`),animations:'disabled'});
    await page.evaluate(()=>window.mock.select('T2'));
    await page.screenshot({path:join(out,`${side}-body-clamp-detail-start.png`),animations:'disabled'});
    if(side==='after') await page.locator('.detail-body').evaluate(e=>{e.scrollTop=e.scrollHeight});
    else await page.locator('#detail > p').nth(1).evaluate(e=>{window.scrollTo(0,e.offsetTop+e.offsetHeight-550)});
    await page.screenshot({path:join(out,`${side}-body-clamp-detail-end.png`),animations:'disabled'});
  }
} finally { await browser.close(); }
JS
