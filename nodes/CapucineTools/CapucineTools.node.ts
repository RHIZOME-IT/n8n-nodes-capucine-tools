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

const CREDENTIAL = 'capucineToolsApi';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

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

function inputsOf(spec: OpenApi, op: Operation): Input[] {
	const params: Input[] = (op.parameters ?? [])
		.filter((p) => p.in === 'path' || p.in === 'query')
		.map((p) => ({
			name: p.name,
			location: p.in as 'path' | 'query',
			required: p.in === 'path' || !!p.required,
			schema: deref(spec, p.schema),
		}));
	const body = deref(spec, op.requestBody?.content?.['application/json']?.schema);
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
						displayName: input.name,
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
		const returnData: INodeExecutionData[] = [];

		for (let i = 0; i < this.getInputData().length; i++) {
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
				for (const input of inputsOf(spec, op)) {
					const value = values[input.name];
					if (value === undefined || value === null || value === '') continue;
					if (input.location === 'path')
						url = url.replace(`{${input.name}}`, encodeURIComponent(String(value)));
					else if (input.location === 'query') qs[input.name] = value;
					else body[input.name] = value;
				}

				const response: unknown = await this.helpers.httpRequestWithAuthentication.call(
					this,
					CREDENTIAL,
					{
						method: method as IHttpRequestMethods,
						url: `${baseUrl}${url}`,
						qs,
						body: op.requestBody ? body : undefined,
						json: true,
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
				throw new NodeApiError(this.getNode(), error as JsonObject, {
					itemIndex: i,
				});
			}
		}

		return [returnData];
	}
}
