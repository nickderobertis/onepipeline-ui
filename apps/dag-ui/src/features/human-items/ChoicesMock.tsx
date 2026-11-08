// SPIKE (question-items-2026-11-08 spike-visual): a throwaway mock of question
// choices, drafts and the send bar on the Action items page. Activated only by
// `?mock=<stage>` on `/human-items`; without it the page is unchanged. Nothing
// here is meant to land.
import { Button } from "@oneharness/ui";
import type {
  HumanItem,
  HumanItemDetail,
  HumanItemView,
} from "@onepipeline-ui/dag-model";
import { TaskMarkdown } from "@onetaskgraph/ui";
import type { useHumanItems, WriteState } from "./useHumanItems";

export type MockStage =
  | "before"
  | "card"
  | "detail"
  | "bar"
  | "refused"
  | "answered";

// `before` is no longer drawn here: the before views are captured on the
// starting head's own source (`just spike-action-items-before-screens`).
const STAGES: readonly MockStage[] = [
  "card",
  "detail",
  "bar",
  "refused",
  "answered",
];

export function mockStage(): MockStage | undefined {
  const named = new URLSearchParams(window.location.search).get("mock");
  return STAGES.find((stage) => stage === named);
}

/** The stages that draw the new design; `before` draws today's. */
export function showsChoices(stage: MockStage | undefined): boolean {
  return stage !== undefined && stage !== "before";
}

export interface Choice {
  readonly title: string;
  readonly description: string;
}

const AT = "2026-11-08T09:00:00.000Z";

function item(
  id: string,
  kind: HumanItem["kind"],
  priority: HumanItem["priority"],
  title: string,
  body: string,
  block: HumanItem["block"],
  state: HumanItem["state"] = "open",
  resolution: HumanItem["resolution"] = null,
): HumanItemView {
  return {
    item: {
      schema_version: 1,
      id,
      dedup_key: id,
      kind,
      title,
      body,
      priority,
      owner: {
        session: "manager-question-items",
        run: "release-0-45",
        plan: "authoring:release-0-45",
      },
      block,
      approval: null,
      state,
      resolution,
      tracker: null,
      created_at: AT,
      updated_at: AT,
    },
    blocked:
      block.scope === "work" && state === "open"
        ? {
            total: 2,
            plans: [
              {
                plan: "authoring:release-0-45",
                count: 2,
                preview: [
                  { run: "release-0-45", node: block.node, title },
                  {
                    run: "release-0-45",
                    node: "publish",
                    title: "Publish the release",
                  },
                ],
              },
            ],
          }
        : { total: 0, plans: [] },
    reopen: { available: false, reason: "the item is open" },
  };
}

const work = (node: string): HumanItem["block"] => ({
  scope: "work",
  run: "release-0-45",
  node,
});

export const Q_SDK = "hi-mock-q-sdk";
export const Q_CACHE = "hi-mock-q-cache";
export const Q_WINDOWS = "hi-mock-q-windows";
export const Q_FREE = "hi-mock-q-free";
const T_TOKEN = "hi-mock-t-token";
const T_DOCS = "hi-mock-t-docs";

const TITLES: Readonly<Record<string, string>> = {
  [Q_SDK]: "Which onepipeline SDK should 0.45 link?",
  [Q_CACHE]: "Keep the Nx results cache across release PRs?",
  [Q_WINDOWS]: "What should a Windows build do when strace is missing?",
  [Q_FREE]: "What should the changelog call the Action items page?",
};

const BODIES: Readonly<Record<string, string>> = {
  [Q_SDK]:
    "0.44.2 is what the lock pins; 0.45.0 adds question choices but changes the receipt shape. Pick the engine this release ships against.",
  [Q_CACHE]:
    "Promoted entries replay test results on the release PR. Dropping them adds about six minutes to test-linux but rules out a stale replay.",
  [Q_WINDOWS]:
    "The cost journeys need strace and Windows has none. Decide whether those journeys skip, fail, or move to the Linux leg only.",
  [Q_FREE]:
    "Release notes need one name for the page that lists questions and tasks. Write the words you want a reader of the changelog to see.",
};

