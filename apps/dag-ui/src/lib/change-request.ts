/**
 * How a change request is named wherever this app links one: its short id,
 * `<repository>#<number>` — `crozier#769` — so two links on one screen can be told
 * apart, which "Pull request" twice cannot.
 *
 * Read off the URL alone, because that is all a publication record carries. A URL
 * whose path does not end `<owner>/<repository>/pull/<number>` keeps the readable
 * "Change request" rather than a guess, and a missing one names nothing, because
 * there is nothing to link.
 */
export function changeRequestId(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    // Only an address that is no URL reaches here, which no engine writes for a
    // change request, so no recorded run a journey serves carries one;
    // change-request.test.ts proves this fallback directly.
    return CHANGE_REQUEST;
  }
  const pull = /\/[^/]+\/([^/]+)\/pull\/(\d+)\/?$/u.exec(path);
  return pull === null ? CHANGE_REQUEST : `${pull[1]}#${pull[2]}`;
}

const CHANGE_REQUEST = "Change request";
