# onepipeline-ui

The DAG Observatory: the browser view of [onepipeline](https://crates.io/crates/onepipeline)
runs. This package carries the **built frontend** — a static bundle under `dist/` —
and no binary. The read API it talks to ships separately as
[`onepipeline-api-cli`](https://www.npmjs.com/package/onepipeline-api-cli).

```sh
npm install onepipeline-ui
```

The read API of the same release already carries this bundle: `onepipeline-api serve
--runs-root ./runs --ui` serves it at `/` beside the API, with nothing to install
beyond the command. This package is the bundle on its own, for serving it from
somewhere else — any static file server with the read API behind the same origin at
`/api` and `/healthz`, or the API itself pointed at it:

```sh
npx onepipeline-api-cli serve --runs-root ./runs   # the API, on 127.0.0.1:8765
npx serve node_modules/onepipeline-ui/dist          # the view, from a static server
npx onepipeline-api-cli serve --runs-root ./runs --ui --ui-dist node_modules/onepipeline-ui/dist
```

The app declares no schema, event name, or API path of its own: every payload it reads
is validated against the contract in
[`docs/contract.md`](https://github.com/nickderobertis/onepipeline-ui/blob/main/docs/contract.md).
