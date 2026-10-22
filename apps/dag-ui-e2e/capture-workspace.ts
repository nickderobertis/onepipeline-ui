/**
 * The screenshot tier's fixture directory, named before `playwright.config.ts` makes
 * it.
 *
 * Importing that config is what chooses the run's session, so the name has to be in
 * the environment before that import is evaluated — which is why this is a module of
 * its own, imported ahead of it, rather than an assignment in `screenshots.config.ts`
 * after its imports have already run. `playwright.config.ts`'s `makeWorkspace` says why
 * the capture wants a fixed name.
 */
process.env.DAG_UI_E2E_FIXTURE_NAME = "gallery";