function liveItems(stage: MockStage): HumanItemView[] {
  const answered = stage === "answered";
  const question = (id: string, priority: HumanItem["priority"], node: string) =>
    item(
      id,
      "question",
      priority,
      TITLES[id] ?? id,
      BODIES[id] ?? "",
      work(node),
    );
  const open = [
    question(Q_SDK, "urgent", "link-sdk"),
    question(Q_CACHE, "high", "release-pr"),
    question(Q_WINDOWS, "medium", "test-windows"),
    question(Q_FREE, "low", "changelog"),
    item(
      T_TOKEN,
      "task",
      "urgent",
      "Rotate PYPI_TOKEN to an account-scoped token",
      "The project-scoped token cannot create onepipeline-api-cli. Make an account-scoped one and store it as PYPI_TOKEN in the repository secrets.",
      { scope: "host" },
    ),
    item(
      T_DOCS,
      "task",
      "low",
      "Approve the Action items docs screenshots",
      "The gallery now carries the page at five widths. Look over the phone captures and approve them, or note the cards that need another pass.",
      { scope: "nothing" },
    ),
  ];
  if (stage === "refused")
    // Two of the three answers went through, so those questions left the open list.
    return open.filter(({ item: { id } }) => id !== Q_SDK && id !== Q_FREE);
  if (!answered) return open;
  return [
    item(
      Q_SDK,
      "question",
      "urgent",
      TITLES[Q_SDK] ?? "",
      BODIES[Q_SDK] ?? "",
      work("link-sdk"),
      "answered",
      {
        actor: "operator",
        on_behalf_of: null,
        text: "Take 0.45.0 — the receipt change is ours to absorb in this release.",
        reason: null,
      },
    ),
    item(
      Q_FREE,
      "question",
      "low",
      TITLES[Q_FREE] ?? "",
      BODIES[Q_FREE] ?? "",
      work("changelog"),
      "answered",
      {
        actor: "operator",
        on_behalf_of: null,
        text: "Action items — questions and tasks waiting on you",
        reason: null,
      },
    ),
  ];
}

export const CHOICES: Readonly<Record<string, readonly Choice[]>> = {
  [Q_SDK]: [
    {
      title: "Stay on 0.44.2",
      description:
        "Ship against the engine the lock pins today. **No receipt change**, and question choices wait for the next release.",
    },
    {
      title: "Move to 0.45.0",
      description:
        "Take question choices now. The receipt's `item` field moves under `view`, so `useHumanItems` and the contract tests change in this release.\n\n- announces a break of this crate's surface\n- `tests/fixtures/healthz.json` moves with it",
    },
    {
      title: "Hold the release",
      description:
        "Ship nothing until 0.45.1 settles the receipt shape upstream. The release PR stays open and keeps batching merges.",
    },
  ],
  [Q_CACHE]: [
    {
      title: "Keep promoting",
      description:
        "Release PRs replay results promoted from same-repository PRs, as today.",
    },
    {
      title: "Drop it on release PRs",
      description:
        "Release PRs run every tier cold. About **six minutes** more on `test-linux`, inside its 36-minute cap.",
    },
    {
      title: "Ask again after 0.45",
      description:
        "Leave it as it is and raise this again once the next release's timings are in.",
    },
  ],
  [Q_WINDOWS]: [
    {
      title: "Skip on Windows",
      description:
        "The cost journeys report themselves skipped on the Windows leg and run on Linux.",
    },
    {
      title: "Fail without strace",
      description:
        "Keep today's rule: a missing tool is a failure, never a skip, on every leg.",
    },
    {
      title: "Linux leg only",
      description:
        "Move the cost journeys out of the cross-platform tiers so Windows never selects them.",
    },
  ],
};

/** The choice each stage holds as a draft, by item. */
function picks(stage: MockStage): Readonly<Record<string, number>> {
  switch (stage) {
    case "card":
    case "detail":
      return { [Q_SDK]: 1 };
    case "bar":
      return { [Q_SDK]: 1, [Q_CACHE]: 1 };
    case "refused":
      return { [Q_CACHE]: 1 };
    case "answered":
      return { [Q_SDK]: 1 };
    default:
      return {};
  }
}

const CACHE_NOTE = "Only once 0.45 ships; keep promoting until then.";

function texts(stage: MockStage): Readonly<Record<string, string>> {
  switch (stage) {
    case "detail":
      return {
        [Q_SDK]: "The receipt change is ours to absorb in this release.",
      };
    case "bar":
      return {
        [Q_FREE]: "Action items — questions and tasks waiting on you",
        [Q_CACHE]: CACHE_NOTE,
      };
    case "refused":
      return { [Q_CACHE]: CACHE_NOTE };
    default:
      return {};
  }
}

