// Smoke test: runs the built node against a fake Capucine Tools API (OpenAPI + echo).
// Usage: npm run build && npm test
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapucineTools } = require('../dist/nodes/CapucineTools/CapucineTools.node.js');

const spec = {
	openapi: '3.0.0',
	paths: {
		'/health': { get: { parameters: [] } },
		'/tools/greet/{id}': {
			post: {
				summary: 'Greet',
				parameters: [
					{ name: 'id', in: 'path', required: true, schema: { type: 'string' } },
					{ name: 'lang', in: 'query', schema: { type: 'string', enum: ['fr', 'en'] } },
				],
				requestBody: {
					content: { 'application/json': { schema: { $ref: '#/components/schemas/GreetDto' } } },
				},
			},
		},
	},
	components: {
		schemas: {
			GreetDto: {
				type: 'object',
				required: ['name'],
				properties: { name: { type: 'string' }, times: { type: 'integer' } },
			},
		},
	},
};

const server = createServer((req, res) => {
	let raw = '';
	req.on('data', (c) => (raw += c));
	req.on('end', () => {
		res.setHeader('content-type', 'application/json');
		if (req.url === '/docs-json') return res.end(JSON.stringify(spec));
		res.end(
			JSON.stringify({
				method: req.method,
				url: req.url,
				auth: req.headers.authorization,
				body: raw ? JSON.parse(raw) : null,
			}),
		);
	});
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://localhost:${server.address().port}/`;

// Minimal stand-in for n8n's execution context.
async function http(opts) {
	const url = new URL(opts.url);
	for (const [k, v] of Object.entries(opts.qs ?? {})) url.searchParams.set(k, String(v));
	const res = await fetch(url, {
		method: opts.method ?? 'GET',
		headers: { 'content-type': 'application/json', ...opts.headers },
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	return res.json();
}
const params = {
	operation: 'POST /tools/greet/{id}',
	'fields.value': { id: 'a b', lang: 'fr', name: 'Capucine', times: 2 },
};
const ctx = {
	getCredentials: async () => ({ baseUrl, apiKey: 'k' }),
	getNodeParameter: (name) => params[name],
	getInputData: () => [{ json: {} }],
	getNode: () => ({ name: 'Capucine Tools' }),
	continueOnFail: () => false,
	helpers: {
		httpRequest: http,
		httpRequestWithAuthentication: (_cred, opts) =>
			http({ ...opts, headers: { authorization: 'Bearer k' } }),
	},
};

const node = new CapucineTools();

const ops = await node.methods.loadOptions.getOperations.call(ctx);
assert.deepEqual(
	ops.map((o) => o.value),
	['GET /health', 'POST /tools/greet/{id}'],
);

const { fields } = await node.methods.resourceMapping.getFields.call(ctx);
assert.deepEqual(
	fields.map((f) => [f.id, f.type, f.required]),
	[
		['id', 'string', true],
		['lang', 'options', false],
		['name', 'string', true],
		['times', 'number', false],
	],
);

const [[out]] = await node.execute.call(ctx);
assert.deepEqual(out.json, {
	method: 'POST',
	url: '/tools/greet/a%20b?lang=fr',
	auth: 'Bearer k',
	body: { name: 'Capucine', times: 2 },
});

server.close();
console.log('smoke ok');
