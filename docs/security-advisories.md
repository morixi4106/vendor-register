# Production dependency advisories

## Temporary React Router 6 exception

The production audit currently contains a narrow exception for these moderate
React Router advisories:

- `GHSA-wrjc-x8rr-h8h6`
- `GHSA-337j-9hxr-rhxg`
- `GHSA-jjmj-jmhj-qwj2`

The affected dependency chain is provided by Remix 2. A direct React Router 7
override was tested and rejected because Remix 2 still imports
`react-router-dom/server`, which is not exposed by React Router 7.

The exception:

- applies only to `@remix-run/react`, `react-router`, and `react-router-dom`;
- applies only to the three advisory IDs above;
- never applies to high or critical vulnerabilities;
- expires after 2026-09-30;
- fails CI if any additional advisory or affected package appears.

The permanent resolution is a planned Remix 2 to React Router 7 framework
migration. Until then, application redirects must continue to use fixed or
server-validated destinations rather than untrusted navigation targets.
