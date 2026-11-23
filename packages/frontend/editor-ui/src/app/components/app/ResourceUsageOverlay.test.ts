import { fireEvent, waitFor } from '@testing-library/vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createComponentRenderer } from '@/__tests__/render';

import ResourceUsageOverlay from './ResourceUsageOverlay.vue';

const renderComponent = createComponentRenderer(ResourceUsageOverlay);

describe('ResourceUsageOverlay', () => {
	beforeEach(() => {
		vi.useRealTimers();
		localStorage.clear();
		vi.restoreAllMocks();
	});

	it('shows host and n8n resource metrics from the local metrics service', async () => {
		vi.spyOn(window, 'fetch').mockResolvedValue(
			new Response(
				JSON.stringify({
					sampled_at: '2026-11-22T12:00:00Z',
					host: {
						cpu: { percent: 24.5 },
						memory: { used_bytes: 8 * 1024 ** 3, total_bytes: 16 * 1024 ** 3 },
						disk: { used_bytes: 100 * 1024 ** 3, total_bytes: 500 * 1024 ** 3 },
						network: { bytes_sent: 1000, bytes_received: 2000 },
						uptime_seconds: 90_000,
					},
					n8n: {
						cpu: { percent: 12.25 },
						memory: { used_bytes: 2 * 1024 ** 3, total_bytes: 4 * 1024 ** 3 },
						pids: 12,
						network_io: '2 MB / 3 MB',
						block_io: '4 MB / 5 MB',
					},
				}),
			),
		);

		const { getByText, getByTestId } = renderComponent();

		await waitFor(() => expect(getByText('24.5%')).toBeVisible());
		expect(getByText('12.3%')).toBeVisible();
		expect(getByText('8.0 GB / 16.0 GB')).toBeVisible();
		expect(getByText('2.0 GB / 4.0 GB')).toBeVisible();
		expect(getByText(/100.0 GB \/ 500.0 GB/)).toBeVisible();
		expect(getByText(/Processes: 12/)).toBeVisible();
		expect(getByText('Host CPU')).toBeVisible();
		expect(getByText('Host memory')).toBeVisible();
		expect(getByText('n8n CPU')).toBeVisible();
		expect(getByText('n8n memory')).toBeVisible();
		expect(getByTestId('resource-usage-history')).toHaveAttribute('data-samples', '1');
		expect(window.fetch).toHaveBeenCalledWith('http://127.0.0.1:7412/v1/metrics');
	});

	it('keeps the latest 60 seconds in the visible history', async () => {
		vi.useFakeTimers();
		vi.spyOn(window, 'fetch').mockImplementation(
			async () =>
				new Response(
					JSON.stringify({
						host: { cpu: { percent: 10 } },
						n8n: { cpu: { percent: 5 } },
					}),
				),
		);

		const { getByTestId } = renderComponent();
		await vi.advanceTimersByTimeAsync(61_000);

		expect(getByTestId('resource-usage-history')).toHaveAttribute('data-samples', '60');
	});

	it('collapses the metrics and restores that state from local storage', async () => {
		vi.spyOn(window, 'fetch').mockRejectedValue(new Error('Unavailable'));
		const { getByRole, queryByTestId, unmount } = renderComponent();

		await fireEvent.click(getByRole('button', { name: 'Collapse resource usage' }));
		expect(queryByTestId('resource-usage-content')).not.toBeInTheDocument();
		unmount();

		const restored = renderComponent();
		expect(restored.queryByTestId('resource-usage-content')).not.toBeInTheDocument();
		expect(restored.getByRole('button', { name: 'Expand resource usage' })).toBeVisible();
	});

	it('moves the overlay and persists its position', async () => {
		vi.spyOn(window, 'fetch').mockRejectedValue(new Error('Unavailable'));
		const { getByTestId } = renderComponent();
		const overlay = getByTestId('resource-usage-overlay');
		const handle = getByTestId('resource-usage-drag-handle');

		await fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 20, clientY: 20 });
		await fireEvent.pointerMove(document, { pointerId: 1, clientX: 120, clientY: 100 });
		await fireEvent.pointerUp(document, { pointerId: 1 });

		expect(overlay).toHaveStyle({ left: '116px', top: '152px' });
		expect(localStorage.getItem('N8N_POBIFY_RESOURCE_OVERLAY')).toContain('"x":116');
	});

	it('moves the overlay with the keyboard', async () => {
		vi.spyOn(window, 'fetch').mockRejectedValue(new Error('Unavailable'));
		const { getByTestId } = renderComponent();
		const overlay = getByTestId('resource-usage-overlay');
		const handle = getByTestId('resource-usage-drag-handle');

		await fireEvent.keyDown(handle, { key: 'ArrowRight' });

		expect(overlay).toHaveStyle({ left: '32px', top: '72px' });
	});

	it('marks retained values as stale after the metrics service fails', async () => {
		vi.useFakeTimers();
		vi.spyOn(window, 'fetch')
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ host: { cpu: { percent: 10 } }, n8n: { cpu: { percent: 5 } } }),
				),
			)
			.mockRejectedValue(new Error('Unavailable'));

		const { getByTestId } = renderComponent();
		await vi.advanceTimersByTimeAsync(1_000);

		expect(getByTestId('resource-usage-stale')).toBeVisible();
	});

	it('distinguishes an unavailable n8n container from zero usage', async () => {
		vi.spyOn(window, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ host: { cpu: { percent: 10 } }, n8n: { available: false } })),
		);

		const { getByTestId } = renderComponent();

		await waitFor(() => expect(getByTestId('resource-usage-n8n-unavailable')).toBeVisible());
	});

	it('clamps a restored position to a smaller viewport', async () => {
		vi.spyOn(window, 'fetch').mockRejectedValue(new Error('Unavailable'));
		vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(320);
		vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(480);
		localStorage.setItem(
			'N8N_POBIFY_RESOURCE_OVERLAY',
			JSON.stringify({ x: 900, y: 900, width: 380, height: 360, collapsed: false }),
		);

		const { getByTestId } = renderComponent();

		await waitFor(() =>
			expect(getByTestId('resource-usage-overlay')).toHaveStyle({ left: '0px', top: '120px' }),
		);
	});
});
