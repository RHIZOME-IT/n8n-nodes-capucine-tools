import type {
	IAuthenticateGeneric,
	Icon,
	ICredentialTestRequest,
	ICredentialType,
	INodeProperties,
} from 'n8n-workflow';

/** One credential per environment (local, prod...): base URL + API key. */
export class CapucineToolsApi implements ICredentialType {
	name = 'capucineToolsApi';

	// eslint-disable-next-line n8n-nodes-base/cred-class-field-display-name-missing-api -- product name chosen by Rhizome IT
	displayName = 'Capucine Tools';

	icon: Icon = 'file:../nodes/CapucineTools/capucineTools.svg';

	documentationUrl = 'https://github.com/RHIZOME-IT/n8n-nodes-capucine-tools';

	properties: INodeProperties[] = [
		{
			displayName: 'Base URL',
			name: 'baseUrl',
			type: 'string',
			default: '',
			placeholder: 'https://capucine-tools.coolify.rhizome-it.com',
			required: true,
		},
		{
			displayName: 'API Key',
			name: 'apiKey',
			type: 'string',
			typeOptions: { password: true },
			default: '',
			required: true,
		},
	];

	authenticate: IAuthenticateGeneric = {
		type: 'generic',
		properties: {
			headers: { Authorization: '=Bearer {{$credentials.apiKey}}' },
		},
	};

	// ponytail: only checks the URL (the OpenAPI document is public); add a protected
	// "whoami" route to the API if the key itself must be validated here.
	test: ICredentialTestRequest = {
		request: {
			baseURL: '={{$credentials.baseUrl.replace(/\\/$/, "")}}',
			url: '/docs-json',
		},
	};
}
