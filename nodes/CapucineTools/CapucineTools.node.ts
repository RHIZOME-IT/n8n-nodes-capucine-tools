import type {
	FieldType,
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	ILoadOptionsFunctions,
	INodeExecutionData,
	INodePropertyOptions,
	INodeType,
	INodeTypeDescription,
	JsonObject,
	ResourceMapperFields,
} from 'n8n-workflow';
import { NodeApiError, NodeConnectionTypes, NodeOperationError } from 'n8n-workflow';

// Minimal slice of OpenAPI 3 that the NestJS Swagger document produces.
type Schema = {
	type?: string;
	format?: string;
	enum?: Array<string | number>;
	properties?: Record<string, Schema>;
	required?: string[];
	description?: string;
	$ref?: string;
};
type Parameter = {
	name: string;
	in: string;
	required?: boolean;
	schema?: Schema;
};
type Operation = {
	summary?: string;
	parameters?: Parameter[];
	requestBody?: { content?: Record<string, { schema?: Schema }> };
};
type OpenApi = {
	paths: Record<string, Record<string, Operation>>;
	components?: { schemas?: Record<string, Schema> };
};
type Input = {
	name: string;
	location: 'path' | 'query' | 'body';
	required: boolean;
	schema: Schema;
};

const CREDENTIAL = 'capucineTools';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
// Some tools (document generation) run for minutes.
const TIMEOUT_MS = 600_000;

async function getBaseUrl(this: IExecuteFunctions | ILoadOptionsFunctions): Promise<string> {
	const { baseUrl } = await this.getCredentials(CREDENTIAL);
	return String(baseUrl).replace(/\/$/, '');
}

/** The tool catalogue is the API's own OpenAPI document: new routes show up without republishing the node. */
async function getSpec(this: IExecuteFunctions | ILoadOptionsFunctions): Promise<OpenApi> {
	const baseUrl = await getBaseUrl.call(this);
	return (await this.helpers.httpRequest({
		url: `${baseUrl}/docs-json`,
		json: true,
	})) as OpenApi;
}

function deref(spec: OpenApi, schema: Schema | undefined): Schema {
	if (!schema?.$ref) return schema ?? {};
	return spec.components?.schemas?.[schema.$ref.split('/').pop() ?? ''] ?? {};
}

/** Operations are identified as "METHOD /path", e.g. "POST /tools/foo/{id}". */
function findOperation(
	spec: OpenApi,
	key: string,
): { method: string; path: string; op?: Operation } {
	const [method = '', path = ''] = key.split(' ');
	return { method, path, op: spec.paths[path]?.[method.toLowerCase()] };
}

/** JSON body, else multipart/form-data (file upload routes). */
function bodyOf(spec: OpenApi, op: Operation): { schema: Schema; multipart: boolean } {
	const content = op.requestBody?.content;
	const multipart = !content?.['application/json'] && !!content?.['multipart/form-data'];
	const media = content?.[multipart ? 'multipart/form-data' : 'application/json'];
	return { schema: deref(spec, media?.schema), multipart };
}

/** A binary field's value is the name of a binary property of the input item. */
const isBinary = (schema: Schema) => schema.format === 'binary';

function inputsOf(spec: OpenApi, op: Operation): Input[] {
	const params: Input[] = (op.parameters ?? [])
		.filter((p) => p.in === 'path' || p.in === 'query')
		.map((p) => ({
			name: p.name,
			location: p.in as 'path' | 'query',
			required: p.in === 'path' || !!p.required,
			schema: deref(spec, p.schema),
		}));
	const body = bodyOf(spec, op).schema;
	const bodyInputs: Input[] = Object.entries(body.properties ?? {}).map(([name, schema]) => ({
		name,
		location: 'body',
		required: body.required?.includes(name) ?? false,
		schema: deref(spec, schema),
	}));
	return [...params, ...bodyInputs];
}

function fieldType(schema: Schema): FieldType {
	if (schema.enum) return 'options';
	switch (schema.type) {
		case 'integer':
		case 'number':
			return 'number';
		case 'boolean':
			return 'boolean';
		case 'array':
			return 'array';
		case 'object':
			return 'object';
		default:
			return 'string';
	}
}

