# @rhizome-it/n8n-nodes-capucine-tools

n8n community node for [Capucine Tools](https://github.com/RHIZOME-IT/capucine-tools-api).

The tool list is read at runtime from the API's OpenAPI document (`<base URL>/docs-json`):
every route exposed by Capucine Tools shows up in the **Tool** dropdown, with its path, query
and JSON body fields in **Fields**. A new tool in the API needs no new release of this node.

## Install

In n8n: *Settings → Community nodes → Install*, package `@rhizome-it/n8n-nodes-capucine-tools`.

## Credential

**Capucine Tools**: one credential per environment (local, prod…).

- **Base URL**: e.g. `https://capucine-tools.coolify.rhizome-it.com` or `http://localhost:3000`
- **API Key**: the API's `API_KEY`, sent as `Authorization: Bearer <key>`

The credential test only checks that the base URL serves the OpenAPI document; a wrong key
shows up as a 401 on the first call.

## Development

```bash
npm install --ignore-scripts   # isolated-vm (pulled by the CLI) does not build on non-LTS Node
npm run build
npm test                       # smoke test against a fake API
npm run lint
npm run dev                    # local n8n with the node linked (needs Node LTS)
```

## Release

The CI (`.github/workflows/ci.yaml`) publishes to npm on every bare semver tag, through npm
trusted publishing (no npm token, with provenance):

```bash
npm version patch   # or minor / major: bumps package.json, commits, tags (e.g. 0.1.1)
git push --follow-tags
```

`npm publish` from a workstation is blocked by `prepublishOnly`, except with `RELEASE_MODE=1`.
