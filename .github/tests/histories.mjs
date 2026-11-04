export const prEvent = (
  branch = "feature",
  fork = false,
  author = "nickderobertis",
) => ({
  event_name: "pull_request",
  repository: { full_name: "nickderobertis/onepipeline-ui" },
  pull_request: {
    user: { login: author },
    title: "chore: release",
    head: {
      ref: branch,
      repo: {
        full_name: fork
          ? "fork/onepipeline-ui"
          : "nickderobertis/onepipeline-ui",
      },
    },
  },
});
