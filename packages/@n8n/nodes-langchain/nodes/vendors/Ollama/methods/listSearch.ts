import type { ILoadOptionsFunctions, INodeListSearchResult } from 'n8n-workflow';
import { requestPath } from 'n8n-workflow';

import type { OllamaTagsResponse } from '../helpers/interfaces';
import { apiRequest } from '../transport';

const BYTES_PER_GIBIBYTE = 1024 ** 3;

function modelDescription(model: OllamaTagsResponse['models'][number]): string | undefined {
	if (!model.size || !model.details) return undefined;

	const size = model.size / BYTES_PER_GIBIBYTE;
	const estimatedRam = size * 1.2;
	const recommendedRam = [8, 16, 32, 64].find((ram) => estimatedRam <= ram);
	const feasibility = recommendedRam
		? `Suitable for ${recommendedRam} GB RAM`
		: 'Requires more than 64 GB RAM';

	return [
		`Size: ${size.toFixed(1)} GB`,
		`Family: ${model.details.family}`,
		`Parameters: ${model.details.parameter_size}`,
		`Quantization: ${model.details.quantization_level}`,
		`Estimated RAM: ${estimatedRam.toFixed(1)} GB`,
		`Feasibility: ${feasibility}`,
	].join(' | ');
}

export async function modelSearch(
	this: ILoadOptionsFunctions,
	filter?: string,
): Promise<INodeListSearchResult> {
	const response: OllamaTagsResponse = await apiRequest.call(this, 'GET', requestPath`/api/tags`);

	let models = response.models;

	if (filter) {
		models = models.filter((model) => model.name.toLowerCase().includes(filter.toLowerCase()));
	}

	return {
		results: models.map((model) => {
			const description = modelDescription(model);
			return {
				name: model.name,
				value: model.name,
				...(description ? { description } : {}),
			};
		}),
	};
}
