// Smoke test: runs the built node against a fake Capucine Tools API (OpenAPI + echo).
// Usage: npm run build && npm test
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CapucineTools, fileNameOf } = require('../dist/nodes/CapucineTools/CapucineTools.node.js');

const spec = {
	openapi: '3.0.0',
	paths: {
		'/health': { get: { parameters: [] } },
		'/file': { post: { summary: 'File' } },
		'/fail': { post: { summary: 'Fail' } },
		'/boom': { post: { summary: 'Boom' } },
		'/charset': { post: { summary: 'Charset' } },
		'/plus': { post: { summary: 'Plus' } },
		'/array': { post: { summary: 'Array' } },
		'/empty': { post: { summary: 'Empty' } },
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
		'/generate-profile-doc-from-file': {
			post: {
				summary: 'Generate from file',
				requestBody: {
					content: {
						'multipart/form-data': {
							schema: {
								type: 'object',
								required: ['profileFile', 'tenderTitle'],
								properties: {
									profileFile: { type: 'string', format: 'binary' },
									tenderTitle: { type: 'string' },
									businessManager: { type: 'object' },
									tenderText: { type: 'string' },
								},
							},
						},
					},
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

// Echoes the request; a multipart body comes back as { field: string | { name, type, text } }.
async function parseBody(type, raw) {
	if (!raw.length) return null;
	if (!type?.startsWith('multipart/form-data')) return JSON.parse(raw.toString());
	const form = await new Response(raw, { headers: { 'content-type': type } }).formData();
	const out = {};
	for (const [k, v] of form)
		out[k] = typeof v === 'string' ? v : { name: v.name, type: v.type, text: await v.text() };
	return out;
}
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const BYTES = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00, 0xc3, 0x28]); // not valid UTF-8
const server = createServer((req, res) => {
	const chunks = [];
	req.on('data', (c) => chunks.push(c));
	req.on('end', async () => {
		if (req.url === '/file') {
			res.setHeader('content-type', DOCX);
			res.setHeader(
				'content-disposition',
				`attachment; filename="Profil.docx"; filename*=UTF-8''${encodeURIComponent('Profil é à.docx')}`,
			);
			return res.end(BYTES);
		}
		const reply = (type, body, status = 200) => {
			res.statusCode = status;
			res.setHeader('content-type', type);
			res.end(body);
		};
		if (req.url === '/charset') return reply('application/json; charset=utf-8', '{"a":"é"}');
		if (req.url === '/plus') return reply('application/problem+json', '{"b":1}');
		if (req.url === '/array') return reply('application/json', '[1,2]');
		if (req.url === '/empty') return reply('application/json', '');
		if (req.url === '/boom') return reply('text/plain', 'upstream down', 502);
		res.setHeader('content-type', 'application/json');
		if (req.url === '/fail') {
			res.statusCode = 422;
			return res.end(JSON.stringify({ message: 'Profile is invalid' }));
		}
		if (req.url === '/docs-json') return res.end(JSON.stringify(spec));
		const type = req.headers['content-type'];
		res.end(
			JSON.stringify({
				method: req.method,
				url: req.url,
				auth: req.headers.authorization,
				type: type?.split(';')[0],
				body: await parseBody(type, Buffer.concat(chunks)),
			}),
		);
	});
});
await new Promise((r) => server.listen(0, r));
const baseUrl = `http://localhost:${server.address().port}/`;

// Minimal stand-in for n8n's execution context; records the options of every tool call.
const calls = [];
async function http(opts) {
	const url = new URL(opts.url);
	for (const [k, v] of Object.entries(opts.qs ?? {})) url.searchParams.set(k, String(v));
	const form = opts.body instanceof FormData;
	const res = await fetch(url, {
		method: opts.method ?? 'GET',
		headers: { ...(form ? {} : { 'content-type': 'application/json' }), ...opts.headers },
		body: form ? opts.body : opts.body ? JSON.stringify(opts.body) : undefined,
	});
	// Like n8n: arraybuffer => Buffer body, full response => { body, headers, statusCode }, errors carry response.data.
	assert.equal(opts.encoding, 'arraybuffer');
	assert.equal(opts.returnFullResponse, true);
	const body = Buffer.from(await res.arrayBuffer());
	if (!res.ok && !opts.ignoreHttpStatusErrors)
		throw Object.assign(new Error(`Request failed with status code ${res.status}`), {
			response: { status: res.status, data: body },
		});
	return { body, headers: Object.fromEntries(res.headers), statusCode: res.status };
}
let params = {
	operation: 'POST /tools/greet/{id}',
	'fields.value': { id: 'a b', lang: 'fr', name: 'Capucine', times: 2 },
};
let items = [{ json: {} }];
const ctx = {
	getCredentials: async () => ({ baseUrl, apiKey: 'k' }),
	getNodeParameter: (name) => params[name],
	getInputData: () => items,
	getNode: () => ({ name: 'Capucine Tools' }),
	continueOnFail: () => false,
	helpers: {
		httpRequest: async (opts) =>
			JSON.parse((await http({ ...opts, encoding: 'arraybuffer', returnFullResponse: true })).body),
		prepareBinaryData: async (buffer, fileName, mimeType) => ({
			data: buffer.toString('base64'),
			fileName,
			mimeType,
		}),
		httpRequestWithAuthentication: (_cred, opts) => {
			assert.equal(opts.ignoreHttpStatusErrors, true);
			calls.push(opts);
			return http({ ...opts, headers: { authorization: 'Bearer k' } });
		},
		assertBinaryData: (i, prop) => {
			const data = items[i].binary?.[prop];
			if (!data) throw new Error(`no binary ${prop}`);
			return data;
		},
		getBinaryDataBuffer: async (i, prop) => Buffer.from(items[i].binary[prop].data, 'base64'),
	},
};

const node = new CapucineTools();

const ops = await node.methods.loadOptions.getOperations.call(ctx);
assert.deepEqual(
	ops.map((o) => o.value),
	[
		'GET /health',
		'POST /file',
		'POST /fail',
		'POST /boom',
		'POST /charset',
		'POST /plus',
		'POST /array',
		'POST /empty',
		'POST /tools/greet/{id}',
		'POST /generate-profile-doc-from-file',
	],
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
	type: 'application/json',
	body: { name: 'Capucine', times: 2 },
});
assert.equal(calls[0].timeout, 600_000);

// Multipart route: file fields hold the name of a binary property of the input item.
params = { operation: 'POST /generate-profile-doc-from-file' };
const mp = await node.methods.resourceMapping.getFields.call(ctx);
assert.deepEqual(
	mp.fields.map((f) => [f.id, f.displayName, f.type, f.required]),
	[
		['profileFile', 'profileFile (binary property)', 'string', true],
		['tenderTitle', 'tenderTitle', 'string', true],
		['businessManager', 'businessManager', 'object', false],
		['tenderText', 'tenderText', 'string', false],
	],
);

const pdf = '%PDF-1.4 fake';
items = [
	{
		json: {},
		binary: {
			data: {
				data: Buffer.from(pdf).toString('base64'),
				mimeType: 'application/pdf',
				fileName: 'cv.pdf',
			},
		},
	},
];
params['fields.value'] = {
	profileFile: 'data',
	tenderTitle: 'Appel',
	businessManager: { name: 'BM' },
	tenderText: '',
};
calls.length = 0;
const [[mpOut]] = await node.execute.call(ctx);
assert.deepEqual(mpOut.json, {
	method: 'POST',
	url: '/generate-profile-doc-from-file',
	auth: 'Bearer k',
	type: 'multipart/form-data',
	body: {
		profileFile: { name: 'cv.pdf', type: 'application/pdf', text: pdf },
		tenderTitle: 'Appel',
		businessManager: '{"name":"BM"}',
	},
});
assert.equal(calls[0].timeout, 600_000);

// Missing binary property: operation error naming the field and the property.
params['fields.value'] = { profileFile: 'nope', tenderTitle: 'Appel' };
await assert.rejects(node.execute.call(ctx), (e) => {
	assert.equal(e.constructor.name, 'NodeOperationError');
	assert.match(e.message, /profileFile/);
	assert.match(e.message, /nope/);
	return true;
});

// File response: binary.data keeps the exact bytes, accented file name from filename*.
params = { operation: 'POST /file' };
items = [{ json: {} }];
const [[fileOut]] = await node.execute.call(ctx);
assert.deepEqual(fileOut.json, {
	fileName: 'Profil é à.docx',
	mimeType: DOCX,
	fileSize: BYTES.length,
});
assert.equal(fileOut.binary.data.fileName, 'Profil é à.docx');
assert.equal(fileOut.binary.data.mimeType, DOCX);
assert.ok(Buffer.from(fileOut.binary.data.data, 'base64').equals(BYTES));

// File name fallbacks.
assert.equal(fileNameOf('attachment; filename="a b.docx"'), 'a b.docx');
assert.equal(fileNameOf('attachment; filename=a.docx'), 'a.docx');
assert.equal(fileNameOf(undefined), 'file');

// A JSON error body still surfaces its message (NodeApiError puts the API message in description).

params = { operation: 'POST /fail' };
await assert.rejects(node.execute.call(ctx), (e) => {
	assert.equal(e.constructor.name, 'NodeApiError');
	assert.equal(e.description, 'Profile is invalid');
	return true;
});

// Content-type variants and empty body.
for (const [op, expected] of [
	['POST /charset', { a: 'é' }],
	['POST /plus', { b: 1 }],
	['POST /array', { data: [1, 2] }],
	['POST /empty', { data: '' }],
]) {
	params = { operation: op };
	const [[o]] = await node.execute.call(ctx);
	assert.deepEqual(o.json, expected, op);
	assert.equal(o.binary, undefined, op);
}

// Non-JSON error body: raw text in description, status code kept; continueOnFail reports the message.
params = { operation: 'POST /boom' };
await assert.rejects(node.execute.call(ctx), (e) => {
	assert.equal(e.constructor.name, 'NodeApiError');
	assert.equal(e.httpCode, '502');
	return true;
});
ctx.continueOnFail = () => true;
params = { operation: 'POST /fail' };
const [[failOut]] = await node.execute.call(ctx);
assert.equal(typeof failOut.json.error, 'string');
ctx.continueOnFail = () => false;

server.close();
console.log('smoke ok');