export function pickedChoice(
  stage: MockStage | undefined,
  id: string,
): number | undefined {
  return stage === undefined ? undefined : picks(stage)[id];
}

/** The six-item list, drafts and the one refusal, in place of what the server holds. */
export function mockHumanItems(
  stage: MockStage,
  real: ReturnType<typeof useHumanItems>,
  selectedId: string | undefined,
): ReturnType<typeof useHumanItems> {
  const items = liveItems(stage);
  const selected = items.find(({ item: { id } }) => id === selectedId);
  const detail: HumanItemDetail | undefined =
    selected === undefined
      ? undefined
      : {
          ...selected,
          nodes: selected.blocked.plans.flatMap(({ preview }) => preview),
        };
  const writes: Record<string, WriteState> =
    stage === "refused"
      ? {
          [Q_CACHE]: {
            pending: false,
            error:
              "Not sent: this question was answered from the CLI at 09:12. Your draft is kept.",
          },
        }
      : {};
  return {
    ...real,
    items,
    listError: undefined,
    detail,
    gone: false,
    detailError: undefined,
    drafts: texts(stage),
    writes,
    toast: undefined,
  };
}

/** How many questions hold a draft — by choice, text, or both. */
export function draftCount(stage: MockStage): number {
  return new Set([...Object.keys(picks(stage)), ...Object.keys(texts(stage))])
    .size;
}

/** A choice question's titles as buttons; the pressed one is the draft. */
export function ChoiceButtons({
  id,
  title,
  stage,
}: {
  readonly id: string;
  readonly title: string;
  readonly stage: MockStage;
}) {
  const choices = CHOICES[id];
  if (choices === undefined) return null;
  const picked = pickedChoice(stage, id);
  return (
    <fieldset aria-label={`Choices: ${title}`} className="mock-choices">
      {choices.map((choice, index) => (
        <button
          aria-pressed={picked === index}
          className="mock-choice"
          key={choice.title}
          type="button"
        >
          {choice.title}
        </button>
      ))}
    </fieldset>
  );
}

/** The expanded view's choices: each title and its whole description, one selected. */
export function ChoiceList({
  id,
  stage,
}: {
  readonly id: string;
  readonly stage: MockStage;
}) {
  const choices = CHOICES[id];
  if (choices === undefined) return null;
  const picked = pickedChoice(stage, id);
  return (
    <fieldset className="mock-choice-list">
      <legend>Choices</legend>
      {choices.map((choice, index) => (
        <label
          className="mock-choice-option"
          data-picked={picked === index}
          key={choice.title}
        >
          <input
            defaultChecked={picked === index}
            name={`choice-${id}`}
            type="radio"
          />
          <span>
            <strong>{choice.title}</strong>
            <TaskMarkdown source={choice.description} />
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** An answered question's picked choice and its text. */
export function AnsweredLine({
  view,
  stage,
}: {
  readonly view: HumanItemView;
  readonly stage: MockStage;
}) {
  const { item } = view;
  const choice = CHOICES[item.id]?.[pickedChoice(stage, item.id) ?? -1];
  return (
    <div className="mock-answered">
      {choice && (
        <p>
          <span className="mock-answered-label">Picked</span>{" "}
          <strong>{choice.title}</strong>
        </p>
      )}
      {item.resolution?.text && (
        <p>
          <span className="mock-answered-label">Answer</span>{" "}
          {item.resolution.text}
        </p>
      )}
    </div>
  );
}

/** The sticky bar that sends every held draft at once. */
export function SendBar({ stage }: { readonly stage: MockStage }) {
  const count = draftCount(stage);
  if (count === 0 || stage === "answered") return null;
  const answers = count === 1 ? "1 answer" : `${count} answers`;
  return (
    <section aria-label="Drafted answers" className="mock-send-bar">
      <span className="mock-send-bar-count">
        {stage === "refused"
          ? "2 sent · 1 refused, draft kept"
          : `${count} drafted`}
      </span>
      <Button size="sm" type="button" variant="outline">
        Discard
      </Button>
      <Button size="sm" type="button">
        Send {answers}
      </Button>
    </section>
  );
}