export class CapucineTools implements INodeType {
	description: INodeTypeDescription = {
		displayName: 'Capucine Tools',
		name: 'capucineTools',
		icon: 'file:capucineTools.svg',
		group: ['transform'],
		version: 1,
		subtitle: '={{$parameter["operation"]}}',
		description: 'Call a Capucine Tools tool',
		defaults: { name: 'Capucine Tools' },
		usableAsTool: true,
		inputs: [NodeConnectionTypes.Main],
		outputs: [NodeConnectionTypes.Main],
		credentials: [{ name: CREDENTIAL, required: true }],
		properties: [
			{
				displayName: 'Tool Name or ID',
				name: 'operation',
				type: 'options',
				noDataExpression: true,
				typeOptions: { loadOptionsMethod: 'getOperations' },
				default: '',
				required: true,
				description:
					'Choose from the list, or specify an ID using an <a href="https://docs.n8n.io/code/expressions/">expression</a>',
			},
			{
				displayName: 'Fields',
				name: 'fields',
				type: 'resourceMapper',
				noDataExpression: true,
				default: { mappingMode: 'defineBelow', value: null },
				required: true,
				typeOptions: {
					loadOptionsDependsOn: ['operation'],
					resourceMapper: {
						resourceMapperMethod: 'getFields',
						mode: 'add',
						fieldWords: { singular: 'field', plural: 'fields' },
						addAllFields: true,
						multiKeyMatch: false,
						supportAutoMap: false,
					},
				},
			},
		],
	};

	methods = {
		loadOptions: {
			async getOperations(this: ILoadOptionsFunctions): Promise<INodePropertyOptions[]> {
				const spec = await getSpec.call(this);
				return Object.entries(spec.paths).flatMap(([path, ops]) =>
					Object.entries(ops)
						.filter(([method]) => METHODS.includes(method))
						.map(([method, op]) => {
							const value = `${method.toUpperCase()} ${path}`;
							return { name: op.summary ?? value, value, description: value };
						}),
				);
			},
		},
		resourceMapping: {
			async getFields(this: ILoadOptionsFunctions): Promise<ResourceMapperFields> {
				const spec = await getSpec.call(this);
				const { op } = findOperation(spec, this.getNodeParameter('operation', '') as string);
				if (!op) return { fields: [] };
				return {
					fields: inputsOf(spec, op).map((input) => ({
						id: input.name,
						displayName: isBinary(input.schema) ? `${input.name} (binary property)` : input.name,
						required: input.required,
						defaultMatch: false,
						display: true,
						type: fieldType(input.schema),
						options: input.schema.enum?.map((v) => ({
							name: String(v),
							value: v,
						})),
					})),
				};
			},
		},
	};

	async execute(this: IExecuteFunctions): Promise<INodeExecutionData[][]> {
		const spec = await getSpec.call(this);
		const baseUrl = await getBaseUrl.call(this);
		const items = this.getInputData();
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < items.length; i++) {
			const key = this.getNodeParameter('operation', i) as string;
			const { method, path, op } = findOperation(spec, key);
			if (!op) {
				throw new NodeOperationError(
					this.getNode(),
					`Unknown tool "${key}": reload the tool list`,
					{
						itemIndex: i,
					},
				);
			}

			try {
				const values = (this.getNodeParameter('fields.value', i, {}) ?? {}) as IDataObject;
				let url = path;
				const qs: IDataObject = {};
				const body: IDataObject = {};
				const { multipart } = bodyOf(spec, op);
				const form = new FormData();
				for (const input of inputsOf(spec, op)) {
					const value = values[input.name];
					if (value === undefined || value === null || value === '') continue;
					if (input.location === 'path')
						url = url.replace(`{${input.name}}`, encodeURIComponent(String(value)));
					else if (input.location === 'query') qs[input.name] = value;
					else if (!multipart) body[input.name] = value;
					else if (isBinary(input.schema)) {
						const prop = String(value);
						if (!items[i].binary?.[prop]) {
							throw new NodeOperationError(
								this.getNode(),
								`Field "${input.name}" expects the binary property "${prop}" on input item ${i}, but it has none`,
								{ itemIndex: i },
							);
						}
						const file = this.helpers.assertBinaryData(i, prop);
						const buffer = await this.helpers.getBinaryDataBuffer(i, prop);
						form.append(
							input.name,
							new Blob([buffer], { type: file.mimeType }),
							file.fileName ?? input.name,
						);
					} else
						form.append(
							input.name,
							typeof value === 'object' ? JSON.stringify(value) : String(value),
						);
				}

				const response: unknown = await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL,
					{
						method: method as IHttpRequestMethods,
						url: `${baseUrl}${url}`,
						qs,
						// Native FormData: axios (behind n8n's helper) sends it as multipart with its boundary.
						body: !op.requestBody ? undefined : multipart ? (form as unknown as IDataObject) : body,
						json: true,
						timeout: TIMEOUT_MS,
					},
				);
				const json =
					response && typeof response === 'object' && !Array.isArray(response)
						? (response as IDataObject)
						: { data: response as IDataObject };
				returnData.push({ json, pairedItem: { item: i } });
			} catch (error) {
				if (this.continueOnFail()) {
					returnData.push({
						json: { error: (error as Error).message },
						pairedItem: { item: i },
					});
					continue;
				}
				// Returns the same instance: our own errors (missing binary) keep their message.
				if (error instanceof NodeOperationError)
					throw new NodeOperationError(this.getNode(), error, { itemIndex: i });
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}
