/**
 * Names the screenshot tier's fixture directory before `playwright.config.ts` is
 * evaluated, which is when it makes one — so this module is imported ahead of it.
 * `makeWorkspace` there says why the capture wants a fixed name.
 */
process.env.DAG_UI_E2E_FIXTURE_NAME = "gallery";
